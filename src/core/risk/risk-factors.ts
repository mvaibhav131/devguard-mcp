import type { ChangedFile } from '../impact/change-set.js';
import type { ImpactAnalysis } from '../impact/impact.service.js';
import { isSourceFile } from '../impact/module-resolver.js';
import type { TestDiscovery } from '../tests/test-discovery.service.js';
import {
  criticalCategory,
  RISK_WEIGHTS,
  scale,
  SCALES,
  TEST_GAP_MITIGATION,
  type FactorId,
} from './risk-model.js';

export type Confidence = 'high' | 'medium' | 'low';

export interface RiskFactor {
  id: FactorId;
  name: string;
  weight: number;
  status: 'computed' | 'unavailable';
  /** The measured values behind the score. */
  metrics: Record<string, number>;
  normalized: number | null;
  /** weight x normalized x 100, the share of the overall score. */
  contribution: number | null;
  confidence: Confidence;
  evidence: string[];
  limitations: string[];
}

export interface RiskInputs {
  files: readonly ChangedFile[];
  /** False for explicit file lists, where git provides no line counts or change kinds. */
  fromGit: boolean;
  impact: Pick<ImpactAnalysis, 'summary' | 'hotspots' | 'unresolved' | 'graph' | 'depth' | 'changed'>;
  tests: Pick<TestDiscovery, 'summary' | 'untested' | 'changed' | 'frameworks'>;
}

export const MAX_EVIDENCE = 5;

const round1 = (value: number): number => Math.round(value * 10) / 10;

function computed(
  id: FactorId,
  name: string,
  normalized: number,
  confidence: Confidence,
  metrics: Record<string, number>,
  evidence: string[],
  limitations: string[],
): RiskFactor {
  const weight = RISK_WEIGHTS[id];
  return {
    id,
    name,
    weight,
    status: 'computed',
    metrics,
    normalized,
    contribution: round1(weight * normalized * 100),
    confidence,
    evidence: evidence.slice(0, MAX_EVIDENCE),
    limitations,
  };
}

function unavailable(id: FactorId, name: string, reason: string): RiskFactor {
  return {
    id,
    name,
    weight: RISK_WEIGHTS[id],
    status: 'unavailable',
    metrics: {},
    normalized: null,
    contribution: null,
    confidence: 'low',
    evidence: [reason],
    limitations: ['An unavailable factor counts as 0, so the overall score can understate the risk.'],
  };
}

const topFolder = (filePath: string): string => (filePath.includes('/') ? filePath.slice(0, filePath.indexOf('/')) : '.');

function changeSize(inputs: RiskInputs): RiskFactor {
  const name = 'Change size';
  if (!inputs.fromGit) return unavailable('change_size', name, 'Line counts are not available for an explicit file list. Use a git selection for this factor.');

  let additions = 0;
  let deletions = 0;
  let untracked = 0;
  let binary = 0;
  for (const file of inputs.files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
    if (file.status === 'untracked') untracked++;
    if (file.isBinary) binary++;
  }
  const churn = additions + deletions;

  const largest = inputs.files
    .filter((file) => (file.additions ?? 0) + (file.deletions ?? 0) > 0)
    .sort((a, b) => (b.additions ?? 0) + (b.deletions ?? 0) - ((a.additions ?? 0) + (a.deletions ?? 0)) || (a.path < b.path ? -1 : 1))
    .slice(0, 3);

  const limitations: string[] = [];
  if (untracked > 0) limitations.push(`${untracked} untracked files have no line counts and are not part of the total.`);
  if (binary > 0) limitations.push(`${binary} binary files have no line counts.`);

  const { low, high } = SCALES.linesChanged;
  return computed(
    'change_size',
    name,
    scale(churn, low, high),
    'high',
    { additions, deletions, linesChanged: churn, files: inputs.files.length },
    [
      `${churn} lines changed (+${additions} -${deletions}) in ${inputs.files.length} files`,
      `Scale: ${low} lines or fewer = 0, ${high} lines or more = 1`,
      ...largest.map((file) => `Largest: ${file.path} (+${file.additions ?? 0} -${file.deletions ?? 0})`),
    ],
    limitations,
  );
}

function changeSpread(inputs: RiskInputs): RiskFactor {
  const files = inputs.files.length;
  const folders = [...new Set(inputs.files.map((file) => topFolder(file.path)))].sort();
  const normalized = Math.max(scale(files, SCALES.changedFiles.low, SCALES.changedFiles.high), scale(folders.length, SCALES.topLevelFolders.low, SCALES.topLevelFolders.high));

  return computed(
    'change_spread',
    'Change spread',
    normalized,
    'high',
    { changedFiles: files, topLevelFolders: folders.length },
    [
      `${files} changed files in ${folders.length} top-level folders${folders.length > 0 ? `: ${folders.slice(0, MAX_EVIDENCE).join(', ')}` : ''}`,
      `Scale: ${SCALES.changedFiles.low} files or fewer = 0, ${SCALES.changedFiles.high} or more = 1; the folder count is scaled ${SCALES.topLevelFolders.low} to ${SCALES.topLevelFolders.high}. The higher of the two counts.`,
    ],
    [],
  );
}

