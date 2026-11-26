import { mkdir, mkdtemp, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readWorkspaceText } from '../../src/infrastructure/fs/workspace-fs.js';

describe('readWorkspaceText', () => {
  let tmp: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-read-')));
    root = path.join(tmp, 'root');
    outside = path.join(tmp, 'outside');
    await mkdir(path.join(root, 'src'), { recursive: true });
    await mkdir(outside);
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  const read = (relativePath: string, maxBytes = 1_000) => readWorkspaceText(root, relativePath, maxBytes);

  it('reads a text file and strips nothing but returns it verbatim', async () => {
    await writeFile(path.join(root, 'src', 'a.ts'), "import './b';\n");

    await expect(read('src/a.ts')).resolves.toEqual({ status: 'ok', text: "import './b';\n" });
  });

  it('skips missing, oversized, binary and non-file entries', async () => {
    await writeFile(path.join(root, 'src', 'big.ts'), 'x'.repeat(50));
    await writeFile(path.join(root, 'src', 'bin.ts'), Buffer.from([105, 0, 109]));

    await expect(read('src/missing.ts')).resolves.toEqual({ status: 'skipped', reason: 'missing' });
    await expect(read('src/big.ts', 10)).resolves.toEqual({ status: 'skipped', reason: 'too-large' });
    await expect(read('src/bin.ts')).resolves.toEqual({ status: 'skipped', reason: 'binary' });
    await expect(read('src')).resolves.toEqual({ status: 'skipped', reason: 'unreadable' });
  });

  it('never reads outside the workspace, whether by traversal or through a junction', async () => {
    await writeFile(path.join(outside, 'secret.ts'), 'secret');
    await symlink(outside, path.join(root, 'link'), 'junction');

    await expect(read('../outside/secret.ts')).resolves.toEqual({ status: 'skipped', reason: 'outside' });
    await expect(read('link/secret.ts')).resolves.toEqual({ status: 'skipped', reason: 'outside' });
  });

  it('skips a symbolic link to a file inside the workspace', async () => {
    const target = path.join(root, 'src', 'real.ts');
    await writeFile(target, 'real');
    try {
      await symlink(target, path.join(root, 'src', 'alias.ts'), 'file');
    } catch {
      return; // creating file symlinks needs a privilege on some Windows setups
    }

    await expect(read('src/alias.ts')).resolves.toEqual({ status: 'skipped', reason: 'symlink' });
    await truncate(target, 0);
  });
});
