import { parseArgs } from 'node:util';

import { resolveWorkspaceRoot } from '../infrastructure/fs/workspace-fs.js';
import { DevGuardError } from '../shared/errors.js';
import { isLogLevel, LOG_LEVELS, type LogLevel } from '../shared/logger.js';

export interface Config {
  /** Canonical absolute path. All repository access is confined to it. */
  workspaceRoot: string;
  logLevel: LogLevel;
}

export interface RawConfig {
  workspaceRoot: string | undefined;
  logLevel: LogLevel;
}

const USAGE = `Supported options: --workspace-root <absolute path>, --log-level <${LOG_LEVELS.join('|')}>. Environment: DEVGUARD_WORKSPACE_ROOT, DEVGUARD_LOG_LEVEL.`;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Pure parsing, no filesystem access. Precedence: command line > environment > defaults. */
export function parseConfig(argv: readonly string[], env: NodeJS.ProcessEnv): RawConfig {
  let values: { 'workspace-root'?: string | undefined; 'log-level'?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        'workspace-root': { type: 'string' },
        'log-level': { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (cause) {
    throw new DevGuardError('CONFIG_INVALID', 'Invalid command line arguments.', { hint: USAGE, cause });
  }

  const logLevel = nonEmpty(values['log-level']) ?? nonEmpty(env['DEVGUARD_LOG_LEVEL']) ?? 'info';
  if (!isLogLevel(logLevel)) {
    throw new DevGuardError('CONFIG_INVALID', `Invalid log level "${logLevel}".`, { hint: USAGE });
  }

  return {
    workspaceRoot: nonEmpty(values['workspace-root']) ?? nonEmpty(env['DEVGUARD_WORKSPACE_ROOT']),
    logLevel,
  };
}

export async function loadConfig(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Config> {
  const raw = parseConfig(argv, env);
  const workspaceRoot = await resolveWorkspaceRoot({ configuredRoot: raw.workspaceRoot, cwd });
  return { workspaceRoot, logLevel: raw.logLevel };
}
