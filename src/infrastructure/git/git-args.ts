import { DevGuardError } from '../../shared/errors.js';
import { isSafeRefName } from '../../shared/refs.js';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function validateRefInput(ref: string): string {
  if (!isSafeRefName(ref)) {
    throw new DevGuardError('INVALID_REF', `Invalid git ref ${JSON.stringify(ref.slice(0, 80))}.`, {
      hint: 'Use a branch, tag, commit SHA or HEAD~N. Ranges such as "a..b" and options are not accepted.',
    });
  }
  return ref;
}

export function isFullSha(value: string): boolean {
  return FULL_SHA.test(value);
}

/** Only read-only commands are reachable. Anything else is a programming error, not user input. */
export const ALLOWED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  '--version',
  'rev-parse',
  'symbolic-ref',
  'diff',
  'ls-files',
]);

/**
 * Global options placed before every subcommand.
 * core.fsmonitor=false stops a repository-defined fsmonitor command from running.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = [
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'color.ui=false',
];

export function buildGitArgs(subArgs: readonly string[]): string[] {
  const subcommand = subArgs[0];
  if (subcommand === undefined || !ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new DevGuardError('INTERNAL', `Git subcommand is not allowed: ${subcommand ?? '(none)'}`);
  }
  return [...GIT_GLOBAL_ARGS, ...subArgs];
}

const ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'SYSTEMROOT',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CONFIG_HOME',
]);

/**
 * Builds the environment for git from an allowlist. Inherited GIT_* variables (GIT_DIR, GIT_WORK_TREE,
 * GIT_EXTERNAL_DIFF, ...) and unrelated secrets never reach the child process.
 */
export function buildGitEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOWLIST.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_OPTIONAL_LOCKS'] = '0';
  env['LC_ALL'] = 'C';
  return env;
}
