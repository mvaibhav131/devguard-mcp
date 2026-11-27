import { mapLimit } from '../../shared/concurrency.js';
import type { Limits } from '../../shared/limits.js';
import { extractImports, type ExtractResult, type ImportKind } from './import-extractor.js';
import { isSourceFile, resolveSpecifier, type UnresolvedReason } from './module-resolver.js';
import type { SkipReason, SourceFilesPort } from './source-files.js';
import { loadAliasConfig, type AliasConfig } from './tsconfig-paths.js';

export interface ImportEdge {
  to: string;
  typeOnly: boolean;
  kind: ImportKind;
}

export interface UnresolvedImport {
  importer: string;
  specifier: string;
  reason: UnresolvedReason;
}

export interface GraphStats {
  sourceFilesListed: number;
  sourceFilesRead: number;
  edges: number;
  externalImports: number;
  assetImports: number;
  unresolvedImports: number;
  nonLiteralDynamicImports: number;
  skipped: Record<SkipReason, number>;
  limited: boolean;
  limitedReasons: string[];
}

export interface ImportGraph {
  /** Every path git listed, source or not. Used to detect configuration files. */
  allPaths: ReadonlySet<string>;
  /** Source files that were read and analysed. */
  files: ReadonlySet<string>;
  imports: ReadonlyMap<string, readonly ImportEdge[]>;
  /** For every file, the files that import it, sorted. */
  importers: ReadonlyMap<string, readonly string[]>;
  /** Package specifiers per file, for example "vitest". */
  externals: ReadonlyMap<string, readonly string[]>;
  unresolved: readonly UnresolvedImport[];
  aliases: AliasConfig;
  stats: GraphStats;
}

export type GraphLimits = Pick<Limits, 'maxSourceFiles' | 'maxSourceFileBytes' | 'readConcurrency'>;

export interface BuildOptions {
  /** Changed paths that no longer exist, so that their importers can still be linked. */
  extraKnown: ReadonlySet<string>;
  signal?: AbortSignal | undefined;
  /** Called after every source file that was read, with the number done and the total. */
  onProgress?: ((done: number, total: number) => void) | undefined;
}

const CONFIG_FILE_BYTES = 256 * 1024;

/** Builds the import graph of the workspace from scratch on every call; the server keeps no state between calls. */
export class ImportGraphBuilder {
  constructor(private readonly deps: { source: SourceFilesPort; limits: GraphLimits }) {}

  async build(options: BuildOptions): Promise<ImportGraph> {
    const { source, limits } = this.deps;
    const { signal } = options;

    const listing = await source.listFiles({ includeUntracked: true, signal });
    const allPaths = new Set(listing.paths);

    const limitedReasons: string[] = [];
    if (listing.truncated) limitedReasons.push('The file listing exceeded the git output cap.');

    let sourcePaths = listing.paths.filter(isSourceFile).sort();
    const sourceFilesListed = sourcePaths.length;
    if (sourcePaths.length > limits.maxSourceFiles) {
      sourcePaths = sourcePaths.slice(0, limits.maxSourceFiles);
      limitedReasons.push(`More than ${limits.maxSourceFiles} source files; only the first ${limits.maxSourceFiles} (alphabetical) were analysed.`);
    }

    const aliases = await loadAliasConfig(async (file) => {
      const outcome = await source.readText(file, CONFIG_FILE_BYTES);
      return outcome.status === 'ok' ? outcome.text : undefined;
    });

    const skipped: Record<SkipReason, number> = { missing: 0, outside: 0, symlink: 0, 'too-large': 0, binary: 0, unreadable: 0 };
    const extracted = new Map<string, ExtractResult>();
    let done = 0;
    await mapLimit(sourcePaths, limits.readConcurrency, signal, async (file) => {
      const outcome = await source.readText(file, limits.maxSourceFileBytes);
      if (outcome.status === 'ok') extracted.set(file, extractImports(outcome.text));
      else skipped[outcome.reason]++;
      options.onProgress?.(++done, sourcePaths.length);
    });

    const files = new Set(extracted.keys());
    const context = { files, extraKnown: options.extraKnown, aliases };

    const imports = new Map<string, ImportEdge[]>();
    const importerSets = new Map<string, Set<string>>();
    const externals = new Map<string, string[]>();
    const unresolved: UnresolvedImport[] = [];
    let edges = 0;
    let externalImports = 0;
    let assetImports = 0;
    let nonLiteralDynamicImports = 0;

    // Iterate in path order, not in completion order, so that the result is deterministic.
    for (const file of sourcePaths) {
      const result = extracted.get(file);
      if (!result) continue;
      nonLiteralDynamicImports += result.nonLiteralDynamic;

      const fileEdges = new Map<string, ImportEdge>();
      const fileExternals = new Set<string>();
      for (const ref of result.imports) {
        const resolution = resolveSpecifier(ref.specifier, file, context);
        switch (resolution.kind) {
          case 'resolved': {
            if (resolution.path === file) break;
            const existing = fileEdges.get(resolution.path);
            if (!existing || (existing.typeOnly && !ref.typeOnly)) {
              fileEdges.set(resolution.path, { to: resolution.path, typeOnly: ref.typeOnly, kind: ref.kind });
            }
            break;
          }
          case 'external':
            externalImports++;
            fileExternals.add(ref.specifier);
            break;
          case 'asset':
            assetImports++;
            break;
          case 'unresolved':
            unresolved.push({ importer: file, specifier: ref.specifier, reason: resolution.reason });
            break;
        }
      }

      imports.set(file, [...fileEdges.values()]);
      externals.set(file, [...fileExternals].sort());
      for (const edge of fileEdges.values()) {
        edges++;
        let set = importerSets.get(edge.to);
        if (!set) importerSets.set(edge.to, (set = new Set()));
        set.add(file);
      }
    }

    const importers = new Map<string, string[]>();
    for (const [target, set] of importerSets) importers.set(target, [...set].sort());

    return {
      allPaths,
      files,
      imports,
      importers,
      externals,
      unresolved,
      aliases,
      stats: {
        sourceFilesListed,
        sourceFilesRead: files.size,
        edges,
        externalImports,
        assetImports,
        unresolvedImports: unresolved.length,
        nonLiteralDynamicImports,
        skipped,
        limited: limitedReasons.length > 0,
        limitedReasons,
      },
    };
  }
}

export interface ReverseHit {
  depth: number;
  /** Files from the changed file up to the file that is imported by this one. */
  via: string[];
}

/**
 * Walks the import graph backwards from the seeds: who imports them, who imports those, up to `maxDepth`.
 * Seeds themselves and anything in `exclude` are never reported. The shortest chain wins.
 */
export function walkImporters(
  graph: Pick<ImportGraph, 'importers'>,
  seeds: readonly string[],
  maxDepth: number,
  exclude: ReadonlySet<string>,
): Map<string, ReverseHit> {
  const hits = new Map<string, ReverseHit>();
  let frontier: { node: string; chain: string[] }[] = [...new Set(seeds)].sort().map((seed) => ({ node: seed, chain: [seed] }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: { node: string; chain: string[] }[] = [];
    for (const { node, chain } of frontier) {
      for (const importer of graph.importers.get(node) ?? []) {
        if (exclude.has(importer) || hits.has(importer)) continue;
        hits.set(importer, { depth, via: chain });
        next.push({ node: importer, chain: [...chain, importer] });
      }
    }
    frontier = next;
  }
  return hits;
}
