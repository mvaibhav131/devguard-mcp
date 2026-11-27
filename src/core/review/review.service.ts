import { jsonBytes } from '../../shared/budget.js';
import { mapLimit } from '../../shared/concurrency.js';
import type { Limits } from '../../shared/limits.js';
import { pageWithinBudget, TRUNCATION_RESERVE_BYTES, type Truncation } from '../../shared/pagination.js';
import { NO_PROGRESS, type ProgressReporter } from '../../shared/progress.js';
import type { AddedLine } from '../diff/diff-parser.js';
import type { ChangeSelection, DiffService } from '../diff/diff.service.js';
import type { ChangeSelectionInfo } from '../impact/change-set.js';
import type { SourceFilesPort } from '../impact/source-files.js';
import type { TestDiscoveryService } from '../tests/test-discovery.service.js';
import {
  ALL_RULES,
  applyLineRules,
  contextFor,
  FILE_RULES,
  isGeneratedPath,
  LARGE_ADDED_BLOCK_LINES,
  LINE_RULES,
  SEVERITY_RANK,
  type Category,
  type Finding,
  type RuleInfo,
  type Severity,
} from './rules.js';

export interface ReviewRequest extends ChangeSelection {
  minSeverity: Severity;
  categories?: readonly Category[] | undefined;
  limit: number;
  offset: number;
}

export interface TriggeredRule extends RuleInfo {
  count: number;
}

export interface ReviewResult {
  schemaVersion: 1;
  precision: 'heuristic';
  selection: ChangeSelectionInfo;
  summary: {
    filesReviewed: number;
    addedLinesScanned: number;
    findings: number;
    bySeverity: Record<string, number>;
    byCategory: Record<string, number>;
  };
  coverage: {
    untrackedFilesRead: number;
    skippedFiles: { generated: number; binary: number; unreadable: number; overCap: number };
    patchComplete: boolean;
    patchAligned: boolean;
  };
  rulesRun: string[];
  rules: TriggeredRule[];
  limitations: string[];
  findings: Finding[];
  truncation: Truncation;
}

export interface ReviewServiceDeps {
  diff: Pick<DiffService, 'collectChanges' | 'readAddedLines'>;
  source: Pick<SourceFilesPort, 'readText'>;
  tests: Pick<TestDiscoveryService, 'discover'>;
  limits: Limits;
}

const MAX_FINDINGS_PER_RULE_AND_FILE = 20;
const UNTRACKED_READ_CONCURRENCY = 8;
const REVIEW_STEPS = 3;

const STATIC_LIMITATIONS: readonly string[] = [
  'Heuristic: rules match single added lines with regular expressions. They do not parse the code, so they can miss issues and report false positives, for example inside strings.',
  'Only added lines are reviewed. Existing problems and removed code are not reported.',
  'Secrets are detected by pattern and masked in the evidence. No finding is not proof that no secret was added.',
  'Code rules skip comment lines; the TODO, suppression and secret rules also read comments.',
  'Generated files, lock files and files under node_modules, dist, build and coverage are not reviewed. Test files are recognised by name.',
];

function compareFindings(a: Finding, b: Finding): number {
  return (
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.line ?? Infinity) - (b.line ?? Infinity) ||
    (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
  );
}

function countBy(findings: readonly Finding[], key: 'severity' | 'category'): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) counts[finding[key]] = (counts[finding[key]] ?? 0) + 1;
  return counts;
}

export class ReviewService {
  constructor(private readonly deps: ReviewServiceDeps) {}

