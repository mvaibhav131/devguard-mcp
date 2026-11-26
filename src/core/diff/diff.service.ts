import { jsonBytes, takeWithinBudget } from '../../shared/budget.js';
import { DevGuardError } from '../../shared/errors.js';
import type { Limits } from '../../shared/limits.js';
import { parseNameStatusZ, parseNulSeparatedPaths, parseNumstatZ, parsePatchSections } from './diff-parser.js';
import { detectLanguage, type FileChange } from './diff.types.js';
import type { DiffGitPort, DiffSpec } from './git-port.js';

export type DiffMode = 'workingTree' | 'staged' | 'range';
export type TruncationReason = 'FILE_LIMIT' | 'BYTE_BUDGET' | 'SCAN_LIMIT';
export type HunkCoverage = 'complete' | 'partial' | 'unavailable';

export interface AnalyzeDiffRequest {
  mode: DiffMode;
  base?: string | undefined;
  head?: string | undefined;
  includeUntracked: boolean;
  paths?: readonly string[] | undefined;
  limit: number;
  offset: number;
}

export interface ResolvedRef {
  input: string;
  sha: string;
}

export interface DiffAnalysis {
  schemaVersion: 1;
  selection: {
    mode: DiffMode;
    base?: ResolvedRef;
    head?: ResolvedRef;
    paths?: string[];
    includeUntracked: boolean;
  };
  summary: {
    filesChanged: number;
    additions: number;
    deletions: number;
    binaryFiles: number;
    byStatus: Record<string, number>;
    byLanguage: Record<string, number>;
  };
  hunkCoverage: HunkCoverage;
  files: FileChange[];
  truncation: {
    truncated: boolean;
    reason?: TruncationReason;
    returned: number;
    total: number;
    omitted: number;
    nextOffset?: number;
    hint?: string;
  };
}

export interface DiffServiceDeps {
  git: DiffGitPort;
  /** Validates a user supplied path and returns it as a normalized repository-relative path. */
  confinePath: (input: string) => Promise<{ relativePath: string }>;
  limits: Limits;
}

// Space kept free in the response for the truncation object and its hint.
const TRUNCATION_RESERVE_BYTES = 600;

function invalidInput(message: string): DevGuardError {
  return new DevGuardError('INVALID_INPUT', message);
}

function churn(file: FileChange): number {
  return (file.additions ?? 0) + (file.deletions ?? 0);
}

// Most changed first; the path breaks ties so that paging is stable between calls.
function compareFiles(a: FileChange, b: FileChange): number {
  const byChurn = churn(b) - churn(a);
  if (byChurn !== 0) return byChurn;
  if (a.path < b.path) return -1;
  return a.path > b.path ? 1 : 0;
}

function summarize(files: readonly FileChange[]): DiffAnalysis['summary'] {
  const summary: DiffAnalysis['summary'] = {
    filesChanged: files.length,
    additions: 0,
    deletions: 0,
    binaryFiles: 0,
    byStatus: {},
    byLanguage: {},
  };
  for (const file of files) {
    summary.additions += file.additions ?? 0;
    summary.deletions += file.deletions ?? 0;
    if (file.isBinary) summary.binaryFiles++;
    summary.byStatus[file.status] = (summary.byStatus[file.status] ?? 0) + 1;
    summary.byLanguage[file.language] = (summary.byLanguage[file.language] ?? 0) + 1;
  }
  return summary;
}

export class DiffService {
  constructor(private readonly deps: DiffServiceDeps) {}

