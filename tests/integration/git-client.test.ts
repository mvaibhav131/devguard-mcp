import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitClient } from '../../src/infrastructure/git/git-client.js';
import { GitRunner } from '../../src/infrastructure/git/git-runner.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

function clientFor(root: string, gitTimeoutMs = DEFAULT_LIMITS.gitTimeoutMs): GitClient {
  return new GitClient(new GitRunner({ cwd: root, limits: { gitTimeoutMs } }), root);
}

describe('GitClient', () => {
  let repo: FixtureRepo;
  let client: GitClient;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    client = clientFor(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  it('reports the git version', async () => {
    await expect(client.version()).resolves.toMatch(/^\d+\.\d+/);
  });

  it('describes a repository at its root', async () => {
    const state = await client.repoState();

    expect(state).toMatchObject({ isRepo: true, isRepoRoot: true, branch: 'main', detached: false });
    expect(state.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('reports a detached HEAD and an unborn branch', async () => {
    await repo.git('checkout', '-q', '--detach');
    await expect(client.repoState()).resolves.toMatchObject({ branch: null, detached: true });

    const unborn = await createFixtureRepo({ commit: false });
    try {
      await expect(clientFor(unborn.root).repoState()).resolves.toMatchObject({ isRepo: true, branch: 'main', headSha: null });
    } finally {
      await unborn.cleanup();
    }
  });

  it('knows when the workspace root is a subfolder of the repository or not a repository', async () => {
    const sub = path.join(repo.root, 'src');
    await expect(clientFor(sub).repoState()).resolves.toMatchObject({ isRepo: true, isRepoRoot: false });

    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-plain-')));
    try {
      await expect(clientFor(plain).repoState()).resolves.toMatchObject({ isRepo: false });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('resolves refs to full commit ids and rejects unknown or unsafe refs', async () => {
    const head = (await repo.git('rev-parse', 'HEAD')).trim();

    await expect(client.resolveCommit('HEAD')).resolves.toBe(head);
    await expect(client.resolveCommit('main')).resolves.toBe(head);
    await expect(client.resolveCommit('does-not-exist')).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(client.resolveCommit('--output=leak.txt')).rejects.toMatchObject({ code: 'INVALID_REF' });
  });

  it('lists changes for the working tree, the index and a commit range', async () => {
    const base = await client.resolveCommit('HEAD');
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/feature.ts', 'export const f = 1;\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'feature');
    const head = await client.resolveCommit('feature');

    await repo.write('src/a.ts', 'export const a = 100;\n');
    await repo.remove('src/b.ts');
    await repo.git('mv', 'README.md', 'README2.md');
    await repo.write('src/staged.ts', 'export const s = 1;\n');
    await repo.git('add', 'src/staged.ts');
    await repo.write('src/untracked.ts', 'export const u = 1;\n');

    const read = async (spec: Parameters<GitClient['readDiff']>[0]['spec']) =>
      (await client.readDiff({ spec, format: 'name-status', pathspecs: [], maxBytes: 1_000_000 })).data.toString('utf8');

    const workingTree = await read({ kind: 'workingTree', hasHead: true });
    expect(workingTree).toContain('M\0src/a.ts\0');
    expect(workingTree).toContain('D\0src/b.ts\0');
    expect(workingTree).toContain('A\0src/staged.ts\0');
    expect(workingTree).toContain('R100\0README.md\0README2.md\0');

    const staged = await read({ kind: 'staged' });
    expect(staged).toContain('A\0src/staged.ts\0');
    expect(staged).not.toContain('src/a.ts');

    const range = await read({ kind: 'range', baseSha: base, headSha: head });
    expect(range).toBe('A\0src/feature.ts\0');

    const untracked = await client.listUntracked({ pathspecs: [], maxBytes: 1_000_000 });
    expect(untracked.data.toString('utf8')).toBe('src/untracked.ts\0');
    const filtered = await client.listUntracked({ pathspecs: ['docs'], maxBytes: 1_000_000 });
    expect(filtered.data.length).toBe(0);
  });

  it('marks output as truncated when it exceeds the byte cap', async () => {
    await repo.write('src/a.ts', 'changed\n');

    const result = await client.readDiff({ spec: { kind: 'staged' }, format: 'patch', pathspecs: [], maxBytes: 5 });
    await repo.git('add', 'src/a.ts');
    const staged = await client.readDiff({ spec: { kind: 'staged' }, format: 'patch', pathspecs: [], maxBytes: 5 });

    expect(result.truncated).toBe(false);
    expect(staged.truncated).toBe(true);
    expect(staged.data.length).toBe(5);
  });

  it('turns a tiny time limit into GIT_TIMEOUT and propagates cancellation', async () => {
    await expect(clientFor(repo.root, 1).repoState()).rejects.toMatchObject({ code: 'GIT_TIMEOUT' });

    await expect(client.repoState(AbortSignal.abort())).rejects.toBeInstanceOf(Error);
  });
});
