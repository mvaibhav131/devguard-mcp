import { jsonBytes } from '../../shared/budget.js';
import { DevGuardError } from '../../shared/errors.js';
import type { Limits } from '../../shared/limits.js';
import { pageWithinBudget, TRUNCATION_RESERVE_BYTES, type Truncation } from '../../shared/pagination.js';
import { parseAddedLines, parseNameStatusZ, parseNulSeparatedPaths, parseNumstatZ, parsePatchSections, type AddedLine } from './diff-parser.js';
import { detectLanguage, type FileChange } from './diff.types.js';
import type { DiffGitPort, DiffSpec } from './git-port.js';

export type DiffMode = 'workingTree' | 'staged' | 'range';
export type HunkCoverage = 'complete' | 'partial' | 'unavailable';

export interface ChangeSelection {
  mode: DiffMode;
  base?: string | undefined;
  head?: string | undefined;
  includeUntracked: boolean;
  paths?: readonly string[] | undefined;
}

export interface AnalyzeDiffRequest extends ChangeSelection {
  limit: number;
  offset: number;
}

export interface ResolvedRef {
  input: string;
  sha: string;
}

export interface DiffSelectionInfo {
  mode: DiffMode;
  base?: ResolvedRef;
  head?: ResolvedRef;
  paths?: string[];
  includeUntracked: boolean;
}

export interface DiffAnalysis {
  schemaVersion: 1;
  selection: DiffSelectionInfo;
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
  truncation: Truncation;
}

/** Every changed file of a selection, before ordering and paging. */
export interface CollectedChanges {
  spec: DiffSpec;
  selection: DiffSelectionInfo;
  pathspecs: string[];
  tracked: FileChange[];
  all: FileChange[];
  /** Tracked changes were cut off by the git output cap or the file scan limit. */
  trackedLimited: boolean;
  /** Anything was cut off, including untracked files. */
  scanLimited: boolean;
}

export interface DiffServiceDeps {
  git: DiffGitPort;
  /** Validates a user supplied path and returns it as a normalized repository-relative path. */
  confinePath: (input: string) => Promise<{ relativePath: string }>;
  limits: Limits;
}

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
    const { limits } = this.deps;
    const collected = await this.collectChanges(request, signal);

    const sorted = [...collected.all].sort(compareFiles);
    const pageCandidates = sorted.slice(request.offset, request.offset + request.limit);

    let hunkCoverage: HunkCoverage = 'unavailable';
    if (collected.tracked.length > 0 && pageCandidates.some((file) => file.status !== 'untracked')) {
      hunkCoverage = await this.attachHunks(collected, signal);
    }

    const summary = summarize(collected.all);
    const skeleton = { schemaVersion: 1, selection: collected.selection, summary, hunkCoverage, files: [] as FileChange[] };
    const { page, truncation } = pageWithinBudget(sorted, {
      offset: request.offset,
      limit: request.limit,
      budgetBytes: limits.maxResponseBytes - jsonBytes(skeleton) - TRUNCATION_RESERVE_BYTES,
      scanLimited: collected.scanLimited,
      noun: 'files',
      narrowAdvice: 'narrow the request with "paths"',
      scanNote: `The change set is larger than DevGuard scans (limit ${limits.maxFilesScanned} files or the git output cap).`,
    });

    return { schemaVersion: 1, selection: collected.selection, summary, hunkCoverage, files: page, truncation };
  }

  /** Reads every changed file of the selection from git. Shared by the diff, impact and test tools. */
  async collectChanges(request: ChangeSelection, signal?: AbortSignal): Promise<CollectedChanges> {
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

    const selection: DiffSelectionInfo = { mode: request.mode, includeUntracked: request.includeUntracked };
    if (base) selection.base = base;
    if (head) selection.head = head;
    if (request.paths !== undefined) selection.paths = paths;

    return { spec, selection, pathspecs, tracked, all: [...tracked, ...untracked], trackedLimited, scanLimited };
  }

  /**
   * The added lines of the tracked changes, by path, from the same patch that provides hunks.
   * `aligned` is false when the patch cannot be matched with the file list, in which case nothing is returned.
   */
  async readAddedLines(
    collected: CollectedChanges,
    signal?: AbortSignal,
  ): Promise<{ byPath: Map<string, AddedLine[]>; complete: boolean; aligned: boolean; truncatedFiles: string[] }> {
    const { git, limits } = this.deps;
    const { spec, pathspecs, tracked, trackedLimited } = collected;
    const byPath = new Map<string, AddedLine[]>();
    const truncatedFiles: string[] = [];
    if (tracked.length === 0) return { byPath, complete: true, aligned: true, truncatedFiles };

    const patch = await git.readDiff({ spec, format: 'patch', pathspecs, maxBytes: limits.patchOutputCapBytes, signal });
    const sections = parseAddedLines(patch.data.toString('utf8'), limits.maxReviewLinesPerFile);
    // The last section of a cut-off patch may be incomplete.
    const usable = patch.truncated ? sections.slice(0, -1) : sections;

    const exact = !patch.truncated && !trackedLimited;
    if (exact && usable.length !== tracked.length) return { byPath, complete: false, aligned: false, truncatedFiles };

    for (let index = 0; index < Math.min(usable.length, tracked.length); index++) {
      const section = usable[index];
      const file = tracked[index];
      if (!section || !file) continue;
      if (section.added.length > 0) byPath.set(file.path, section.added);
      if (section.truncated) truncatedFiles.push(file.path);
    }
    return { byPath, complete: exact, aligned: true, truncatedFiles };
  }

  private validateSelection(request: ChangeSelection): void {
    if (request.mode === 'range') {
      if (!request.base) throw invalidInput('"base" is required when mode is "range".');
    } else if (request.base !== undefined || request.head !== undefined) {
      throw invalidInput('"base" and "head" can only be used when mode is "range".');
    }
  }

  private async resolveSpec(
    request: ChangeSelection,
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
  private async attachHunks(collected: CollectedChanges, signal: AbortSignal | undefined): Promise<HunkCoverage> {
    const { git, limits } = this.deps;
    const { spec, pathspecs, tracked, trackedLimited } = collected;
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
}