  async review(request: ReviewRequest, signal?: AbortSignal, progress: ProgressReporter = NO_PROGRESS): Promise<ReviewResult> {
    const { diff, source, tests, limits } = this.deps;

    progress(0, REVIEW_STEPS, 'Reading the changes');
    const collected = await diff.collectChanges(request, signal);

    const wanted = (category: Category): boolean => request.categories === undefined || request.categories.includes(category);
    const severe = (severity: Severity): boolean => SEVERITY_RANK[severity] <= SEVERITY_RANK[request.minSeverity];
    const lineRules = LINE_RULES.filter((rule) => wanted(rule.category) && severe(rule.severity));
    const fileRules = FILE_RULES.filter((rule) => wanted(rule.category) && severe(rule.severity));
    const fileRuleActive = (id: string): boolean => fileRules.some((rule) => rule.id === id);
    const rulesRun = [...lineRules, ...fileRules].map((rule) => rule.id).sort();

    progress(1, REVIEW_STEPS, 'Reading added lines');
    const skipped = { generated: 0, binary: 0, unreadable: 0, overCap: 0 };
    const reviewable = collected.tracked.filter((file) => {
      if (file.status === 'deleted') return false;
      if (isGeneratedPath(file.path)) skipped.generated++;
      else if (file.isBinary) skipped.binary++;
      else return true;
      return false;
    });

    const linesByFile = new Map<string, AddedLine[]>();
    let patchComplete = true;
    let patchAligned = true;
    const truncatedFiles: string[] = [];

    if (lineRules.length > 0 && reviewable.length > 0) {
      const added = await diff.readAddedLines(collected, signal);
      patchComplete = added.complete;
      patchAligned = added.aligned;
      truncatedFiles.push(...added.truncatedFiles);
      for (const file of reviewable) {
        const lines = added.byPath.get(file.path);
        if (lines) linesByFile.set(file.path, lines);
      }
    }

    let untrackedRead = 0;
    if (lineRules.length > 0 && request.includeUntracked) {
      const untracked = collected.all.filter((file) => file.status === 'untracked');
      const candidates = untracked.filter((file) => {
        if (!isGeneratedPath(file.path)) return true;
        skipped.generated++;
        return false;
      });
      const selected = candidates.slice(0, limits.maxReviewUntrackedFiles);
      skipped.overCap += candidates.length - selected.length;

      await mapLimit(selected, UNTRACKED_READ_CONCURRENCY, signal, async (file) => {
        const outcome = await source.readText(file.path, limits.maxSourceFileBytes);
        if (outcome.status !== 'ok') {
          if (outcome.reason === 'binary') skipped.binary++;
          else skipped.unreadable++;
          return;
        }
        untrackedRead++;
        const lines = outcome.text.split(/\r?\n/);
        if (lines[lines.length - 1] === '') lines.pop();
        if (lines.length > limits.maxReviewLinesPerFile) truncatedFiles.push(file.path);
        linesByFile.set(
          file.path,
          lines.slice(0, limits.maxReviewLinesPerFile).map((text, index) => ({ line: index + 1, text })),
        );
      });
    }

    progress(2, REVIEW_STEPS, 'Applying rules');
    const findings: Finding[] = [];
    let omittedByCap = 0;
    let addedLinesScanned = 0;
    for (const [file, lines] of [...linesByFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      addedLinesScanned += lines.length;
      const context = contextFor(file);
      const applied = applyLineRules(context, lines, lineRules, MAX_FINDINGS_PER_RULE_AND_FILE);
      findings.push(...applied.findings);
      omittedByCap += applied.omitted;

      if (fileRuleActive('large-added-block') && !context.isTest && lines.length >= LARGE_ADDED_BLOCK_LINES) {
        findings.push({ rule: 'large-added-block', category: 'maintainability', severity: 'info', file, evidence: `${lines.length} lines added in this file` });
      }
    }

    let untestedOmitted = 0;
    if (fileRuleActive('missing-tests')) {
      const discovery = await tests.discover(
        { mode: request.mode, base: request.base, head: request.head, includeUntracked: request.includeUntracked, paths: request.paths, depth: 2, limit: 1, offset: 0 },
        signal,
      );
      for (const file of discovery.untested.paths) {
        findings.push({ rule: 'missing-tests', category: 'tests', severity: 'warning', file, evidence: 'No test imports this file or shares its name.' });
      }
      untestedOmitted = discovery.untested.total - discovery.untested.paths.length;
    }

    let scanLimited = collected.scanLimited;
    if (findings.length > limits.maxReviewFindings) {
      findings.length = limits.maxReviewFindings;
      scanLimited = true;
    }
    findings.sort(compareFindings);

    const triggered = new Map<string, number>();
    for (const finding of findings) triggered.set(finding.rule, (triggered.get(finding.rule) ?? 0) + 1);
    const rules: TriggeredRule[] = ALL_RULES.filter((rule) => triggered.has(rule.id))
      .map((rule) => ({ ...rule, count: triggered.get(rule.id) ?? 0 }))
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.id < b.id ? -1 : 1));

    const limitations = [...STATIC_LIMITATIONS];
    if (!patchAligned) limitations.push('The patch could not be matched with the list of changed files, so tracked changes were not reviewed.');
    else if (!patchComplete) limitations.push('The patch was larger than DevGuard reads, so only part of the tracked changes was reviewed.');
    if (truncatedFiles.length > 0) limitations.push(`${truncatedFiles.length} files have more than ${limits.maxReviewLinesPerFile} added lines; only the first ${limits.maxReviewLinesPerFile} were reviewed.`);
    if (skipped.overCap > 0) limitations.push(`${skipped.overCap} untracked files were not read because the limit is ${limits.maxReviewUntrackedFiles}.`);
    if (omittedByCap > 0) limitations.push(`${omittedByCap} further findings were not listed because a rule already reported ${MAX_FINDINGS_PER_RULE_AND_FILE} in the same file.`);
    if (untestedOmitted > 0) limitations.push(`${untestedOmitted} further changed files without a mapped test are not listed; see discover_tests.`);

    const skeleton = {
      schemaVersion: 1,
      precision: 'heuristic',
      selection: { source: 'git', ...collected.selection },
      summary: {
        filesReviewed: linesByFile.size,
        addedLinesScanned,
        findings: findings.length,
        bySeverity: countBy(findings, 'severity'),
        byCategory: countBy(findings, 'category'),
      },
      coverage: { untrackedFilesRead: untrackedRead, skippedFiles: skipped, patchComplete, patchAligned },
      rulesRun,
      rules,
      limitations,
      findings: [] as Finding[],
    } as const;

    const { page, truncation } = pageWithinBudget(findings, {
      offset: request.offset,
      limit: request.limit,
      budgetBytes: limits.maxResponseBytes - jsonBytes(skeleton) - TRUNCATION_RESERVE_BYTES,
      scanLimited,
      noun: 'findings',
      narrowAdvice: 'raise "minSeverity", pick "categories" or review fewer paths',
      scanNote: `The review stopped at its limits (${limits.maxReviewFindings} findings, or the change set is larger than DevGuard scans).`,
    });

    progress(REVIEW_STEPS, REVIEW_STEPS, 'Done');
    return { ...skeleton, summary: { ...skeleton.summary }, findings: page, truncation };
  }
}
