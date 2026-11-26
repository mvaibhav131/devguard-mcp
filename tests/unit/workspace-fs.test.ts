import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPathInside, resolveWorkspaceRoot } from '../../src/infrastructure/fs/workspace-fs.js';

describe('isPathInside', () => {
  const parent = path.resolve('repo');

  it('accepts the parent itself and paths below it', () => {
    expect(isPathInside(parent, parent)).toBe(true);
    expect(isPathInside(parent, path.join(parent, 'src', 'a.ts'))).toBe(true);
  });

  it('rejects traversal, siblings and a sibling that merely shares the prefix', () => {
    expect(isPathInside(parent, path.join(parent, '..', 'other'))).toBe(false);
    expect(isPathInside(parent, path.join(parent, 'src', '..', '..', 'x'))).toBe(false);
    expect(isPathInside(parent, `${parent}-evil`)).toBe(false);
  });

  it('does not confuse a directory named "..foo" with traversal', () => {
    expect(isPathInside(parent, path.join(parent, '..foo', 'a.ts'))).toBe(true);
  });

  it.runIf(process.platform === 'win32')('handles Windows drives and case-insensitive paths', () => {
    expect(isPathInside('C:\\Repo', 'c:\\repo\\src')).toBe(true);
    expect(isPathInside('C:\\repo', 'D:\\repo\\src')).toBe(false);
    expect(isPathInside('C:\\repo', 'C:\\repo-evil\\src')).toBe(false);
  });
});

describe('resolveWorkspaceRoot', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'devguard-root-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const rejected = (configuredRoot: string | undefined, cwd = tmp) =>
    expect(resolveWorkspaceRoot({ configuredRoot, cwd })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });

  it('returns the canonical path of an existing directory', async () => {
    // os.tmpdir() can contain 8.3 short names on Windows, so compare against the real path.
    await expect(resolveWorkspaceRoot({ configuredRoot: tmp, cwd: tmp })).resolves.toBe(await realpath(tmp));
  });

  it('follows a symlink or junction to the real directory', async () => {
    const target = path.join(tmp, 'real');
    const link = path.join(tmp, 'link');
    await mkdir(target);
    await symlink(target, link, 'junction');

    await expect(resolveWorkspaceRoot({ configuredRoot: link, cwd: tmp })).resolves.toBe(await realpath(target));
  });

  it('rejects relative, missing and non-directory roots', async () => {
    const file = path.join(tmp, 'file.txt');
    await writeFile(file, 'x');

    await rejected('relative/path');
    await rejected('${workspaceFolder}');
    await rejected(path.join(tmp, 'missing'));
    await rejected(file);
  });

  it('rejects a filesystem root, the home directory and its parent', async () => {
    await rejected(path.parse(tmp).root);
    await rejected(homedir());
    await rejected(path.dirname(homedir()));
  });

  it('falls back to the current directory only when it is a git repository root', async () => {
    await rejected(undefined, tmp);

    await mkdir(path.join(tmp, '.git'));
    await expect(resolveWorkspaceRoot({ configuredRoot: undefined, cwd: tmp })).resolves.toBe(await realpath(tmp));
  });
});
