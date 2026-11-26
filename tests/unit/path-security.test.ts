import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { confinePath, normalizeRepoPath } from '../../src/infrastructure/fs/workspace-fs.js';

const posix = { platform: 'linux' } as const;
const win = { platform: 'win32' } as const;

describe('normalizeRepoPath', () => {
  it('normalizes separators and dot segments', () => {
    expect(normalizeRepoPath('src/a.ts', posix)).toBe('src/a.ts');
    expect(normalizeRepoPath('./src//a.ts', posix)).toBe('src/a.ts');
    expect(normalizeRepoPath('.', posix)).toBe('.');
    expect(normalizeRepoPath('src\\core\\a.ts', win)).toBe('src/core/a.ts');
    expect(normalizeRepoPath('a\\b', posix)).toBe('a\\b');
  });

  it.each([
    ['../x'],
    ['a/../../x'],
    ['a/..'],
    ['..'],
    ['/etc/passwd'],
    ['C:\\Windows\\system32'],
    ['C:/x'],
    ['c:foo'],
  ])('rejects traversal and absolute path %j as PATH_OUTSIDE_WORKSPACE', (input) => {
    expect(() => normalizeRepoPath(input, win)).toThrowError(expect.objectContaining({ code: 'PATH_OUTSIDE_WORKSPACE' }));
    expect(() => normalizeRepoPath(input, posix)).toThrowError(expect.objectContaining({ code: 'PATH_OUTSIDE_WORKSPACE' }));
  });

  it.each([['\\\\server\\share\\x'], ['\\\\?\\C:\\x'], ['\\\\.\\pipe\\x'], ['a/..\\b']])(
    'rejects UNC, device and mixed-separator traversal %j on Windows',
    (input) => {
      expect(() => normalizeRepoPath(input, win)).toThrowError(expect.objectContaining({ code: 'PATH_OUTSIDE_WORKSPACE' }));
    },
  );

  it.each([[''], ['a\0b'], ['a\nb'], ['a\tb'], ['a'.repeat(1025)]])('rejects empty, oversized and control characters %j', (input) => {
    expect(() => normalizeRepoPath(input, posix)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });

  it.each([
    ['file.txt:stream'],
    ['CON'],
    ['src/nul.txt'],
    ['COM1'],
    ['LPT9.log'],
    ['trailing.'],
    ['trailing '],
    ['a<b'],
    ['a|b'],
    ['a?b'],
    ['a*b'],
    ['a"b'],
  ])('rejects the Windows-invalid segment %j only on Windows', (input) => {
    expect(() => normalizeRepoPath(input, win)).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => normalizeRepoPath(input, posix)).not.toThrow();
  });
});

describe('confinePath', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-confine-')));
    root = path.join(tmp, 'root');
    outside = path.join(tmp, 'outside');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'secret');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('accepts existing and missing paths inside the root', async () => {
    await expect(confinePath(root, 'src/a.ts')).resolves.toEqual({
      relativePath: 'src/a.ts',
      absolutePath: path.join(root, 'src', 'a.ts'),
    });
    await expect(confinePath(root, 'deleted/dir/file.ts')).resolves.toMatchObject({ relativePath: 'deleted/dir/file.ts' });
    await expect(confinePath(root, '.')).resolves.toEqual({ relativePath: '.', absolutePath: root });
  });

  it('converts an absolute path inside the root and rejects other absolute paths', async () => {
    await expect(confinePath(root, path.join(root, 'src', 'a.ts'))).resolves.toMatchObject({ relativePath: 'src/a.ts' });
    await expect(confinePath(root, path.join(outside, 'secret.txt'))).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(confinePath(root, `${root}-evil${path.sep}x`)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects traversal', async () => {
    await expect(confinePath(root, '../outside/secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('rejects a junction or symlink inside the root that points outside', async () => {
    await symlink(outside, path.join(root, 'link'), 'junction');

    await expect(confinePath(root, 'link/secret.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(confinePath(root, 'link/missing-file.txt')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
    await expect(confinePath(root, 'link')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('allows a link that stays inside the root', async () => {
    await symlink(path.join(root, 'src'), path.join(root, 'alias'), 'junction');

    await expect(confinePath(root, 'alias/a.ts')).resolves.toMatchObject({ relativePath: 'alias/a.ts' });
  });

  it.runIf(process.platform === 'win32')('treats Windows absolute paths case-insensitively', async () => {
    const shouting = path.join(root, 'src', 'a.ts').toUpperCase();

    await expect(confinePath(root, shouting)).resolves.toMatchObject({ relativePath: 'SRC/A.TS' });
  });
});
