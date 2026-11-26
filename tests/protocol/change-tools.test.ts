import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/server.js';
import { DEFAULT_LIMITS } from '../../src/shared/limits.js';
import { createLogger } from '../../src/shared/logger.js';
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

  it.each([
    ['analyze_change_impact', { files: ['src/util.ts'], mode: 'staged' }, 'INVALID_INPUT:'],
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
