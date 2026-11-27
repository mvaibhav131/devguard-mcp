import path from 'node:path';

import type { AliasConfig } from './tsconfig-paths.js';

export const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

// Directories that hold generated or third-party code. Their files are not part of the graph.
const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  '.git',
  '.next',
  '.turbo',
  '.cache',
]);

const RESOLVABLE_EXTENSIONS: readonly string[] = [...SOURCE_EXTENSIONS, '.json'];

// NodeNext style: "./a.js" in a TypeScript file points at "./a.ts".
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const ASSET_EXTENSIONS: ReadonlySet<string> = new Set([
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.html',
  '.txt',
  '.md',
  '.woff',
  '.woff2',
  '.ttf',
  '.wasm',
  '.graphql',
  '.gql',
]);

export function isSourceFile(filePath: string): boolean {
  const extension = path.posix.extname(filePath);
  if (!SOURCE_EXTENSIONS.includes(extension)) return false;
  return !hasExcludedSegment(filePath);
}

/** True for paths inside generated or third-party folders such as node_modules, dist or coverage. */
export function hasExcludedSegment(filePath: string): boolean {
  return filePath.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export type UnresolvedReason =
  | 'file-not-found'
  | 'alias-target-not-found'
  | 'package-imports-unsupported'
  | 'outside-workspace'
  | 'absolute-path';

export type Resolution =
  | { kind: 'resolved'; path: string }
  | { kind: 'external' }
  | { kind: 'asset' }
  | { kind: 'unresolved'; reason: UnresolvedReason };

export interface ResolverContext {
  /** Source files that exist in the workspace. */
  files: ReadonlySet<string>;
  /** Changed paths that no longer exist (deleted or renamed from), so their importers can still be linked. */
  extraKnown: ReadonlySet<string>;
  aliases: AliasConfig;
}

function candidatesFor(base: string): string[] {
  const extension = path.posix.extname(base);
  const candidates: string[] = [];

  const mapped = JS_TO_TS[extension];
  if (mapped) {
    const stem = base.slice(0, -extension.length);
    for (const target of mapped) candidates.push(`${stem}${target}`);
  }

  if (RESOLVABLE_EXTENSIONS.includes(extension)) {
    candidates.push(base);
  } else {
    for (const known of RESOLVABLE_EXTENSIONS) candidates.push(`${base}${known}`);
    candidates.push(`${base}.d.ts`);
  }

  for (const known of RESOLVABLE_EXTENSIONS) candidates.push(`${base}/index${known}`);
  return candidates;
}

function findExisting(base: string, context: ResolverContext): string | undefined {
  return candidatesFor(base).find((candidate) => context.files.has(candidate) || context.extraKnown.has(candidate));
}

function matchAlias(specifier: string, pattern: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star === -1) return specifier === pattern ? '' : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

/** Resolves one module specifier the way TypeScript would for the common cases. See docs for what is not covered. */
export function resolveSpecifier(specifier: string, importer: string, context: ResolverContext): Resolution {
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
    if (base === '..' || base.startsWith('../')) return { kind: 'unresolved', reason: 'outside-workspace' };

    const found = findExisting(base, context);
    if (found !== undefined) return { kind: 'resolved', path: found };
    if (ASSET_EXTENSIONS.has(path.posix.extname(base))) return { kind: 'asset' };
    return { kind: 'unresolved', reason: 'file-not-found' };
  }

  if (specifier.startsWith('#')) return { kind: 'unresolved', reason: 'package-imports-unsupported' };
  if (specifier.startsWith('/')) return { kind: 'unresolved', reason: 'absolute-path' };

  let best: { alias: AliasConfig['paths'][number]; captured: string; prefixLength: number } | undefined;
  for (const alias of context.aliases.paths) {
    const captured = matchAlias(specifier, alias.pattern);
    if (captured === undefined) continue;
    const prefixLength = alias.pattern.indexOf('*') === -1 ? alias.pattern.length : alias.pattern.indexOf('*');
    if (!best || prefixLength > best.prefixLength) best = { alias, captured, prefixLength };
  }
  if (best) {
    for (const target of best.alias.targets) {
      const found = findExisting(target.replace('*', best.captured), context);
      if (found !== undefined) return { kind: 'resolved', path: found };
    }
    return { kind: 'unresolved', reason: 'alias-target-not-found' };
  }

  const baseUrl = context.aliases.baseUrl;
  if (baseUrl !== undefined) {
    const found = findExisting(path.posix.normalize(path.posix.join(baseUrl, specifier)), context);
    if (found !== undefined) return { kind: 'resolved', path: found };
  }

  if (ASSET_EXTENSIONS.has(path.posix.extname(specifier))) return { kind: 'asset' };
  return { kind: 'external' };
}
