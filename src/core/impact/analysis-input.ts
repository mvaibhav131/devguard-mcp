import type { ProgressReporter } from '../../shared/progress.js';
import { describeChanges, type ChangeSet, type ChangeSetRequest, type ChangeSetResolver } from './change-set.js';
import type { ImportGraph, ImportGraphBuilder } from './import-graph.js';

/** Number of progress steps that analyses report: read changes, read sources, analyse. */
export const ANALYSIS_STEPS = 3;

/**
 * Resolves the changed files and builds the import graph, the slow part of every analysis,
 * and reports progress while doing so. Progress only ever increases.
 */
export async function prepareAnalysis(
  changes: ChangeSetResolver,
  graphBuilder: ImportGraphBuilder,
  request: ChangeSetRequest,
  signal: AbortSignal | undefined,
  progress: ProgressReporter,
): Promise<{ changeSet: ChangeSet; graph: ImportGraph }> {
  progress(0, ANALYSIS_STEPS, 'Reading the changed files');
  const changeSet = await changes.resolve(request, signal);

  progress(1, ANALYSIS_STEPS, 'Reading source files');
  const graph = await graphBuilder.build({
    extraKnown: describeChanges(changeSet.files).extraKnown,
    signal,
    onProgress: (done, total) => progress(1 + (done / Math.max(total, 1)) * 0.99, ANALYSIS_STEPS, `Reading source files (${done}/${total})`),
  });

  progress(2, ANALYSIS_STEPS, 'Analysing imports');
  return { changeSet, graph };
}
