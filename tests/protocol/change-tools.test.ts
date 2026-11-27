import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/server.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { createLogger } from '../../src/shared/logger.js';
import { riskOutputSchema } from '../../src/tools/assess-risk.tool.js';
import { reviewOutputSchema } from '../../src/tools/review-changes.tool.js';
import { impactOutputSchema } from '../../src/tools/analyze-change-impact.tool.js';
import { testDiscoveryOutputSchema } from '../../src/tools/discover-tests.tool.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

async function connect(workspaceRoot: string) {
  const logger = createLogger({ level: 'error', write: () => {} });
  const server = createServer({ config: { workspaceRoot }, logger });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'devguard-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (result: { content?: unknown }): string =>
  ((result.content as { text?: string }[] | undefined)?.[0]?.text ?? '');

describe('impact and test tools over the protocol', () => {
  let repo: FixtureRepo;
  let connection: Awaited<ReturnType<typeof connect>>;

  beforeEach(async () => {
    repo = await createFixtureRepo({ commit: false });
    await repo.write('package.json', JSON.stringify({ devDependencies: { vitest: '1.0.0' } }));
    await repo.write('src/util.ts', 'export const util = 1;\n');
    await repo.write('src/service.ts', "import { util } from './util';\nexport const service = util;\n");
    await repo.write('src/lonely.ts', 'export const lonely = 1;\n');
    await repo.write('tests/service.test.ts', "import { describe } from 'vitest';\nimport { service } from '../src/service';\n");
    await repo.git('add', '-A');
    await repo.git('commit', '-q', '-m', 'init');
    connection = await connect(repo.root);
  });

  afterEach(async () => {
    await connection.close();
    await repo.cleanup();
  });

  it('analyze_change_impact returns validated, heuristic results with limitations', async () => {
    await repo.write('src/util.ts', 'export const util = 2;\n');

    const result = await connection.client.callTool({ name: 'analyze_change_impact', arguments: {} });

    expect(result.isError).not.toBe(true);
    const impact = impactOutputSchema.parse(result.structuredContent);
    expect(impact.precision).toBe('heuristic');
    expect(impact.impacted.map((file) => file.path)).toEqual(['src/service.ts', 'tests/service.test.ts']);
    expect(impact.limitations.length).toBeGreaterThan(5);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('discover_tests maps changes to tests and lists files without tests', async () => {
    await repo.write('src/service.ts', "import { util } from './util';\nexport const service = util + 1;\n");
    await repo.write('src/lonely.ts', 'export const lonely = 2;\n');

    const result = await connection.client.callTool({ name: 'discover_tests', arguments: {} });

    expect(result.isError).not.toBe(true);
    const discovery = testDiscoveryOutputSchema.parse(result.structuredContent);
    expect(discovery.frameworks.map((framework) => framework.name)).toEqual(['vitest']);
    expect(discovery.untested.paths).toEqual(['src/lonely.ts']);
    expect(discovery.affectedTests.paths).toEqual(['tests/service.test.ts']);
    expect(discovery.suggestedCommands[0]?.command).toBe('npx vitest run tests/service.test.ts');
  });

  it('assess_risk returns an explainable, validated assessment with recommendations', async () => {
    await repo.write('src/service.ts', "import { util } from './util';\nexport const service = util + 1;\n");
    await repo.write('src/lonely.ts', 'export const lonely = 2;\n');

    const result = await connection.client.callTool({ name: 'assess_risk', arguments: {} });

    expect(result.isError).not.toBe(true);
    const risk = riskOutputSchema.parse(result.structuredContent);
    expect(risk.precision).toBe('heuristic');
    expect(risk.factors.map((factor) => factor.id)).toEqual([
      'change_size',
      'change_spread',
      'blast_radius',
      'test_coverage_gap',
      'critical_paths',
      'change_kinds',
    ]);
    expect(risk.coverage).toBe(1);
    expect(risk.recommendations.join('\n')).toContain('src/lonely.ts');
    expect(risk.factors.every((factor) => factor.evidence.length > 0)).toBe(true);
    const total = risk.factors.reduce((sum, factor) => sum + (factor.contribution ?? 0), 0);
    expect(Math.abs(total - risk.overallScore)).toBeLessThanOrEqual(1);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('serves many parallel calls through the concurrency gate without losing any', async () => {
    await repo.write('src/util.ts', 'export const util = 2;\n');
    const names = ['analyze_git_diff', 'analyze_change_impact', 'discover_tests', 'assess_risk', 'analyze_git_diff', 'assess_risk'];

    const results = await Promise.all(names.map((name) => connection.client.callTool({ name, arguments: {} })));

    expect(results.map((result) => result.isError === true)).toEqual(names.map(() => false));
  });

  it('reports increasing progress for analyses when the client asks for it', async () => {
    const updates: { progress: number; total?: number | undefined }[] = [];

    await connection.client.callTool({ name: 'analyze_change_impact', arguments: {} }, { onprogress: (update) => updates.push(update) });

    expect(updates.length).toBeGreaterThanOrEqual(2);
    updates.slice(1).forEach((update, index) => expect(update.progress).toBeGreaterThan(updates[index]?.progress ?? Infinity));
    expect(updates[updates.length - 1]).toMatchObject({ progress: 3, total: 3 });
  });

  it('offers the review prompt and validates its base argument', async () => {
    const { prompts } = await connection.client.listPrompts();
    expect(prompts.map((prompt) => prompt.name)).toEqual(['review_my_changes']);

    const textOfPrompt = (result: Awaited<ReturnType<typeof connection.client.getPrompt>>): string =>
      (result.messages[0]?.content as { text?: string } | undefined)?.text ?? '';

    const plain = textOfPrompt(await connection.client.getPrompt({ name: 'review_my_changes', arguments: {} }));
    for (const tool of ['analyze_git_diff', 'review_changes', 'analyze_change_impact', 'discover_tests', 'assess_risk']) expect(plain).toContain(tool);
    expect(plain).not.toContain('mode "range"');

    const range = textOfPrompt(await connection.client.getPrompt({ name: 'review_my_changes', arguments: { base: 'main' } }));
    expect(range).toContain('mode "range" with base "main"');

    await expect(connection.client.getPrompt({ name: 'review_my_changes', arguments: { base: '--output=x' } })).rejects.toThrow();
  });

  it('review_changes returns validated findings with masked evidence', async () => {
    const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
    await repo.write('src/service.ts', `import { util } from './util';\nexport const service = eval("1");\nconst key = '${awsKey}';\n`);

    const result = await connection.client.callTool({ name: 'review_changes', arguments: { minSeverity: 'error' } });

    expect(result.isError).not.toBe(true);
    const review = reviewOutputSchema.parse(result.structuredContent);
    expect(review.findings.map((finding) => `${finding.rule}:${finding.file}:${finding.line}`)).toEqual([
      'dangerous-eval:src/service.ts:2',
      'secret-aws-access-key:src/service.ts:3',
    ]);
    expect(review.precision).toBe('heuristic');
    expect(JSON.stringify(result)).not.toContain(awsKey);
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it.each([
    ['review_changes', { mode: 'range' }, 'INVALID_INPUT:'],
    ['review_changes', { mode: 'range', base: '--output=x' }, 'INVALID_REF:'],
    ['review_changes', { paths: ['../x'] }, 'PATH_OUTSIDE_WORKSPACE:'],
  ])('%s reports a readable error for %j', async (name, args, prefix) => {
    const result = await connection.client.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(prefix)).toBe(true);
  });

  it('assess_risk with explicit files marks the git-based factors as unavailable', async () => {
    const result = await connection.client.callTool({ name: 'assess_risk', arguments: { files: ['src/service.ts'] } });

    const risk = riskOutputSchema.parse(result.structuredContent);
    expect(risk.selection).toEqual({ source: 'files', files: ['src/service.ts'] });
    expect(risk.coverage).toBe(0.7);
    expect(risk.confidence).toBe('low');
    expect(risk.factors.filter((factor) => factor.status === 'unavailable').map((factor) => factor.id)).toEqual(['change_size', 'change_kinds']);
  });

  it.each([
    ['analyze_change_impact', { files: ['src/util.ts'], mode: 'staged' }, 'INVALID_INPUT:'],
    ['assess_risk', { files: ['src/util.ts'], mode: 'staged' }, 'INVALID_INPUT:'],
    ['assess_risk', { mode: 'range', base: '--output=x' }, 'INVALID_REF:'],
    ['analyze_change_impact', { files: ['../outside.ts'] }, 'PATH_OUTSIDE_WORKSPACE:'],
    ['discover_tests', { mode: 'range' }, 'INVALID_INPUT:'],
    ['discover_tests', { mode: 'range', base: '--output=x' }, 'INVALID_REF:'],
  ])('%s reports a readable error for %j', async (name, args, prefix) => {
    const result = await connection.client.callTool({ name, arguments: args });

    expect(result.isError).toBe(true);
    expect(textOf(result).startsWith(prefix)).toBe(true);
  });

  it('rejects arguments outside the input schema', async () => {
    for (const [name, args] of [
      ['analyze_change_impact', { depth: 0 }],
      ['analyze_change_impact', { depth: 4 }],
      ['analyze_change_impact', { files: Array(101).fill('a.ts') }],
      ['discover_tests', { unknown: 1 }],
      ['discover_tests', { includeTests: true }],
      ['assess_risk', { limit: 10 }],
      ['assess_risk', { depth: 9 }],
      ['review_changes', { files: ['src/a.ts'] }],
      ['review_changes', { minSeverity: 'fatal' }],
      ['review_changes', { categories: ['style'] }],
      ['review_changes', { depth: 2 }],
    ] as const) {
      const result = await connection.client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
    }
  });
});

describe('impact tool on a large change set', () => {
  it('keeps the response within the budget and pages through hundreds of importers', async () => {
    const repo = await createFixtureRepo({ commit: false });
    const connection = await connect(repo.root);
    try {
      await repo.write('src/core.ts', 'export const core = 1;\n');
      await mkdir(path.join(repo.root, 'src', 'consumers'), { recursive: true });
      for (let index = 0; index < 300; index++) {
        await writeFile(path.join(repo.root, 'src', 'consumers', `consumer-module-${String(index).padStart(4, '0')}.ts`), "import '../core';\n");
      }
      await repo.git('add', '-A');
      await repo.git('commit', '-q', '-m', 'init');
      await repo.write('src/core.ts', 'export const core = 2;\n');

      const first = await connection.client.callTool({ name: 'analyze_change_impact', arguments: { limit: 200, depth: 1 } });
      const firstImpact = impactOutputSchema.parse(first.structuredContent);

      expect(Buffer.byteLength(textOf(first), 'utf8')).toBeLessThanOrEqual(DEFAULT_LIMITS.maxResponseBytes);
      expect(firstImpact.summary.impacted).toBe(300);
      expect(firstImpact.truncation).toMatchObject({ truncated: true, reason: 'BYTE_BUDGET', total: 300 });

      const second = await connection.client.callTool({
        name: 'analyze_change_impact',
        arguments: { limit: 200, depth: 1, offset: firstImpact.truncation.nextOffset },
      });
      const secondImpact = impactOutputSchema.parse(second.structuredContent);
      expect(secondImpact.impacted.some((file) => firstImpact.impacted.some((other) => other.path === file.path))).toBe(false);

      const risk = await connection.client.callTool({ name: 'assess_risk', arguments: { depth: 1 } });
      const assessment = riskOutputSchema.parse(risk.structuredContent);
      expect(Buffer.byteLength(textOf(risk), 'utf8')).toBeLessThanOrEqual(DEFAULT_LIMITS.maxResponseBytes);
      expect(assessment.factors.find((factor) => factor.id === 'blast_radius')?.metrics).toMatchObject({ impactedFiles: 300 });
    } finally {
      await connection.close();
      await repo.cleanup();
    }
  });

  it('refuses a folder that is not a git repository, because files are listed through git', async () => {
    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-plain-')));
    const connection = await connect(plain);
    try {
      const result = await connection.client.callTool({ name: 'discover_tests', arguments: {} });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^NOT_A_GIT_REPO:/);
    } finally {
      await connection.close();
      await rm(plain, { recursive: true, force: true });
    }
  });
});
