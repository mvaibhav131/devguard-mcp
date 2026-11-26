import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { DevGuardError } from '../../shared/errors.js';
import { MAX_PATH_LENGTH } from '../../shared/limits.js';

/**
 * True when `child` is `parent` itself or located below it.
 * Uses path.relative instead of a string prefix check, because "C:\repo-evil" starts with "C:\repo".
 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));

  if (relative === '') return true;
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;

  // A different drive on Windows makes path.relative return an absolute path.
  return !path.isAbsolute(relative);
}

export interface WorkspaceRootInput {
  /** Value of --workspace-root or DEVGUARD_WORKSPACE_ROOT, if the user configured one. */
  configuredRoot: string | undefined;
  cwd: string;
}

function configError(message: string, hint: string, cause?: unknown): DevGuardError {
  return new DevGuardError('CONFIG_INVALID', message, { hint, cause });
}

async function canonicalDirectory(candidate: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (cause) {
    throw configError(
      `Workspace root does not exist or is not accessible: ${candidate}`,
      'Check the path passed to --workspace-root.',
      cause,
    );
  }

  const info = await stat(resolved);
  if (!info.isDirectory()) {
    throw configError(`Workspace root is not a directory: ${candidate}`, 'Point it at your repository folder.');
  }
  return resolved;
}

async function canonicalHome(): Promise<string | undefined> {
  const home = homedir();
  if (!home) return undefined;
  return realpath(home).catch(() => home);
}

async function exists(target: string): Promise<boolean> {
  return stat(target).then(
    () => true,
    () => false,
  );
}

/**
 * Validates the workspace root and returns its canonical (symlink-free) path.
 * Everything DevGuard reads later is confined to this directory.
 */
export async function resolveWorkspaceRoot({ configuredRoot, cwd }: WorkspaceRootInput): Promise<string> {
  if (configuredRoot !== undefined && !path.isAbsolute(configuredRoot)) {
    throw configError(
      `Workspace root must be an absolute path, got "${configuredRoot}".`,
      'Pass a full path to --workspace-root. An unresolved variable such as ${workspaceFolder} also lands here.',
    );
  }

  const root = await canonicalDirectory(configuredRoot ?? cwd);

  if (path.parse(root).root === root) {
    throw configError(`Workspace root must not be a filesystem root: ${root}`, 'Point it at a repository folder.');
  }

  const home = await canonicalHome();
  if (home !== undefined && isPathInside(root, home)) {
    throw configError(
      `Workspace root must not be your home directory or one of its parents: ${root}`,
      'Point it at a repository folder, not a broad directory.',
    );
  }

  if (configuredRoot === undefined && !(await exists(path.join(root, '.git')))) {
    throw configError(
      `No workspace root configured and the current directory is not a git repository root: ${root}`,
      'Pass --workspace-root or set DEVGUARD_WORKSPACE_ROOT.',
    );
  }

  return root;
}

export interface RepoPathOptions {
  /** Overridable so Windows rules can be tested on any OS. */
  platform?: NodeJS.Platform;
}

export interface ConfinedPath {
  /** POSIX-style path relative to the workspace root, "." for the root itself. */
  relativePath: string;
  absolutePath: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;
const WINDOWS_FORBIDDEN_CHARS = /[<>:"|?*]/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const PATH_HINT = 'Use a path relative to the repository root, for example "src/index.ts".';

function quote(value: string): string {
  return JSON.stringify(value.length > 100 ? `${value.slice(0, 100)}...` : value);
}

function outsideWorkspace(message: string): DevGuardError {
  return new DevGuardError('PATH_OUTSIDE_WORKSPACE', message, { hint: PATH_HINT });
}

function invalidPath(message: string): DevGuardError {
  return new DevGuardError('INVALID_INPUT', message, { hint: PATH_HINT });
}

/**
 * Validates a user supplied, repository-relative path and returns it in normalized POSIX form.
 * Pure string checks only; see confinePath for the symlink-aware filesystem check.
 */
export function normalizeRepoPath(input: string, options: RepoPathOptions = {}): string {
  const platform = options.platform ?? process.platform;

  if (input.length === 0 || input.length > MAX_PATH_LENGTH) {
    throw invalidPath(`Path must be between 1 and ${MAX_PATH_LENGTH} characters.`);
  }
  if (CONTROL_CHARS.test(input)) {
    throw invalidPath(`Path contains control characters: ${quote(input)}.`);
  }

  const unified = platform === 'win32' ? input.replaceAll('\\', '/') : input;
  if (unified.startsWith('/') || DRIVE_PREFIX.test(unified)) {
    throw outsideWorkspace(`Absolute paths are not accepted here: ${quote(input)}.`);
  }

  const segments: string[] = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw outsideWorkspace(`Path must not contain "..": ${quote(input)}.`);
    }
    if (platform === 'win32') {
      if (WINDOWS_FORBIDDEN_CHARS.test(segment) || /[. ]$/.test(segment)) {
        throw invalidPath(`Path segment is not valid on Windows: ${quote(segment)}.`);
      }
      if (WINDOWS_RESERVED_NAME.test(segment.split('.')[0] ?? '')) {
        throw invalidPath(`Path segment is a reserved Windows device name: ${quote(segment)}.`);
      }
    }
    segments.push(segment);
  }

  return segments.length > 0 ? segments.join('/') : '.';
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// Deleted files do not exist on disk, so the nearest existing ancestor decides where a path really points.
async function nearestExistingRealPath(root: string, target: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      return await realpath(current);
    } catch (cause) {
      if (!isMissing(cause)) {
        throw invalidPath(`Path cannot be resolved: ${quote(path.relative(root, target))}.`);
      }
      const parent = path.dirname(current);
      if (parent === current || !isPathInside(root, parent)) return root;
      current = parent;
    }
  }
}

/**
 * Turns user input into a path that is guaranteed to stay inside `root`:
 * rejects traversal, drive/UNC/device paths and reserved names, and re-checks the
 * resolved location so a symlink or junction cannot lead out of the workspace.
 * `root` must already be canonical (see resolveWorkspaceRoot).
 */
export async function confinePath(root: string, input: string, options: RepoPathOptions = {}): Promise<ConfinedPath> {
  let candidate = input;
  if (path.isAbsolute(input)) {
    if (!isPathInside(root, input)) {
      throw outsideWorkspace(`Path is outside the workspace: ${quote(input)}.`);
    }
    candidate = path.relative(root, input) || '.';
  }

  const relativePath = normalizeRepoPath(candidate, options);
  const absolutePath = relativePath === '.' ? root : path.join(root, ...relativePath.split('/'));

  const real = await nearestExistingRealPath(root, absolutePath);
  if (!isPathInside(root, real)) {
    throw outsideWorkspace(`Path resolves outside the workspace through a link: ${quote(relativePath)}.`);
  }

  return { relativePath, absolutePath };
}

/** True when both paths resolve to the same directory (handles links and Windows case differences). */
export async function isSameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([realpath(a), realpath(b)]);
    return isPathInside(first, second) && isPathInside(second, first);
  } catch {
    return false;
  }
}
