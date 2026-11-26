import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DiffService } from '../../src/core/diff/diff.service.js';
import { ChangeSetResolver } from '../../src/core/impact/change-set.js';
import { ImpactService } from '../../src/core/impact/impact.service.js';
import { ImportGraphBuilder } from '../../src/core/impact/import-graph.js';
import { TestDiscoveryService } from '../../src/core/tests/test-discovery.service.js';
import { confinePath } from '../../src/infrastructure/fs/workspace-fs.js';
import { GitClient } from '../../src/infrastructure/git/git-client.js';
import { GitRunner } from '../../src/infrastructure/git/git-runner.js';
import { WorkspaceSourceFiles } from '../../src/infrastructure/workspace-source-files.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

describe('impact and test discovery on a real repository', () => {
  let repo: FixtureRepo;
  let impact: ImpactService;
  let tests: TestDiscoveryService;

  beforeEach(async () => {
    repo = await createFixtureRepo({ commit: false });
    await repo.write('package.json', JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } }));
    await repo.write('tsconfig.json', '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }');
    await repo.write('src/util.ts', 'export const util = 1;\n');
    await repo.write('src/service.ts', "import { util } from './util.js';\nexport const service = util;\n");
    await repo.write('src/app.ts', "import { service } from '@/service';\nexport const app = service;\n");
    await repo.write('src/orphan.ts', 'export const orphan = 1;\n');
    await repo.write('tests/service.test.ts', "import { service } from '../src/service';\n");
    await repo.write('src/ignored.ts', "import './util';\n");
    await repo.write('.gitignore', 'src/ignored.ts\nnode_modules/\n');
    await repo.write('node_modules/pkg/index.js', "require('../../src/util');\n");
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'init');

    const root = repo.root;
    const limits = DEFAULT_LIMITS;
    const git = new GitClient(new GitRunner({ cwd: root, limits }), root);
    const confine = (input: string) => confinePath(root, input);
    const source = new WorkspaceSourceFiles(git, root, limits.gitOutputCapBytes);
    const diff = new DiffService({ git, confinePath: confine, limits });
    const changes = new ChangeSetResolver({ diff, confinePath: confine });
    const graphBuilder = new ImportGraphBuilder({ source, limits });
    impact = new ImpactService({ changes, graphBuilder, limits });
    tests = new TestDiscoveryService({ changes, graphBuilder, source, limits });
  });

  afterEach(async () => {
    await repo.cleanup();
  });

  const request = { includeUntracked: true, limit: 50, offset: 0, depth: 3, includeTests: true } as const;

  it('follows git changes through relative imports and aliases; changed files such as untracked ones are not reported as impacted', async () => {
    await repo.write('src/util.ts', 'export const util = 2;\n');
    await repo.write('src/brand-new.ts', "import { util } from './util';\nexport const n = util;\n");

    const result = await impact.analyze(request);

    expect(result.selection).toMatchObject({ source: 'git', mode: 'workingTree' });
    expect(result.impacted.map((file) => [file.path, file.depth])).toEqual([
      ['src/service.ts', 1],
      ['src/app.ts', 2],
      ['tests/service.test.ts', 2],
    ]);
    expect(result.impacted.find((file) => file.path === 'src/app.ts')?.via).toEqual(['src/util.ts', 'src/service.ts']);
    expect(result.changed).toEqual({ total: 2, sourceFiles: 2, otherFiles: 0 });
  });

  it('ignores git-ignored files and node_modules', async () => {
    await repo.write('src/util.ts', 'export const util = 2;\n');

    const result = await impact.analyze(request);

    expect(result.impacted.map((file) => file.path)).not.toContain('src/ignored.ts');
    expect(result.impacted.map((file) => file.path).join()).not.toContain('node_modules');
  });

  it('finds importers of a file that was deleted from the working tree', async () => {
    await repo.remove('src/util.ts');

    const result = await impact.analyze({ ...request, depth: 1 });

    expect(result.impacted.map((file) => file.path)).toEqual(['src/service.ts']);
    expect(result.impacted[0]?.via).toEqual(['src/util.ts']);
  });

  it('accepts explicit files and rejects mixing them with git options', async () => {
    const result = await impact.analyze({ ...request, files: ['src/service.ts'], mode: undefined });

    expect(result.selection).toEqual({ source: 'files', files: ['src/service.ts'] });
    expect(result.impacted.map((file) => file.path)).toEqual(['src/app.ts', 'tests/service.test.ts']);

    await expect(impact.analyze({ ...request, files: ['src/service.ts'], mode: 'staged' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(impact.analyze({ ...request, files: ['../outside.ts'] })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_WORKSPACE' });
  });

  it('maps changed files to tests, flags files without tests and suggests a command', async () => {
    await repo.write('src/service.ts', "import { util } from './util.js';\nexport const service = util + 1;\n");
    await repo.write('src/orphan.ts', 'export const orphan = 2;\n');

    const result = await tests.discover({ ...request, depth: 2 });

    expect(result.frameworks.map((framework) => framework.name)).toEqual(['vitest']);
    expect(result.mapping.map((entry) => [entry.file, entry.tests.map((test) => test.path)])).toEqual([
      ['src/orphan.ts', []],
      ['src/service.ts', ['tests/service.test.ts']],
    ]);
    expect(result.untested).toEqual({ total: 1, paths: ['src/orphan.ts'] });
    expect(result.suggestedCommands).toEqual([{ framework: 'vitest', command: 'npx vitest run tests/service.test.ts', files: 1, omittedFiles: 0 }]);
  });
});