  async analyze(request: AnalyzeDiffRequest, signal?: AbortSignal): Promise<DiffAnalysis> {
    const { git, limits } = this.deps;
    this.validateSelection(request);

    const state = await git.repoState(signal);
    if (!state.isRepo) {
      throw new DevGuardError('NOT_A_GIT_REPO', 'The workspace is not a git repository.', {
        hint: 'Start DevGuard with --workspace-root pointing at the top-level folder of a git repository.',
      });
    }
    if (!state.isRepoRoot) {
      throw new DevGuardError(
        'NOT_A_GIT_REPO',
        'The workspace root is inside a git repository but is not its top-level folder.',
        { hint: 'Use the repository root as --workspace-root.' },
      );
    }

    const { spec, base, head } = await this.resolveSpec(request, state.headSha !== null, signal);
    const paths = await this.normalizePaths(request.paths);
    const pathspecs = paths.includes('.') ? [] : paths;

    const [nameStatus, numstat] = await Promise.all([
      git.readDiff({ spec, format: 'name-status', pathspecs, maxBytes: limits.gitOutputCapBytes, signal }),
      git.readDiff({ spec, format: 'numstat', pathspecs, maxBytes: limits.gitOutputCapBytes, signal }),
    ]);

    let entries = parseNameStatusZ(nameStatus.data.toString('utf8'));
    let trackedLimited = nameStatus.truncated || numstat.truncated;
    if (nameStatus.truncated) entries = entries.slice(0, -1);
    if (entries.length > limits.maxFilesScanned) {
      entries = entries.slice(0, limits.maxFilesScanned);
      trackedLimited = true;
    }
    let scanLimited = trackedLimited;

    const stats = parseNumstatZ(numstat.data.toString('utf8'));
    const tracked: FileChange[] = entries.map((entry) => {
      const stat = stats.get(entry.path);
      const file: FileChange = {
        path: entry.path,
        status: entry.status,
        language: detectLanguage(entry.path),
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
        isBinary: stat?.isBinary ?? false,
      };
      if (entry.oldPath !== undefined) file.oldPath = entry.oldPath;
      return file;
    });

    const untracked: FileChange[] = [];
    if (request.includeUntracked) {
      const listing = await git.listUntracked({ pathspecs, maxBytes: limits.gitOutputCapBytes, signal });
      let untrackedPaths = parseNulSeparatedPaths(listing.data.toString('utf8'));
      if (listing.truncated) {
        untrackedPaths = untrackedPaths.slice(0, -1);
        scanLimited = true;
      }
      const room = Math.max(0, limits.maxFilesScanned - tracked.length);
      if (untrackedPaths.length > room) {
        untrackedPaths = untrackedPaths.slice(0, room);
        scanLimited = true;
      }
      for (const path of untrackedPaths) {
        untracked.push({
          path,
          status: 'untracked',
          language: detectLanguage(path),
          additions: null,
          deletions: null,
          isBinary: false,
        });
      }
    }

    const all = [...tracked, ...untracked];
    const sorted = [...all].sort(compareFiles);
    const pageFiles = sorted.slice(request.offset, request.offset + request.limit);

    let hunkCoverage: HunkCoverage = 'unavailable';
    if (tracked.length > 0 && pageFiles.some((file) => file.status !== 'untracked')) {
      hunkCoverage = await this.attachHunks(spec, pathspecs, tracked, trackedLimited, signal);
    }

    const selection: DiffAnalysis['selection'] = { mode: request.mode, includeUntracked: request.includeUntracked };
    if (base) selection.base = base;
    if (head) selection.head = head;
    if (request.paths !== undefined) selection.paths = paths;

    const summary = summarize(all);
    const skeleton = { schemaVersion: 1, selection, summary, hunkCoverage, files: [] as FileChange[] };
    const budget = limits.maxResponseBytes - jsonBytes(skeleton) - TRUNCATION_RESERVE_BYTES;
    const { taken, omitted: cutByBudget } = takeWithinBudget(pageFiles, Math.max(0, budget));

    const total = all.length;
    const returned = taken.length;
    const remaining = Math.max(0, total - request.offset - returned);
    const nextOffset = remaining > 0 ? request.offset + returned : undefined;

    let reason: TruncationReason | undefined;
    if (scanLimited) reason = 'SCAN_LIMIT';
    else if (cutByBudget > 0) reason = 'BYTE_BUDGET';
    else if (remaining > 0) reason = 'FILE_LIMIT';

    const truncation: DiffAnalysis['truncation'] = {
      truncated: reason !== undefined,
      returned,
      total,
      omitted: remaining,
    };
    if (reason !== undefined) truncation.reason = reason;
    if (nextOffset !== undefined) truncation.nextOffset = nextOffset;
    if (reason !== undefined) {
      truncation.hint = this.hint(reason, { returned, total, nextOffset, maxFilesScanned: limits.maxFilesScanned });
    }

    return { schemaVersion: 1, selection, summary, hunkCoverage, files: taken, truncation };
  }

