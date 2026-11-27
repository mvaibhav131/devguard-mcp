import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffService } from '../../src/core/diff/diff.service.js';
import { ChangeSetResolver } from '../../src/core/impact/change-set.js';
import { ImportGraphBuilder } from '../../src/core/impact/import-graph.js';
import { ReviewService, type ReviewRequest } from '../../src/core/review/review.service.js';
import { TestDiscoveryService } from '../../src/core/tests/test-discovery.service.js';
import { confinePath } from '../../src/infrastructure/fs/workspace-fs.js';
import { GitClient } from '../../src/infrastructure/git/git-client.js';
import { GitRunner } from '../../src/infrastructure/git/git-runner.js';
import { WorkspaceSourceFiles } from '../../src/infrastructure/workspace-source-files.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const request: ReviewRequest = { mode: 'workingTree', includeUntracked: true, minSeverity: 'info', limit: 100, offset: 0 };

describe('ReviewService on a real repository', () => {
  let repo: FixtureRepo;
  let service: ReviewService;

  const createService = (limits: Partial<Limits> = {}): ReviewService => {
    const merged = { ...DEFAULT_LIMITS, ...limits };
    const root = repo.root;
    const git = new GitClient(new GitRunner({ cwd: root, limits: merged }), root);
    const confine = (input: string) => confinePath(root, input);
    const source = new WorkspaceSourceFiles(git, root, merged.gitOutputCapBytes);
    const diff = new DiffService({ git, confinePath: confine, limits: merged });
    const changes = new ChangeSetResolver({ diff, confinePath: confine });
    const graphBuilder = new ImportGraphBuilder({ source, limits: merged });
    const tests = new TestDiscoveryService({ changes, graphBuilder, source, limits: merged });
    return new ReviewService({ diff, source, tests, limits: merged });
  };

  beforeEach(async () => {
    repo = await createFixtureRepo({ commit: false });
    await repo.write('package.json', JSON.stringify({ devDependencies: { vitest: '1.0.0' } }));
    await repo.write('package-lock.json', '{}');
    await repo.write('src/app.ts', 'export const app = 1;\nexport const other = 2;\n');
    await repo.write('src/util.ts', 'export const util = 1;\n');
    await repo.write('src/gone.ts', 'export const gone = 1;\n');
    await repo.write('tests/app.test.ts', "import { app } from '../src/app';\n");
    await repo.write('assets/logo.bin', Buffer.from([0, 1, 2, 3]));
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'init');
    service = createService();
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  async function makeRiskyChanges(): Promise<void> {
    await repo.write(
      'src/app.ts',
      ['export const app = 1;', 'export const other = 2;', 'eval(userInput);', "console.log('debug');", '// TODO: remove this', `const key = '${awsKey}';`, ''].join('\n'),
    );
    await repo.write('tests/app.test.ts', "import { app } from '../src/app';\nit.only('focused', () => {});\n");
    await repo.write('package-lock.json', `{ "token": "${awsKey}" }\n`);
    await repo.write('assets/logo.bin', Buffer.from([9, 9, 0, 9]));
    await repo.remove('src/gone.ts');
    await repo.write('src/fresh.ts', 'export const fresh = 1; // FIXME\n');
    await repo.git('add', 'src/fresh.ts');
    await repo.write('config/settings.env', `API_KEY="abcdef-123456-secret"\n# TODO rotate\n`);
  }

  it('reports findings with line numbers, severity order and masked evidence', async () => {
    await makeRiskyChanges();

    const result = await service.review(request);

    expect(result.precision).toBe('heuristic');
    expect(result.findings.map((finding) => `${finding.severity}:${finding.rule}:${finding.file}:${finding.line ?? '-'}`)).toEqual([
      'error:dangerous-eval:src/app.ts:3',
      'error:secret-aws-access-key:src/app.ts:6',
      'error:focused-test:tests/app.test.ts:2',
      'warning:secret-generic-assignment:config/settings.env:1',
      'warning:missing-tests:src/fresh.ts:-',
      'info:todo-marker:config/settings.env:2',
      'info:console-output:src/app.ts:4',
      'info:todo-marker:src/app.ts:5',
      'info:todo-marker:src/fresh.ts:1',
    ]);
    expect(result.summary).toMatchObject({ findings: 9, bySeverity: { error: 3, warning: 2, info: 4 } });
    expect(result.summary.byCategory).toEqual({ security: 3, tests: 2, maintainability: 4 });

    const everything = JSON.stringify(result);
    expect(everything).not.toContain(awsKey);
    expect(everything).not.toContain('abcdef-123456-secret');
    expect(result.findings.find((finding) => finding.rule === 'secret-aws-access-key')?.evidence).toContain('[REDACTED]');
  });

  it('skips lock files, binary files and deleted files, and reports the coverage', async () => {
    await makeRiskyChanges();

    const result = await service.review(request);

    expect(result.findings.map((finding) => finding.file)).not.toContain('package-lock.json');
    expect(result.coverage).toMatchObject({ untrackedFilesRead: 1, patchComplete: true, patchAligned: true });
    expect(result.coverage.skippedFiles).toMatchObject({ generated: 1, binary: 1 });
    expect(result.summary.filesReviewed).toBe(4);
    expect(result.rulesRun).toEqual(expect.arrayContaining(['dangerous-eval', 'missing-tests', 'secret-private-key']));
    expect(result.rules.map((rule) => rule.id)).toEqual(expect.arrayContaining(['dangerous-eval', 'missing-tests']));
    expect(result.rules.every((rule) => rule.count > 0 && rule.suggestion.length > 0)).toBe(true);
    expect(result.limitations.join('\n')).toContain('Heuristic');
  });

  it('attributes findings to the right file across a rename and a mode-only change', async () => {
    const body = Array.from({ length: 10 }, (_, index) => `export const value${index} = ${index};`);
    await repo.write('src/legacy.ts', `${body.join('\n')}\n`);
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'legacy');

    await repo.git('mv', 'src/legacy.ts', 'src/modern.ts');
    await repo.write('src/modern.ts', `${[...body, 'eval(renamedInput);'].join('\n')}\n`);
    await repo.git('update-index', '--chmod=+x', 'src/util.ts');
    await repo.write('src/app.ts', 'export const app = 1;\nexport const other = 2;\neval(appInput);\n');

    const result = await service.review({ ...request, categories: ['security'] });

    expect(result.coverage).toMatchObject({ patchComplete: true, patchAligned: true });
    expect(result.findings.map((finding) => `${finding.rule}:${finding.file}:${finding.line}`)).toEqual([
      'dangerous-eval:src/app.ts:3',
      'dangerous-eval:src/modern.ts:11',
    ]);
  });

  it('filters by severity and category', async () => {
    await makeRiskyChanges();

    const errors = await service.review({ ...request, minSeverity: 'error' });
    expect(errors.findings.map((finding) => finding.severity)).toEqual(['error', 'error', 'error']);
    expect(errors.rulesRun).not.toContain('todo-marker');

    const testsOnly = await service.review({ ...request, categories: ['tests'] });
    expect(testsOnly.findings.map((finding) => finding.rule)).toEqual(['focused-test', 'missing-tests']);
    expect(testsOnly.rulesRun).toEqual(['focused-test', 'missing-tests', 'skipped-test']);
  });

  it('reviews a branch range and staged changes separately', async () => {
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/util.ts', 'export const util = 1;\nexport const risky = eval("1");\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'feature');
    await repo.write('src/app.ts', 'export const app = 1;\nexport const other = 2;\ndebugger;\n');

    const range = await service.review({ ...request, mode: 'range', base: 'main', categories: ['security', 'correctness'] });
    const staged = await service.review({ ...request, mode: 'staged', categories: ['security', 'correctness'] });
    const working = await service.review({ ...request, categories: ['security', 'correctness'] });

    expect(range.findings.map((finding) => `${finding.rule}:${finding.file}:${finding.line}`)).toEqual(['dangerous-eval:src/util.ts:2']);
    expect(range.selection).toMatchObject({ source: 'git', mode: 'range', base: { input: 'main' } });
    expect(staged.findings).toEqual([]);
    expect(working.findings.map((finding) => finding.rule)).toEqual(['debugger-statement']);
  });

  it('pages findings and reports a clean change set as clean', async () => {
    await makeRiskyChanges();

    const first = await service.review({ ...request, limit: 4 });
    const second = await service.review({ ...request, limit: 4, offset: first.truncation.nextOffset ?? -1 });

    expect(first.truncation).toMatchObject({ truncated: true, reason: 'FILE_LIMIT', returned: 4, total: 9 });
    expect(second.findings[0]).not.toEqual(first.findings[0]);

    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'everything');
    const clean = await service.review(request);
    expect(clean.findings).toEqual([]);
    expect(clean.summary).toMatchObject({ findings: 0, filesReviewed: 0 });
    expect(clean.truncation.truncated).toBe(false);
  });

  it('flags a large addition and respects the cap on untracked files, which are read in path order', async () => {
    await repo.write('abig/big.ts', Array.from({ length: 450 }, (_, index) => `export const v${index} = ${index};`).join('\n') + '\n');
    for (let index = 0; index < 3; index++) await repo.write(`notes/n${index}.md`, 'TODO: write\n');
    const limited = createService({ maxReviewUntrackedFiles: 2 });

    const result = await limited.review({ ...request, categories: ['maintainability'] });

    expect(result.findings.some((finding) => finding.rule === 'large-added-block' && finding.file === 'abig/big.ts')).toBe(true);
    expect(result.coverage.skippedFiles.overCap).toBe(2);
    expect(result.limitations.join('\n')).toContain('untracked files were not read');
  });

  it('rejects an invalid selection with a classified error', async () => {
    await expect(service.review({ ...request, mode: 'range' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(service.review({ ...request, mode: 'range', base: '--output=x' })).rejects.toMatchObject({ code: 'INVALID_REF' });
    await expect(service.review({ ...request, paths: ['../x'] })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });
});