function blastRadius(inputs: RiskInputs): RiskFactor {
  const { impact } = inputs;
  const { impacted, direct, transitive } = impact.summary;
  const maxDirect = Math.max(0, ...impact.hotspots.map((hotspot) => hotspot.directImporters));

  const limitations = ['Based on the heuristic import graph; computed imports, dependency injection, events and barrel re-exports are not modelled.'];
  if (impact.unresolved.total > 0) limitations.push(`${impact.unresolved.total} imports in the changed files could not be resolved.`);
  if (impact.graph.limited) limitations.push('The source tree is larger than DevGuard analyses, so the radius may be understated.');

  if (impact.changed.sourceFiles === 0) {
    return computed('blast_radius', 'Blast radius', 0, 'medium', { impactedFiles: 0, maxDirectImporters: 0 }, ['No TypeScript or JavaScript source file changed.'], limitations);
  }

  const evidence =
    impacted === 0
      ? [`No other source file imports the changed files (within ${impact.depth} levels).`]
      : [
          `${impacted} other files import the changed files within ${impact.depth} levels (${direct} directly, ${transitive} indirectly)`,
          ...impact.hotspots.slice(0, 3).map((hotspot) => `${hotspot.path} is imported directly by ${hotspot.directImporters} files`),
        ];

  return computed(
    'blast_radius',
    'Blast radius',
    Math.max(scale(impacted, SCALES.impactedFiles.low, SCALES.impactedFiles.high), scale(maxDirect, SCALES.directImporters.low, SCALES.directImporters.high)),
    impact.graph.limited ? 'low' : 'medium',
    { impactedFiles: impacted, directImpacted: direct, maxDirectImporters: maxDirect },
    evidence,
    limitations,
  );
}

function testCoverageGap(inputs: RiskInputs): RiskFactor {
  const { summary, untested, changed, frameworks } = inputs.tests;
  const limitations = [
    'A mapped test may not exercise the change, and "no mapped test" is not proof that code is untested. DevGuard does not run tests or measure coverage.',
  ];

  if (summary.changedSourceFiles === 0) {
    return computed('test_coverage_gap', 'Test coverage gap', 0, 'medium', { changedSourceFiles: 0, withoutTests: 0, testFilesChanged: changed.testFiles }, ['No changed source file needs a test link.'], limitations);
  }

  const gap = summary.withoutTests / summary.changedSourceFiles;
  const mitigated = changed.testFiles > 0;
  const evidence = [
    `${summary.withoutTests} of ${summary.changedSourceFiles} changed source files have no mapped test`,
    ...untested.paths.slice(0, 3).map((file) => `No mapped test: ${file}`),
  ];
  if (mitigated) evidence.push(`${changed.testFiles} test files changed in the same change set, so the gap counts ${TEST_GAP_MITIGATION * 100}%`);
  if (frameworks.length === 0) evidence.push('No test framework was detected in the workspace.');

  return computed(
    'test_coverage_gap',
    'Test coverage gap',
    Math.round(gap * (mitigated ? TEST_GAP_MITIGATION : 1) * 1000) / 1000,
    'medium',
    { changedSourceFiles: summary.changedSourceFiles, withoutTests: summary.withoutTests, testFilesChanged: changed.testFiles },
    evidence,
    limitations,
  );
}

function criticalPaths(inputs: RiskInputs): RiskFactor {
  const matches = inputs.files
    .map((file) => ({ path: file.path, category: criticalCategory(file.path) }))
    .filter((match): match is { path: string; category: NonNullable<typeof match.category> } => match.category !== undefined);

  return computed(
    'critical_paths',
    'Critical paths',
    scale(matches.length, SCALES.criticalFiles.low, SCALES.criticalFiles.high),
    'low',
    { matchedFiles: matches.length },
    matches.length === 0
      ? ['No changed file matches a sensitive area (dependencies, CI/CD, environment, build configuration, security, database, payments).']
      : matches.map((match) => `${match.path} (${match.category})`),
    ['Matched by file and folder names only; a sensitive file with an ordinary name is not detected.'],
  );
}

function changeKinds(inputs: RiskInputs): RiskFactor {
  const name = 'Change kinds';
  if (!inputs.fromGit) return unavailable('change_kinds', name, 'Change kinds (deleted, renamed, conflicted) are not available for an explicit file list. Use a git selection for this factor.');

  const count = (predicate: (file: ChangedFile) => boolean): number => inputs.files.filter(predicate).length;
  const deleted = count((file) => file.status === 'deleted' && isSourceFile(file.path));
  const renamed = count((file) => file.status === 'renamed' && isSourceFile(file.path));
  const typeChanged = count((file) => file.status === 'typeChanged');
  const unmerged = count((file) => file.status === 'unmerged');
  const points = deleted + renamed * 0.5 + typeChanged + unmerged * 3;

  const evidence: string[] = [];
  if (deleted > 0) evidence.push(`${deleted} deleted source files (importers may break)`);
  if (renamed > 0) evidence.push(`${renamed} renamed source files (importers must be updated)`);
  if (typeChanged > 0) evidence.push(`${typeChanged} files changed type (for example a symlink became a file)`);
  if (unmerged > 0) evidence.push(`${unmerged} unmerged files (unresolved merge conflicts)`);
  if (evidence.length === 0) evidence.push('No deleted, renamed or conflicted source files.');
  evidence.push('Points: deleted 1, renamed 0.5, type change 1, unmerged 3 each. Scale: 0 points = 0, 5 or more = 1');

  return computed('change_kinds', name, scale(points, SCALES.changeKindPoints.low, SCALES.changeKindPoints.high), 'high', { deleted, renamed, typeChanged, unmerged, points }, evidence, []);
}

export function computeFactors(inputs: RiskInputs): RiskFactor[] {
  return [changeSize(inputs), changeSpread(inputs), blastRadius(inputs), testCoverageGap(inputs), criticalPaths(inputs), changeKinds(inputs)];
}