  private validateSelection(request: AnalyzeDiffRequest): void {
    if (request.mode === 'range') {
      if (!request.base) throw invalidInput('"base" is required when mode is "range".');
    } else if (request.base !== undefined || request.head !== undefined) {
      throw invalidInput('"base" and "head" can only be used when mode is "range".');
    }
  }

  private async resolveSpec(
    request: AnalyzeDiffRequest,
    hasHead: boolean,
    signal: AbortSignal | undefined,
  ): Promise<{ spec: DiffSpec; base?: ResolvedRef; head?: ResolvedRef }> {
    if (request.mode === 'staged') return { spec: { kind: 'staged' } };
    if (request.mode === 'workingTree') return { spec: { kind: 'workingTree', hasHead } };

    const baseInput = request.base ?? '';
    const headInput = request.head ?? 'HEAD';
    const baseSha = await this.deps.git.resolveCommit(baseInput, signal);
    const headSha = await this.deps.git.resolveCommit(headInput, signal);
    return {
      spec: { kind: 'range', baseSha, headSha },
      base: { input: baseInput, sha: baseSha },
      head: { input: headInput, sha: headSha },
    };
  }

  private async normalizePaths(paths: readonly string[] | undefined): Promise<string[]> {
    if (paths === undefined) return [];
    const confined = await Promise.all(paths.map(async (input) => (await this.deps.confinePath(input)).relativePath));
    return [...new Set(confined)];
  }

  // Sections of `git diff -U0` come in the same order as the entries of `--name-status`.
  private async attachHunks(
    spec: DiffSpec,
    pathspecs: readonly string[],
    tracked: readonly FileChange[],
    trackedLimited: boolean,
    signal: AbortSignal | undefined,
  ): Promise<HunkCoverage> {
    const { git, limits } = this.deps;
    const patch = await git.readDiff({ spec, format: 'patch', pathspecs, maxBytes: limits.patchOutputCapBytes, signal });

    const sections = parsePatchSections(patch.data.toString('utf8'), limits.maxHunksPerFile);
    // The last section of a cut-off patch may be incomplete.
    const usable = patch.truncated ? sections.slice(0, -1) : sections;
    const exact = !patch.truncated && !trackedLimited;
    if (exact && usable.length !== tracked.length) return 'unavailable';

    const count = Math.min(usable.length, tracked.length);
    for (let index = 0; index < count; index++) {
      const section = usable[index];
      const file = tracked[index];
      if (!section || !file) continue;
      if (section.hunks.length > 0) file.hunks = section.hunks;
      if (section.truncated) file.hunksTruncated = true;
    }

    if (count === 0) return 'unavailable';
    return exact ? 'complete' : 'partial';
  }

  private hint(
    reason: TruncationReason,
    info: { returned: number; total: number; nextOffset: number | undefined; maxFilesScanned: number },
  ): string {
    const next = info.nextOffset === undefined ? '' : ` Call again with offset=${info.nextOffset} for the next page.`;
    switch (reason) {
      case 'SCAN_LIMIT':
        return `The change set is larger than DevGuard scans (limit ${info.maxFilesScanned} files or the git output cap); counts are lower bounds. Narrow the request with "paths".${next}`;
      case 'BYTE_BUDGET':
        return `Response size limit reached after ${info.returned} files.${next} Use a smaller "limit" or narrow with "paths".`;
      case 'FILE_LIMIT':
        return `Returned ${info.returned} of ${info.total} files.${next} You can also narrow with "paths".`;
    }
  }
}
