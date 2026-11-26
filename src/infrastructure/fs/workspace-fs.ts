import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { DevGuardError } from '../../shared/errors.js';

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
