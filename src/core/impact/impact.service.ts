import { jsonBytes } from '../../shared/budget.js';
import type { Limits } from '../../shared/limits.js';
import { pageWithinBudget, TRUNCATION_RESERVE_BYTES, type Truncation } from '../../shared/pagination.js';
import { NO_PROGRESS, type ProgressReporter } from '../../shared/progress.js';
import { isTestFile } from '../tests/test-files.js';
import { ANALYSIS_STEPS, prepareAnalysis } from './analysis-input.js';
import { describeChanges, type ChangeSelectionInfo, type ChangeSet, type ChangeSetRequest, type ChangeSetResolver } from './change-set.js';
import { walkImporters, type ImportGraph, type ImportGraphBuilder, type UnresolvedImport } from './import-graph.js';
import { graphLimitations, IMPACT_LIMITATIONS } from './limitations.js';
import { isSourceFile } from './module-resolver.js';

export interface ImpactRequest extends ChangeSetRequest {
  depth: number;
  includeTests: boolean;
  limit: number;
  offset: number;
}

export type ImpactOptions = Pick<ImpactRequest, 'depth' | 'includeTests' | 'limit' | 'offset'>;

export interface ImpactedFile {
  path: string;
  relation: 'direct' | 'transitive';
  depth: number;
  /** Import chain from the changed file up to the file this one imports. */
  via: string[];
  isTest: boolean;
}

export interface ImpactAnalysis {
  schemaVersion: 1;
  precision: 'heuristic';
  selection: ChangeSelectionInfo;
  changed: { total: number; sourceFiles: number; otherFiles: number };
  depth: number;
  summary: { impacted: number; direct: number; transitive: number; tests: number };
  hotspots: { path: string; directImporters: number }[];
  unresolved: { total: number; items: UnresolvedImport[] };
  graph: {
    sourceFilesRead: number;
    edges: number;
    externalImports: number;
    unresolvedImports: number;
    nonLiteralDynamicImports: number;
    limited: boolean;
  };
  limitations: string[];
  impacted: ImpactedFile[];
  truncation: Truncation;
}

export interface ImpactServiceDeps {
  changes: ChangeSetResolver;
  graphBuilder: ImportGraphBuilder;
  limits: Limits;
}

const MAX_HOTSPOTS = 5;
const MAX_UNRESOLVED_ITEMS = 20;

export class ImpactService {
  constructor(private readonly deps: ImpactServiceDeps) {}

  async analyze(request: ImpactRequest, signal?: AbortSignal, progress: ProgressReporter = NO_PROGRESS): Promise<ImpactAnalysis> {
    const { changeSet, graph } = await prepareAnalysis(this.deps.changes, this.deps.graphBuilder, request, signal, progress);
    const result = this.analyzeChangeSet(changeSet, graph, request);
    progress(ANALYSIS_STEPS, ANALYSIS_STEPS, 'Done');
    return result;
  }

  /** The analysis itself, for callers that already resolved the change set and built the graph. */
  analyzeChangeSet(changeSet: ChangeSet, graph: ImportGraph, request: ImpactOptions): ImpactAnalysis {
    const { limits } = this.deps;
    const { changedPaths, seeds } = describeChanges(changeSet.files);

    const hits = walkImporters(graph, seeds, request.depth, changedPaths);
    let impacted: ImpactedFile[] = [...hits].map(([path, hit]) => ({
      path,
      relation: hit.depth === 1 ? 'direct' : 'transitive',
      depth: hit.depth,
      via: hit.via,
      isTest: isTestFile(path),
    }));
    impacted.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (!request.includeTests) impacted = impacted.filter((file) => !file.isTest);

    const hotspots = seeds
      .map((path) => ({ path, directImporters: (graph.importers.get(path) ?? []).filter((importer) => !changedPaths.has(importer)).length }))
      .filter((hotspot) => hotspot.directImporters > 0)
      .sort((a, b) => b.directImporters - a.directImporters || (a.path < b.path ? -1 : 1))
      .slice(0, MAX_HOTSPOTS);

    const unresolved = graph.unresolved.filter((entry) => changedPaths.has(entry.importer));
    const sourceChanged = changeSet.files.filter((file) => isSourceFile(file.path)).length;

    const limitations = [...IMPACT_LIMITATIONS, ...graphLimitations(graph.stats)];
    if (seeds.length === 0 && changeSet.files.length > 0) {
      limitations.push('None of the changed files is a TypeScript or JavaScript source file, so no import analysis was possible.');
    }

    const direct = impacted.filter((file) => file.relation === 'direct').length;
    const skeleton = {
      schemaVersion: 1,
      precision: 'heuristic',
      selection: changeSet.selection,
      changed: { total: changeSet.files.length, sourceFiles: sourceChanged, otherFiles: changeSet.files.length - sourceChanged },
      depth: request.depth,
      summary: { impacted: impacted.length, direct, transitive: impacted.length - direct, tests: impacted.filter((file) => file.isTest).length },
      hotspots,
      unresolved: { total: unresolved.length, items: unresolved.slice(0, MAX_UNRESOLVED_ITEMS) },
      graph: {
        sourceFilesRead: graph.stats.sourceFilesRead,
        edges: graph.stats.edges,
        externalImports: graph.stats.externalImports,
        unresolvedImports: graph.stats.unresolvedImports,
        nonLiteralDynamicImports: graph.stats.nonLiteralDynamicImports,
        limited: graph.stats.limited,
      },
      limitations,
      impacted: [] as ImpactedFile[],
    } as const;

    const { page, truncation } = pageWithinBudget(impacted, {
      offset: request.offset,
      limit: request.limit,
      budgetBytes: limits.maxResponseBytes - jsonBytes(skeleton) - TRUNCATION_RESERVE_BYTES,
      scanLimited: changeSet.scanLimited || graph.stats.limited,
      noun: 'impacted files',
      narrowAdvice: 'reduce "depth" or analyse fewer changed files',
      scanNote: 'The change set or the source tree is larger than DevGuard analyses (see "graph" and "limitations").',
    });

    return { ...skeleton, summary: { ...skeleton.summary }, impacted: page, truncation };
  }
}
