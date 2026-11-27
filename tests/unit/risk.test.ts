import { describe, expect, it } from 'vitest';

import { ImpactService } from '../../src/core/impact/impact.service.js';
import type { ChangedFile } from '../../src/core/impact/change-set.js';
import { bandFor, criticalCategory, RISK_BANDS, RISK_WEIGHTS, scale } from '../../src/core/risk/risk-model.js';
import { RiskService, type RiskRequest } from '../../src/core/risk/risk.service.js';
import { TestDiscoveryService } from '../../src/core/tests/test-discovery.service.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';
import { FakeSource, graphBuilderFor, resolverFor, SAMPLE_PROJECT } from '../fixtures/fake-source.js';

function createService(files: Record<string, string>, changed: ChangedFile[], limits: Partial<Limits> = {}): RiskService {
  const source = new FakeSource(files);
  const merged = { ...DEFAULT_LIMITS, ...limits };
  const changes = resolverFor(changed);
  const graphBuilder = graphBuilderFor(source, limits);
  return new RiskService({
    changes,
    graphBuilder,
    impact: new ImpactService({ changes, graphBuilder, limits: merged }),
    tests: new TestDiscoveryService({ changes, graphBuilder, source, limits: merged }),
    limits: merged,
  });
}

const request: RiskRequest = { includeUntracked: true, depth: 2 };
const modified = (path: string, additions = 1, deletions = 0): ChangedFile => ({ path, status: 'modified', additions, deletions });
const factorOf = (result: Awaited<ReturnType<RiskService['assess']>>, id: string) => {
  const factor = result.factors.find((entry) => entry.id === id);
  if (!factor) throw new Error(`missing factor ${id}`);
  return factor;
};

describe('risk model', () => {
  it('uses weights that add up to one and bands that cover 0 to 100 without gaps', () => {
    expect(Object.values(RISK_WEIGHTS).reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 10);

    expect(RISK_BANDS[0]?.min).toBe(0);
    expect(RISK_BANDS[RISK_BANDS.length - 1]?.max).toBe(100);
    RISK_BANDS.slice(1).forEach((band, index) => expect(band.min).toBe((RISK_BANDS[index]?.max ?? -1) + 1));
  });

  it.each([
    [0, 'low'],
    [24, 'low'],
    [25, 'medium'],
    [49, 'medium'],
    [50, 'high'],
    [74, 'high'],
    [75, 'critical'],
    [100, 'critical'],
  ])('score %i is %s', (score, band) => {
    expect(bandFor(score)).toBe(band);
  });

  it('scales linearly between the low and high marks and clamps outside', () => {
    expect(scale(20, 20, 800)).toBe(0);
    expect(scale(5, 20, 800)).toBe(0);
    expect(scale(410, 20, 800)).toBe(0.5);
    expect(scale(5000, 20, 800)).toBe(1);
    expect(scale(1, 1, 1)).toBe(0);
  });

  it.each([
    ['package.json', 'dependencies'],
    ['web/pnpm-lock.yaml', 'dependencies'],
    ['.github/workflows/ci.yml', 'ci-cd'],
    ['Dockerfile', 'ci-cd'],
    ['.env.local', 'environment'],
    ['tsconfig.build.json', 'build-config'],
    ['vitest.config.ts', 'build-config'],
    ['src/auth/login.ts', 'security'],
    ['src/crypto-utils.ts', 'security'],
    ['src/db/client.ts', 'database'],
    ['src/billing/invoice.ts', 'payments'],
  ])('%s is a critical path (%s)', (file, category) => {
    expect(criticalCategory(file)).toBe(category);
  });

  it.each([['tests/unit/auth.test.ts'], ['docs/auth.md'], ['src/author.ts'], ['src/tools/selection-schema.ts'], ['src/a.ts']])(
    '%s is not a critical path',
    (file) => {
      expect(criticalCategory(file)).toBeUndefined();
    },
  );
});

