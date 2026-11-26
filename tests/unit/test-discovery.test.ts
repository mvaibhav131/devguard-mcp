import { describe, expect, it } from 'vitest';

import { TestDiscoveryService } from '../../src/core/tests/test-discovery.service.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { defaultRequest, FakeSource, graphBuilderFor, resolverFor, SAMPLE_PROJECT } from '../fixtures/fake-source.js';

function createService(files: Record<string, string>, changed: Parameters<typeof resolverFor>[0]) {
  const source = new FakeSource(files);
  return new TestDiscoveryService({ changes: resolverFor(changed), graphBuilder: graphBuilderFor(source), source, limits: DEFAULT_LIMITS });
}

const modified = (...paths: string[]) => paths.map((path) => ({ path, status: 'modified' as const }));

describe('TestDiscoveryService', () => {
  it('detects the framework and its evidence', async () => {
    const result = await createService(SAMPLE_PROJECT, modified('src/a.ts')).discover({ ...defaultRequest, depth: 2 });

    expect(result.frameworks).toEqual([
      {
        name: 'vitest',
        evidence: [
          'package.json lists "vitest"',
          'package.json script "test": "vitest run"',
          'configuration file vitest.config.ts',
          'test files import "vitest"',
        ],
      },
    ]);
  });

  it('maps changed source files to tests by import distance and by name, and flags files without tests', async () => {
    const result = await createService(SAMPLE_PROJECT, modified('src/a.ts', 'src/b.ts', 'src/lonely.ts', 'README.md')).discover({
      ...defaultRequest,
      depth: 2,
    });

    expect(result.mapping).toEqual([
      { file: 'src/a.ts', status: 'modified', moreTests: 0, tests: [{ path: 'src/a.test.ts', framework: 'vitest', evidence: 'imports-directly', depth: 1 }] },
      { file: 'src/b.ts', status: 'modified', moreTests: 0, tests: [{ path: 'tests/c.test.ts', framework: 'vitest', evidence: 'imports-transitively', depth: 2 }] },
      { file: 'src/lonely.ts', status: 'modified', moreTests: 0, tests: [] },
    ]);
    expect(result.untested).toEqual({ total: 1, paths: ['src/lonely.ts'] });
    expect(result.summary).toEqual({ changedSourceFiles: 3, withTests: 2, withoutTests: 1, affectedTestFiles: 2 });
    expect(result.changed).toEqual({ total: 4, sourceFiles: 3, testFiles: 0, otherFiles: 1 });
    expect(result.affectedTests.paths).toEqual(['src/a.test.ts', 'tests/c.test.ts']);
    expect(result.suggestedCommands).toEqual([
      { framework: 'vitest', command: 'npx vitest run src/a.test.ts tests/c.test.ts', files: 2, omittedFiles: 0 },
    ]);
    expect(result.limitations.join('\n')).toContain('never executed');
  });

  it('matches by file name when nothing imports the source, and counts changed tests as affected', async () => {
    const files = { ...SAMPLE_PROJECT, 'src/lonely.ts': 'x', 'tests/lonely.spec.ts': "describe('x', () => {});\n" };

    const result = await createService(files, modified('src/lonely.ts', 'tests/lonely.spec.ts')).discover({ ...defaultRequest, depth: 2 });

    expect(result.mapping[0]?.tests).toEqual([{ path: 'tests/lonely.spec.ts', framework: 'vitest', evidence: 'name-match' }]);
    expect(result.changed).toMatchObject({ sourceFiles: 1, testFiles: 1 });
    expect(result.untested.total).toBe(0);
    expect(result.affectedTests.paths).toEqual(['tests/lonely.spec.ts']);
  });

  it('does not flag deleted files as untested but still maps tests that import them', async () => {
    const files = { ...SAMPLE_PROJECT, 'tests/gone.test.ts': "import './gone';\n" };

    const result = await createService(files, [{ path: 'src/gone.ts', status: 'deleted' }]).discover({ ...defaultRequest, depth: 1 });

    expect(result.untested.total).toBe(0);
    expect(result.mapping[0]?.tests.map((test) => test.path)).toEqual(['tests/gone.test.ts']);
  });

  it('works without any test files or package.json', async () => {
    const result = await createService({ 'src/a.ts': 'export {};\n' }, modified('src/a.ts')).discover({ ...defaultRequest, depth: 2 });

    expect(result.frameworks).toEqual([]);
    expect(result.untested).toEqual({ total: 1, paths: ['src/a.ts'] });
    expect(result.suggestedCommands).toEqual([]);
    expect(result.limitations.join('\n')).toContain('No test files');
  });
});
