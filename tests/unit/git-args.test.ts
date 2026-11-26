import { describe, expect, it } from 'vitest';

import {
  buildGitArgs,
  buildGitEnv,
  GIT_GLOBAL_ARGS,
  isFullSha,
  validateRefInput,
} from '../../src/infrastructure/git/git-args.js';

describe('validateRefInput', () => {
  it.each([
    ['HEAD'],
    ['main'],
    ['origin/main'],
    ['feature/DG-12_login'],
    ['v1.2.3'],
    ['HEAD~2'],
    ['HEAD^'],
    ['abc1234'],
    ['a'.repeat(200)],
  ])('accepts %j', (ref) => {
    expect(validateRefInput(ref)).toBe(ref);
  });

  it.each([
    [''],
    ['-x'],
    ['--output=/tmp/x'],
    ['--upload-pack=evil'],
    [' HEAD'],
    ['HEAD '],
    ['a b'],
    ['a;b'],
    ['a|b'],
    ['a`id`'],
    ['$(id)'],
    ['a&&b'],
    ['main..dev'],
    ['main...dev'],
    ['a//b'],
    ['@{u}'],
    ['HEAD@{1}'],
    ['^HEAD'],
    [':/message'],
    ['a\nb'],
    ['/etc/passwd'],
    ['.hidden'],
    ['~x'],
    ['ｍａｉｎ'],
    ['a'.repeat(201)],
  ])('rejects %j as INVALID_REF', (ref) => {
    expect(() => validateRefInput(ref)).toThrowError(expect.objectContaining({ code: 'INVALID_REF' }));
  });
});

describe('isFullSha', () => {
  it('only accepts full lowercase hex object ids', () => {
    expect(isFullSha('a'.repeat(40))).toBe(true);
    expect(isFullSha('a'.repeat(64))).toBe(true);
    expect(isFullSha('a'.repeat(39))).toBe(false);
    expect(isFullSha(`${'a'.repeat(39)}Z`)).toBe(false);
    expect(isFullSha('HEAD')).toBe(false);
  });
});

describe('buildGitArgs', () => {
  it('puts the hardening options before the subcommand', () => {
    const args = buildGitArgs(['diff', '--no-ext-diff']);

    expect(args.slice(0, GIT_GLOBAL_ARGS.length)).toEqual(GIT_GLOBAL_ARGS);
    expect(args.slice(GIT_GLOBAL_ARGS.length)).toEqual(['diff', '--no-ext-diff']);
    expect(args).toContain('--literal-pathspecs');
    expect(args).toContain('core.fsmonitor=false');
  });

  it.each([['push'], ['checkout'], ['config'], ['clean'], ['reset'], ['stash'], ['commit'], ['fetch'], ['-c'], ['--exec-path=/x'], ['']])(
    'refuses the subcommand %j',
    (subcommand) => {
      expect(() => buildGitArgs([subcommand, 'x'])).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
    },
  );

  it('refuses an empty argument list', () => {
    expect(() => buildGitArgs([])).toThrowError(expect.objectContaining({ code: 'INTERNAL' }));
  });
});

describe('buildGitEnv', () => {
  it('keeps only allowlisted variables and drops inherited GIT_* settings and secrets', () => {
    const env = buildGitEnv({
      Path: 'C:\\bin',
      HOME: '/home/u',
      GIT_DIR: '/elsewhere',
      GIT_WORK_TREE: '/elsewhere',
      GIT_EXTERNAL_DIFF: 'evil',
      GIT_CONFIG_COUNT: '1',
      GITHUB_TOKEN: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });

    expect(env['Path']).toBe('C:\\bin');
    expect(env['HOME']).toBe('/home/u');
    expect(Object.keys(env).filter((key) => key.startsWith('GIT_')).sort()).toEqual(['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT']);
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(env['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(env['LC_ALL']).toBe('C');
  });
});
