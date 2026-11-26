import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffService, type AnalyzeDiffRequest } from '../../src/core/diff/diff.service.js';
import { confinePath } from '../../src/infrastructure/fs/workspace-fs.js';
import { GitClient } from '../../src/infrastructure/git/git-client.js';
import { GitRunner } from '../../src/infrastructure/git/git-runner.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

const defaults: AnalyzeDiffRequest = { mode: 'workingTree', includeUntracked: true, limit: 50, offset: 0 };

function createService(root: string, overrides: Partial<Limits> = {}): DiffService {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  const git = new GitClient(new GitRunner({ cwd: root, limits }), root);
  return new DiffService({ git, confinePath: (input) => confinePath(root, input), limits });
}

describe('DiffService', () => {
  let repo: FixtureRepo;
  let service: DiffService;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    service = createService(repo.root);
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function makeBusyRepo(): Promise<void> {
    await repo.write('src/a.ts', 'export const a = 100;\n');
    await repo.remove('src/b.ts');
    await repo.git('mv', 'README.md', 'README2.md');
    await repo.write('assets/logo.bin', Buffer.from([9, 9, 0, 9]));
    await repo.write('docs/old name.md', 'Changed line.\n');
    await repo.write('src/staged.ts', 'export const s = 1;\n');
    await repo.git('add', 'src/staged.ts');
    await repo.write('src/untracked.ts', 'export const u = 1;\n');
  }

  it('reports a clean repository as an empty, untruncated result', async () => {
    const result = await service.analyze(defaults);

    expect(result.summary).toMatchObject({ filesChanged: 0, additions: 0, deletions: 0 });
    expect(result.files).toEqual([]);
    expect(result.truncation).toEqual({ truncated: false, returned: 0, total: 0, omitted: 0 });
  });

  it('analyses statuses, counts, hunks, renames, binary and untracked files, most changed first', async () => {
    await makeBusyRepo();

    const result = await service.analyze(defaults);

    expect(result.files.map((file) => file.path)).toEqual([
      'src/a.ts',
      'docs/old name.md',
      'src/b.ts',
      'src/staged.ts',
      'README2.md',
      'assets/logo.bin',
      'src/untracked.ts',
    ]);
    expect(result.summary).toEqual({
      filesChanged: 7,
      additions: 3,
      deletions: 4,
      binaryFiles: 1,
      byStatus: { modified: 3, deleted: 1, added: 1, renamed: 1, untracked: 1 },
      byLanguage: { typescript: 4, markdown: 2, other: 1 },
    });
    expect(result.hunkCoverage).toBe('complete');

    const byPath = new Map(result.files.map((file) => [file.path, file]));
    expect(byPath.get('src/a.ts')).toMatchObject({
      status: 'modified',
      language: 'typescript',
      additions: 1,
      deletions: 2,
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1 }],
    });
    expect(byPath.get('src/b.ts')?.hunks).toEqual([{ oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 }]);
    expect(byPath.get('src/staged.ts')).toMatchObject({ status: 'added', hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 }] });
    expect(byPath.get('README2.md')).toMatchObject({ status: 'renamed', oldPath: 'README.md', additions: 0, deletions: 0 });
    expect(byPath.get('README2.md')?.hunks).toBeUndefined();
    expect(byPath.get('assets/logo.bin')).toMatchObject({ isBinary: true, additions: null, deletions: null });
    expect(byPath.get('src/untracked.ts')).toMatchObject({ status: 'untracked', additions: null });
    expect(result.truncation.truncated).toBe(false);
  });

  it('pages through results with stable, disjoint pages', async () => {
    await makeBusyRepo();

    const first = await service.analyze({ ...defaults, limit: 3 });
    const second = await service.analyze({ ...defaults, limit: 3, offset: first.truncation.nextOffset ?? -1 });
    const third = await service.analyze({ ...defaults, limit: 3, offset: second.truncation.nextOffset ?? -1 });

    expect(first.truncation).toMatchObject({ truncated: true, reason: 'FILE_LIMIT', returned: 3, total: 7, omitted: 4, nextOffset: 3 });
    expect(first.truncation.hint).toContain('offset=3');
    expect(second.truncation).toMatchObject({ returned: 3, omitted: 1, nextOffset: 6 });
    expect(third.truncation).toMatchObject({ truncated: false, returned: 1, omitted: 0 });
    expect(third.truncation.nextOffset).toBeUndefined();

    const paths = [...first.files, ...second.files, ...third.files].map((file) => file.path);
    expect(new Set(paths).size).toBe(7);
    expect(first.summary.filesChanged).toBe(7);
  });

  it('stops at the response byte budget, reports it and keeps paging possible', async () => {
    await makeBusyRepo();
    const tight = createService(repo.root, { maxResponseBytes: 1_200 });

    const result = await tight.analyze(defaults);

    expect(result.truncation.reason).toBe('BYTE_BUDGET');
    expect(result.truncation.returned).toBeGreaterThanOrEqual(1);
    expect(result.truncation.returned).toBeLessThan(7);
    expect(result.truncation.nextOffset).toBe(result.truncation.returned);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(2_400);
  });

  it('reports SCAN_LIMIT with partial hunks when more files changed than are scanned', async () => {
    await makeBusyRepo();
    const limited = createService(repo.root, { maxFilesScanned: 2 });

    const result = await limited.analyze(defaults);

    expect(result.truncation).toMatchObject({ truncated: true, reason: 'SCAN_LIMIT', total: 2 });
    expect(result.hunkCoverage).toBe('partial');
  });

  it('caps hunks per file', async () => {
    await repo.write('src/many.ts', Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n') + '\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'many');
    await repo.write('src/many.ts', Array.from({ length: 40 }, (_, index) => (index % 2 === 0 ? `changed ${index}` : `line ${index}`)).join('\n') + '\n');
    const capped = createService(repo.root, { maxHunksPerFile: 3 });

    const result = await capped.analyze(defaults);

    expect(result.files[0]).toMatchObject({ path: 'src/many.ts', hunksTruncated: true });
    expect(result.files[0]?.hunks).toHaveLength(3);
  });

  it('limits the analysis to the requested paths', async () => {
    await makeBusyRepo();

    const result = await service.analyze({ ...defaults, paths: ['src', './docs/'] });

    expect(result.files.map((file) => file.path).sort()).toEqual(['docs/old name.md', 'src/a.ts', 'src/b.ts', 'src/staged.ts', 'src/untracked.ts']);
    expect(result.selection.paths).toEqual(['src', 'docs']);
  });

  it('supports staged mode without untracked files', async () => {
    await makeBusyRepo();

    const result = await service.analyze({ ...defaults, mode: 'staged', includeUntracked: false });

    expect(result.files.map((file) => file.path).sort()).toEqual(['README2.md', 'src/staged.ts']);
    expect(result.selection).toEqual({ mode: 'staged', includeUntracked: false });
  });

  it('supports range mode with resolved commit ids', async () => {
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/feature.ts', 'export const f = 1;\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'feature');

    const result = await service.analyze({ ...defaults, mode: 'range', base: 'main', head: 'feature' });

    expect(result.files.map((file) => file.path)).toEqual(['src/feature.ts']);
    expect(result.selection.base).toMatchObject({ input: 'main' });
    expect(result.selection.head?.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('handles an unborn repository and non-ASCII file names', async () => {
    const unborn = await createFixtureRepo({ commit: false });
    try {
      await unborn.write('src/ünï-ç.ts', 'export const x = 1;\n');
      await unborn.git('add', '-A');

      const result = await createService(unborn.root).analyze(defaults);

      expect(result.files).toMatchObject([{ path: 'src/ünï-ç.ts', status: 'added', additions: 1 }]);
    } finally {
      await unborn.cleanup();
    }
  });

  it('rejects invalid selections, refs and paths with classified errors', async () => {
    const rejects = (request: Partial<AnalyzeDiffRequest>, code: string) =>
      expect(service.analyze({ ...defaults, ...request })).rejects.toMatchObject({ code });

    await rejects({ mode: 'range' }, 'INVALID_INPUT');
    await rejects({ base: 'main' }, 'INVALID_INPUT');
    await rejects({ mode: 'range', base: 'no-such-branch' }, 'INVALID_REF');
    await rejects({ mode: 'range', base: '--output=x' }, 'INVALID_REF');
    await rejects({ paths: ['../outside'] }, 'PATH_OUTSIDE_WORKSPACE');
    await rejects({ paths: ['a\0b'] }, 'INVALID_INPUT');
  });

  it('refuses a workspace that is not the repository root', async () => {
    await expect(createService(path.join(repo.root, 'src')).analyze(defaults)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });

    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-plain-')));
    try {
      await expect(createService(plain).analyze(defaults)).rejects.toMatchObject({ code: 'NOT_A_GIT_REPO' });
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
