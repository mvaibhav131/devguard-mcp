import { describe, expect, it } from 'vitest';

import { ImpactService } from '../../src/core/impact/impact.service.js';
import { walkImporters } from '../../src/core/impact/import-graph.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';
import { defaultRequest, FakeSource, graphBuilderFor, resolverFor, SAMPLE_PROJECT } from '../fixtures/fake-source.js';

function createService(files: Record<string, string>, changed: Parameters<typeof resolverFor>[0], limits: Partial<Limits> = {}) {
  const source = new FakeSource(files);
  const merged = { ...DEFAULT_LIMITS, ...limits };
  return new ImpactService({ changes: resolverFor(changed), graphBuilder: graphBuilderFor(source, limits), limits: merged });
}

const explicit = (...paths: string[]) => paths.map((path) => ({ path, status: 'explicit' as const }));

describe('ImportGraphBuilder', () => {
  it('builds edges, resolves aliases and NodeNext specifiers, and classifies the rest', async () => {
    const graph = await graphBuilderFor(new FakeSource(SAMPLE_PROJECT)).build({ extraKnown: new Set() });

    expect(graph.importers.get('src/a.ts')).toEqual(['src/a.test.ts', 'src/alias.ts', 'src/b.ts']);
    expect(graph.imports.get('src/uses-type.ts')).toEqual([{ to: 'src/types.ts', typeOnly: true, kind: 'import' }]);
    expect(graph.aliases).toMatchObject({ baseUrl: '', paths: [{ pattern: '@/*', targets: ['src/*'] }] });
    expect(graph.externals.get('src/a.test.ts')).toEqual(['vitest']);
    expect(graph.unresolved).toEqual([{ importer: 'src/messy.ts', specifier: './nope', reason: 'file-not-found' }]);
    expect(graph.stats).toMatchObject({ externalImports: 2, assetImports: 1, nonLiteralDynamicImports: 1, limited: false });
    expect(graph.files.has('README.md')).toBe(false);
    expect(graph.allPaths.has('README.md')).toBe(true);
  });

  it('skips unreadable files and reports the cap on analysed files', async () => {
    const source = new FakeSource({ 'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '' }, { 'src/big.ts': 'too-large', 'src/bin.ts': 'binary' });

    const graph = await graphBuilderFor(source, { maxSourceFiles: 3 }).build({ extraKnown: new Set() });

    expect(graph.stats.sourceFilesListed).toBe(5);
    expect(graph.stats.limited).toBe(true);
    expect(graph.stats.limitedReasons[0]).toContain('More than 3 source files');
    expect(graph.stats.sourceFilesRead + graph.stats.skipped['too-large'] + graph.stats.skipped.binary).toBe(3);
  });

  it('walks importers breadth first with the shortest chain and respects the depth', async () => {
    const graph = await graphBuilderFor(new FakeSource(SAMPLE_PROJECT)).build({ extraKnown: new Set() });

    const hits = walkImporters(graph, ['src/a.ts'], 3, new Set(['src/a.ts']));

    expect(hits.get('src/b.ts')).toEqual({ depth: 1, via: ['src/a.ts'] });
    expect(hits.get('src/c.ts')).toEqual({ depth: 2, via: ['src/a.ts', 'src/b.ts'] });
    expect(hits.get('src/d.ts')).toEqual({ depth: 3, via: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
    expect(walkImporters(graph, ['src/a.ts'], 1, new Set(['src/a.ts'])).has('src/c.ts')).toBe(false);
  });
});

describe('ImpactService', () => {
  it('reports direct and transitive importers with chains, hotspots and the heuristic caveats', async () => {
    const service = createService(SAMPLE_PROJECT, explicit('src/a.ts'));

    const result = await service.analyze({ ...defaultRequest, depth: 2, includeTests: true });

    expect(result.precision).toBe('heuristic');
    expect(result.impacted).toEqual([
      { path: 'src/a.test.ts', relation: 'direct', depth: 1, via: ['src/a.ts'], isTest: true },
      { path: 'src/alias.ts', relation: 'direct', depth: 1, via: ['src/a.ts'], isTest: false },
      { path: 'src/b.ts', relation: 'direct', depth: 1, via: ['src/a.ts'], isTest: false },
      { path: 'src/c.ts', relation: 'transitive', depth: 2, via: ['src/a.ts', 'src/b.ts'], isTest: false },
    ]);
    expect(result.summary).toEqual({ impacted: 4, direct: 3, transitive: 1, tests: 1 });
    expect(result.hotspots).toEqual([{ path: 'src/a.ts', directImporters: 3 }]);
    expect(result.changed).toEqual({ total: 1, sourceFiles: 1, otherFiles: 0 });
    expect(result.limitations.some((line) => line.startsWith('Heuristic'))).toBe(true);
    expect(result.limitations.some((line) => line.includes('Barrel files'))).toBe(true);
    expect(result.truncation.truncated).toBe(false);
  });

  it('can exclude tests, go deeper and reports only unresolved imports of changed files', async () => {
    const deeper = await createService(SAMPLE_PROJECT, explicit('src/a.ts')).analyze({ ...defaultRequest, depth: 3, includeTests: false });
    expect(deeper.impacted.map((file) => file.path)).toEqual(['src/alias.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'tests/c.test.ts'].filter((path) => !path.includes('.test.')));

    const messy = await createService(SAMPLE_PROJECT, explicit('src/messy.ts')).analyze({ ...defaultRequest, depth: 2, includeTests: true });
    expect(messy.unresolved).toEqual({ total: 1, items: [{ importer: 'src/messy.ts', specifier: './nope', reason: 'file-not-found' }] });
    expect(messy.limitations.join('\n')).toContain('computed arguments');
    expect(messy.limitations.join('\n')).toContain('could not be resolved');
  });

  it('finds importers of deleted and renamed files', async () => {
    const files = { ...SAMPLE_PROJECT, 'src/user.ts': "import './gone';\n", 'src/legacy-user.ts': "import './old-name';\n", 'src/new-name.ts': '' };
    const service = createService(files, [
      { path: 'src/gone.ts', status: 'deleted' },
      { path: 'src/new-name.ts', oldPath: 'src/old-name.ts', status: 'renamed' },
    ]);

    const result = await service.analyze({ ...defaultRequest, depth: 1, includeTests: true });

    expect(result.impacted.map((file) => [file.path, file.via])).toEqual([
      ['src/legacy-user.ts', ['src/old-name.ts']],
      ['src/user.ts', ['src/gone.ts']],
    ]);
  });

  it('says so when no changed file is a source file', async () => {
    const result = await createService(SAMPLE_PROJECT, explicit('README.md')).analyze({ ...defaultRequest, depth: 2, includeTests: true });

    expect(result.impacted).toEqual([]);
    expect(result.changed).toEqual({ total: 1, sourceFiles: 0, otherFiles: 1 });
    expect(result.limitations.join('\n')).toContain('None of the changed files is a TypeScript or JavaScript source file');
  });

  it('pages impacted files within the response budget', async () => {
    const files: Record<string, string> = { 'src/core.ts': 'export const x = 1;\n' };
    for (let index = 0; index < 120; index++) files[`src/consumers/consumer-number-${String(index).padStart(3, '0')}.ts`] = "import '../core';\n";
    const service = createService(files, explicit('src/core.ts'), { maxResponseBytes: 6_000 });

    const first = await service.analyze({ ...defaultRequest, limit: 200, depth: 1, includeTests: true });
    const second = await service.analyze({ ...defaultRequest, limit: 200, offset: first.truncation.nextOffset ?? -1, depth: 1, includeTests: true });

    expect(first.truncation).toMatchObject({ truncated: true, reason: 'BYTE_BUDGET', total: 120 });
    expect(first.summary.impacted).toBe(120);
    expect(Buffer.byteLength(JSON.stringify(first), 'utf8')).toBeLessThan(7_000);
    expect(second.impacted[0]?.path).not.toBe(first.impacted[0]?.path);
    expect(first.impacted.length + second.impacted.length).toBeGreaterThan(first.impacted.length);
  });
});
