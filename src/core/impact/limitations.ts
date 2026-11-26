import type { GraphStats } from './import-graph.js';

/** Always reported with an impact result, so that a reader never mistakes it for a proof. */
export const IMPACT_LIMITATIONS: readonly string[] = [
  'Heuristic: imports are found by a lightweight scanner, not by the TypeScript compiler.',
  'Only static string specifiers are followed. Computed import() and require() calls are ignored.',
  'Path aliases come from the root tsconfig.json or jsconfig.json (paths, baseUrl, relative extends). Project references, package.json "imports" and "exports" and workspace packages are not resolved.',
  'Barrel files (export * from) make a change look like it affects every importer of the barrel.',
  'Coupling through dependency injection, events, registries, configuration or network contracts is invisible.',
  'Changes to non-source files (package.json, tsconfig, configuration, assets) are not propagated.',
];

export function graphLimitations(stats: GraphStats): string[] {
  const notes: string[] = [];
  if (stats.nonLiteralDynamicImports > 0) {
    notes.push(`${stats.nonLiteralDynamicImports} import() or require() calls with computed arguments were ignored.`);
  }
  if (stats.unresolvedImports > 0) {
    notes.push(`${stats.unresolvedImports} imports could not be resolved and are not part of the graph.`);
  }
  const skipped = stats.skipped.binary + stats.skipped['too-large'] + stats.skipped.symlink + stats.skipped.unreadable + stats.skipped.outside;
  if (skipped > 0) notes.push(`${skipped} source files were skipped because they are too large, binary, links or unreadable.`);
  notes.push(...stats.limitedReasons);
  return notes;
}
