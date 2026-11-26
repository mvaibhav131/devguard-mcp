import path from 'node:path';

export interface PathAlias {
  /** Pattern from tsconfig "paths", for example "@/*". */
  pattern: string;
  /** Repository-relative target patterns, for example "src/*". */
  targets: string[];
}

export interface AliasConfig {
  /** Repository-relative directory ('' for the root) or undefined when no baseUrl is configured. */
  baseUrl: string | undefined;
  paths: PathAlias[];
}

export const NO_ALIASES: AliasConfig = { baseUrl: undefined, paths: [] };

const MAX_EXTENDS_DEPTH = 5;

function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inString = false;

  while (i < text.length) {
    const c = text.charAt(i);
    const next = text.charAt(i + 1);

    if (inString) {
      out += c;
      if (c === '\\') {
        out += next;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
    } else if (c === '"') {
      inString = true;
      out += c;
      i++;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i++;
    } else if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  // Trailing commas. A string that contains ",}" or ",]" is an accepted edge case.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** tsconfig.json is JSON with comments and trailing commas. Returns undefined when it cannot be parsed. */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text.replace(/^\uFEFF/, '')));
  } catch {
    return undefined;
  }
}

interface RawConfig {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

interface ResolvedConfig {
  baseUrl: string | undefined;
  /** Directory that "paths" targets are relative to (baseUrl, otherwise the declaring config's folder). */
  paths: { pattern: string; targets: string[] }[] | undefined;
}

type Reader = (repoPath: string) => Promise<string | undefined>;

function toRepoDir(directory: string, relative: string): string {
  const joined = path.posix.normalize(path.posix.join(directory, relative));
  return joined === '.' ? '' : joined;
}

async function resolveConfig(file: string, read: Reader, depth: number): Promise<ResolvedConfig | undefined> {
  if (depth > MAX_EXTENDS_DEPTH) return undefined;

  const text = await read(file);
  if (text === undefined) return undefined;
  const raw = parseJsonc(text);
  if (typeof raw !== 'object' || raw === null) return undefined;

  const config = raw as RawConfig;
  const directory = path.posix.dirname(file);
  let result: ResolvedConfig = { baseUrl: undefined, paths: undefined };

  const parents = Array.isArray(config.extends) ? config.extends : config.extends === undefined ? [] : [config.extends];
  for (const parent of parents) {
    // Only relative extends are followed; packages such as "@tsconfig/node22" are not resolved.
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    const parentFile = parent.endsWith('.json') ? toRepoDir(directory, parent) : `${toRepoDir(directory, parent)}.json`;
    const resolved = await resolveConfig(parentFile, read, depth + 1);
    if (resolved) result = { baseUrl: resolved.baseUrl ?? result.baseUrl, paths: resolved.paths ?? result.paths };
  }

  const options = config.compilerOptions;
  if (typeof options?.baseUrl === 'string') {
    result = { ...result, baseUrl: toRepoDir(directory, options.baseUrl) };
  }
  if (typeof options?.paths === 'object' && options.paths !== null) {
    const base = result.baseUrl ?? (directory === '.' ? '' : directory);
    const paths: { pattern: string; targets: string[] }[] = [];
    for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      paths.push({
        pattern,
        targets: targets.filter((target): target is string => typeof target === 'string').map((target) => toRepoDir(base, target)),
      });
    }
    result = { ...result, paths };
  }
  return result;
}

/** Reads path aliases from the root tsconfig.json (or jsconfig.json), following relative "extends". */
export async function loadAliasConfig(read: Reader): Promise<AliasConfig> {
  for (const file of ['tsconfig.json', 'jsconfig.json']) {
    const resolved = await resolveConfig(file, read, 0);
    if (resolved) return { baseUrl: resolved.baseUrl, paths: resolved.paths ?? [] };
  }
  return NO_ALIASES;
}
