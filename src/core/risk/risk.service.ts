import { jsonBytes } from '../../shared/budget.js';
import type { Limits } from '../../shared/limits.js';
import { NO_PROGRESS, type ProgressReporter } from '../../shared/progress.js';
import { ANALYSIS_STEPS, prepareAnalysis } from '../impact/analysis-input.js';
import { type ChangeSelectionInfo, type ChangeSetRequest, type ChangeSetResolver } from '../impact/change-set.js';
import type { ImpactService } from '../impact/impact.service.js';
import type { ImportGraphBuilder } from '../impact/import-graph.js';
import { graphLimitations } from '../impact/limitations.js';
import type { TestDiscovery, TestDiscoveryService } from '../tests/test-discovery.service.js';
import { computeFactors, type Confidence, type RiskFactor, type RiskInputs } from './risk-factors.js';
import { bandFor, criticalCategory, RISK_BANDS, SCORE_VERSION, type RiskBand } from './risk-model.js';

export interface RiskRequest extends ChangeSetRequest {
  depth: number;
}

export interface RiskAssessment {
  schemaVersion: 1;
  scoreVersion: number;
  precision: 'heuristic';
  selection: ChangeSelectionInfo;
  /** Sum of the factor contributions, 0 to 100. Unavailable factors count as 0. */
  overallScore: number;
  band: RiskBand;
  bands: { band: RiskBand; min: number; max: number }[];
  /** Share of the total weight that could be computed, 0 to 1. Confidence is "low" below 0.8. */
  coverage: number;
  confidence: Confidence;
  factors: RiskFactor[];
  recommendations: string[];
  suggestedCommands: TestDiscovery['suggestedCommands'];
  limitations: string[];
  changed: { total: number; sourceFiles: number; testFiles: number; otherFiles: number };
}

export interface RiskServiceDeps {
  changes: ChangeSetResolver;
  graphBuilder: ImportGraphBuilder;
  impact: Pick<ImpactService, 'analyzeChangeSet'>;
  tests: Pick<TestDiscoveryService, 'discoverChangeSet'>;
  limits: Limits;
}

const MAX_RECOMMENDATIONS = 6;

function recommend(inputs: RiskInputs, tests: TestDiscovery, factors: readonly RiskFactor[], coverage: number): string[] {
  const items: string[] = [];

  const unmerged = inputs.files.filter((file) => file.status === 'unmerged').map((file) => file.path);
  if (unmerged.length > 0) items.push(`Resolve the merge conflicts in ${unmerged.slice(0, 3).join(', ')} before relying on this assessment.`);

  if (tests.untested.total > 0) items.push(`Add or extend tests for: ${tests.untested.paths.slice(0, 5).join(', ')}.`);

  const command = tests.suggestedCommands[0];
  if (command) items.push(`Run the affected tests: ${command.command}`);

  const hotspot = inputs.impact.hotspots[0];
  if (hotspot && hotspot.directImporters >= 3) items.push(`Review the importers of ${hotspot.path} (${hotspot.directImporters} files import it directly).`);

  const critical = inputs.files.map((file) => ({ path: file.path, category: criticalCategory(file.path) })).filter((match) => match.category !== undefined);
  if (critical.length > 0) items.push(`Review ${critical.slice(0, 3).map((match) => `${match.path} (${match.category})`).join(', ')} with extra care.`);

  const deleted = inputs.files.filter((file) => file.status === 'deleted').map((file) => file.path);
  if (deleted.length > 0) items.push(`Check that nothing still imports the deleted files: ${deleted.slice(0, 3).join(', ')}.`);

  if (coverage < 1) {
    const missing = factors.filter((factor) => factor.status === 'unavailable').map((factor) => factor.name.toLowerCase());
    items.push(`Some factors could not be computed (${missing.join(', ')}). Use a git selection instead of an explicit file list for a fuller assessment.`);
  }
  return items.slice(0, MAX_RECOMMENDATIONS);
}

export class RiskService {
  constructor(private readonly deps: RiskServiceDeps) {}

  async assess(request: RiskRequest, signal?: AbortSignal, progress: ProgressReporter = NO_PROGRESS): Promise<RiskAssessment> {
    const { impact, tests, limits } = this.deps;

    const { changeSet, graph } = await prepareAnalysis(this.deps.changes, this.deps.graphBuilder, request, signal, progress);

    // One change set and one graph feed both analyses. Only their summaries are used, so a page of one item is enough.
    const impactResult = impact.analyzeChangeSet(changeSet, graph, { depth: request.depth, includeTests: false, limit: 1, offset: 0 });
    const testResult = await tests.discoverChangeSet(changeSet, graph, { depth: request.depth, limit: 1, offset: 0 });

    const inputs: RiskInputs = {
      files: changeSet.files,
      fromGit: changeSet.selection.source === 'git',
      impact: impactResult,
      tests: testResult,
    };
    const factors = computeFactors(inputs);

    const overallScore = Math.min(100, Math.round(factors.reduce((sum, factor) => sum + (factor.contribution ?? 0), 0)));
    const coverage = Math.round(factors.filter((factor) => factor.status === 'computed').reduce((sum, factor) => sum + factor.weight, 0) * 100) / 100;

    const limitations = [
      'Heuristic: the score comes from fixed, documented weights and supports a review. It does not predict defects.',
      'Factors with confidence "medium" or "low" rely on the heuristic import graph or on file names; see analyze_change_impact and discover_tests for their limitations.',
      'An unavailable factor counts as 0, so the score can understate the risk; see "coverage".',
      ...graphLimitations(graph.stats),
    ];
    if (changeSet.scanLimited) limitations.push('The change set was cut off at the scan limit, so every factor is a lower bound.');

    const assessment: RiskAssessment = {
      schemaVersion: 1,
      scoreVersion: SCORE_VERSION,
      precision: 'heuristic',
      selection: changeSet.selection,
      overallScore,
      band: bandFor(overallScore),
      bands: RISK_BANDS.map((entry) => ({ ...entry })),
      coverage,
      confidence: coverage < 0.8 || graph.stats.limited || changeSet.scanLimited ? 'low' : 'medium',
      factors,
      recommendations: recommend(inputs, testResult, factors, coverage),
      suggestedCommands: testResult.suggestedCommands,
      limitations,
      changed: testResult.changed,
    };

    progress(ANALYSIS_STEPS, ANALYSIS_STEPS, 'Done');
    return this.fitToBudget(assessment, limits.maxResponseBytes);
  }

  // Evidence lists are capped already; this is a last resort for unusually long paths.
  private fitToBudget(assessment: RiskAssessment, maxBytes: number): RiskAssessment {
    if (jsonBytes(assessment) <= maxBytes) return assessment;
    return {
      ...assessment,
      factors: assessment.factors.map((factor) => ({ ...factor, evidence: factor.evidence.slice(0, 2) })),
      recommendations: assessment.recommendations.slice(0, 3),
      suggestedCommands: assessment.suggestedCommands.slice(0, 1),
    };
  }
}