describe('RiskService', () => {
  it('rates a small, tested change as low risk and explains every factor', async () => {
    const result = await createService(SAMPLE_PROJECT, [modified('src/a.ts', 5, 2)]).assess(request);

    expect(result.band).toBe('low');
    expect(result.overallScore).toBeLessThan(10);
    expect(result.coverage).toBe(1);
    expect(result.precision).toBe('heuristic');
    expect(result.factors.map((factor) => factor.id)).toEqual([
      'change_size',
      'change_spread',
      'blast_radius',
      'test_coverage_gap',
      'critical_paths',
      'change_kinds',
    ]);
    for (const factor of result.factors) {
      expect(factor.status).toBe('computed');
      expect(factor.evidence.length).toBeGreaterThan(0);
      expect(factor.limitations).toBeDefined();
    }
    expect(factorOf(result, 'change_size')).toMatchObject({ weight: 0.2, normalized: 0, metrics: { additions: 5, deletions: 2, linesChanged: 7 } });
    expect(factorOf(result, 'test_coverage_gap')).toMatchObject({ normalized: 0, metrics: { withoutTests: 0 } });
    expect(factorOf(result, 'blast_radius').metrics).toMatchObject({ impactedFiles: 3, maxDirectImporters: 3 });
    const total = result.factors.reduce((sum, factor) => sum + (factor.contribution ?? 0), 0);
    expect(Math.abs(total - result.overallScore)).toBeLessThanOrEqual(1);
  });

  it('rates a large, wide, untested and sensitive change as critical, with evidence', async () => {
    const files: Record<string, string> = {
      'src/core.ts': 'export const core = 1;\n',
      'src/auth/token.ts': 'export const token = 1;\n',
      'src/conflict.ts': 'export const c = 1;\n',
      'package.json': '{}',
    };
    for (let index = 0; index < 40; index++) files[`src/consumers/consumer-${String(index).padStart(2, '0')}.ts`] = "import '../core';\n";

    const changed: ChangedFile[] = [
      modified('src/core.ts', 900, 200),
      modified('package.json'),
      modified('src/auth/token.ts'),
      { path: 'src/gone.ts', status: 'deleted', additions: 0, deletions: 30 },
      { path: 'src/conflict.ts', status: 'unmerged', additions: 0, deletions: 0 },
    ];
    for (const folder of ['docs', 'config', 'scripts', 'assets', 'infra', 'web']) {
      for (let index = 0; index < 5; index++) changed.push(modified(`${folder}/file-${index}.txt`));
    }

    const result = await createService(files, changed).assess(request);

    expect(result.band).toBe('critical');
    expect(result.overallScore).toBeGreaterThanOrEqual(75);
    expect(factorOf(result, 'change_size').normalized).toBe(1);
    expect(factorOf(result, 'change_spread').normalized).toBe(1);
    expect(factorOf(result, 'blast_radius')).toMatchObject({ normalized: 1, metrics: { impactedFiles: 40 } });
    expect(factorOf(result, 'test_coverage_gap').metrics).toMatchObject({ changedSourceFiles: 4, withoutTests: 3 });
    expect(factorOf(result, 'critical_paths').evidence).toEqual(expect.arrayContaining(['package.json (dependencies)', 'src/auth/token.ts (security)']));
    expect(factorOf(result, 'change_kinds').metrics).toMatchObject({ deleted: 1, unmerged: 1 });
    expect(result.recommendations.join('\n')).toContain('Resolve the merge conflicts in src/conflict.ts');
    expect(result.recommendations.join('\n')).toContain('Add or extend tests for');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(DEFAULT_LIMITS.maxResponseBytes);
  });

  it('reports unavailable factors and lower confidence for an explicit file list', async () => {
    const result = await createService(SAMPLE_PROJECT, []).assess({ ...request, files: ['src/a.ts'] });

    expect(result.selection).toEqual({ source: 'files', files: ['src/a.ts'] });
    expect(factorOf(result, 'change_size')).toMatchObject({ status: 'unavailable', normalized: null, contribution: null });
    expect(factorOf(result, 'change_kinds').status).toBe('unavailable');
    expect(result.coverage).toBe(0.7);
    expect(result.confidence).toBe('low');
    expect(result.recommendations.join('\n')).toContain('Some factors could not be computed');
  });

  it('counts the test gap at 75% when test files changed together with the code', async () => {
    const files = { ...SAMPLE_PROJECT, 'tests/new.test.ts': "describe('x', () => {});\n" };

    const alone = await createService(files, [modified('src/lonely.ts')]).assess(request);
    const withTest = await createService(files, [modified('src/lonely.ts'), modified('tests/new.test.ts')]).assess(request);

    expect(factorOf(alone, 'test_coverage_gap').normalized).toBe(1);
    expect(factorOf(withTest, 'test_coverage_gap').normalized).toBe(0.75);
    expect(factorOf(withTest, 'test_coverage_gap').evidence.join('\n')).toContain('counts 75%');
  });

  it('is deterministic and names the score version', async () => {
    const service = createService(SAMPLE_PROJECT, [modified('src/a.ts', 40, 10), modified('src/b.ts', 3, 3)]);

    const first = await service.assess(request);
    const second = await service.assess(request);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.scoreVersion).toBe(1);
    expect(first.bands).toEqual(RISK_BANDS);
  });

  it('handles an empty change set and non-source changes', async () => {
    const empty = await createService(SAMPLE_PROJECT, []).assess(request);
    expect(empty).toMatchObject({ overallScore: 0, band: 'low', changed: { total: 0 } });

    const docsOnly = await createService(SAMPLE_PROJECT, [modified('README.md', 3, 1)]).assess(request);
    expect(factorOf(docsOnly, 'blast_radius').evidence).toEqual(['No TypeScript or JavaScript source file changed.']);
    expect(docsOnly.band).toBe('low');
  });
});
