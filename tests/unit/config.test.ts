import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, parseConfig } from '../../src/config/config.js';

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('parseConfig', () => {
  it('uses defaults when nothing is configured', () => {
    expect(parseConfig([], {})).toEqual({ workspaceRoot: undefined, logLevel: 'info' });
  });

  it('prefers command line arguments over environment variables', () => {
    const env = { DEVGUARD_WORKSPACE_ROOT: '/from-env', DEVGUARD_LOG_LEVEL: 'warn' };

    expect(parseConfig(['--workspace-root', '/from-cli', '--log-level', 'debug'], env)).toEqual({
      workspaceRoot: '/from-cli',
      logLevel: 'debug',
    });
    expect(parseConfig([], env)).toEqual({ workspaceRoot: '/from-env', logLevel: 'warn' });
  });

  it('treats empty values as not configured', () => {
    expect(parseConfig([], { DEVGUARD_WORKSPACE_ROOT: '  ', DEVGUARD_LOG_LEVEL: '' })).toEqual({
      workspaceRoot: undefined,
      logLevel: 'info',
    });
  });

  it.each([
    ['an invalid log level', ['--log-level', 'verbose']],
    ['an unknown option', ['--unknown']],
    ['a positional argument', ['stray']],
  ])('rejects %s with CONFIG_INVALID and a usage hint', (_name, argv) => {
    const error = catchError(() => parseConfig(argv, {}));

    expect(error).toMatchObject({ code: 'CONFIG_INVALID', hint: expect.stringContaining('--workspace-root') });
  });
});

describe('loadConfig', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devguard-config-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('returns the canonical workspace root together with the log level', async () => {
    const root = path.join(tmp, 'repo');
    await mkdir(root);

    const config = await loadConfig(['--workspace-root', root], { DEVGUARD_LOG_LEVEL: 'debug' }, tmp);

    expect(config).toEqual({ workspaceRoot: await realpath(root), logLevel: 'debug' });
  });
});
