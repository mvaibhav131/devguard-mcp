import { mkdtemp, realpath, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createServer } from '../../src/server.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';
import { createLogger } from '../../src/shared/logger.js';
import { diffAnalysisOutputSchema } from '../../src/tools/analyze-git-diff.tool.js';
import { projectInfoOutputSchema } from '../../src/tools/get-project-info.tool.js';
import { TOOL_NAMES } from '../../src/tools/tool-names.js';
import { createFixtureRepo, type FixtureRepo } from '../fixtures/fixture-repo.js';

interface Connection {
  client: Client;
  close(): Promise<void>;
}

async function connect(workspaceRoot: string, limits: Partial<Limits> = {}): Promise<Connection> {
  const logger = createLogger({ level: 'error', write: () => {} });
  const server = createServer({ config: { workspaceRoot }, logger, limits });
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

function textOf(result: { content?: unknown }): string {
  const first = (result.content as { type: string; text?: string }[] | undefined)?.[0];
  return first?.type === 'text' ? (first.text ?? '') : '';
}

describe('DevGuard MCP server over the protocol', () => {
  let repo: FixtureRepo;
  let connection: Connection;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    connection = await connect(repo.root);
  });

  afterEach(async () => {
    await connection.close();
    await repo.cleanup();
  });

  it('advertises read-only tools with input and output schemas', async () => {
    const { tools } = await connection.client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
      expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it('get_project_info confirms connectivity and the workspace', async () => {
    const result = await connection.client.callTool({ name: 'get_project_info', arguments: {} });

    expect(result.isError).not.toBe(true);
    const info = projectInfoOutputSchema.parse(result.structuredContent);
    expect(info).toMatchObject({
      server: { name: 'devguard-mcp' },
      workspace: { name: path.basename(repo.root), isGitRepo: true, isRepoRoot: true, branch: 'main', detached: false },
      git: { available: true },
      languageScope: ['typescript', 'javascript'],
      tools: [...TOOL_NAMES],
    });
    expect(JSON.stringify(result)).not.toContain(repo.root.replaceAll('\\', '\\\\'));
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('analyze_git_diff returns the structured analysis and the same JSON as text', async () => {
    await repo.write('src/a.ts', 'export const a = 100;\n');
    await repo.write('src/new.ts', 'export const n = 1;\n');

    const result = await connection.client.callTool({ name: 'analyze_git_diff', arguments: {} });

    expect(result.isError).not.toBe(true);
    const analysis = diffAnalysisOutputSchema.parse(result.structuredContent);
    expect(analysis.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/new.ts']);
    expect(analysis.summary).toMatchObject({ filesChanged: 2, additions: 1, deletions: 2 });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it.each([
    ['mode range without base', { mode: 'range' }, 'INVALID_INPUT:'],
    ['an unknown ref', { mode: 'range', base: 'no-such-branch' }, 'INVALID_REF:'],
    ['an option-like ref', { mode: 'range', base: '--output=leak' }, 'INVALID_REF:'],
    ['path traversal', { paths: ['../secret'] }, 'PATH_OUTSIDE_WORKSPACE:'],
  ])('reports %s as a readable tool error', async (_name, args, expectedPrefix) => {
    const result = await connection.client.callTool({ name: 'analyze_git_diff', arguments: args });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(new RegExp(`^${expectedPrefix}.*`));
  });

  it('rejects arguments that violate the input schema before any code runs', async () => {
    for (const args of [{ limit: 0 }, { limit: 1000 }, { unknown: true }, { paths: Array(21).fill('a') }, { mode: 'everything' }]) {
      const result = await connection.client.callTool({ name: 'analyze_git_diff', arguments: args });
      expect(result.isError).toBe(true);
    }
  });
});

describe('DevGuard MCP server in other workspaces', () => {
  it('get_project_info reports a folder that is not a git repository, and analysis refuses it', async () => {
    const plain = await realpath(await mkdtemp(path.join(tmpdir(), 'devguard-plain-')));
    const connection = await connect(plain);
    try {
      const info = projectInfoOutputSchema.parse((await connection.client.callTool({ name: 'get_project_info', arguments: {} })).structuredContent);
      expect(info.workspace).toMatchObject({ isGitRepo: false, branch: null, headShortSha: null });
      expect(info.git.available).toBe(true);

      const analysis = await connection.client.callTool({ name: 'analyze_git_diff', arguments: {} });
      expect(analysis.isError).toBe(true);
      expect(textOf(analysis)).toMatch(/^NOT_A_GIT_REPO:/);
    } finally {
      await connection.close();
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('keeps a very large change set within the response budget and pages through it', async () => {
    const repo = await createFixtureRepo();
    const connection = await connect(repo.root);
    try {
      await mkdir(path.join(repo.root, 'generated'));
      for (let index = 0; index < 300; index++) {
        await writeFile(path.join(repo.root, 'generated', `module-number-${String(index).padStart(4, '0')}.ts`), 'x\n');
      }

      const first = await connection.client.callTool({ name: 'analyze_git_diff', arguments: { limit: 200 } });
      const firstAnalysis = diffAnalysisOutputSchema.parse(first.structuredContent);

      expect(Buffer.byteLength(textOf(first), 'utf8')).toBeLessThanOrEqual(DEFAULT_LIMITS.maxResponseBytes);
      expect(firstAnalysis.summary.filesChanged).toBe(300);
      expect(firstAnalysis.truncation).toMatchObject({ truncated: true, reason: 'BYTE_BUDGET', total: 300 });
      expect(firstAnalysis.truncation.hint).toContain('offset=');

      const next = await connection.client.callTool({
        name: 'analyze_git_diff',
        arguments: { limit: 200, offset: firstAnalysis.truncation.nextOffset },
      });
      const nextAnalysis = diffAnalysisOutputSchema.parse(next.structuredContent);
      const overlap = firstAnalysis.files.filter((file) => nextAnalysis.files.some((other) => other.path === file.path));
      expect(overlap).toEqual([]);
    } finally {
      await connection.close();
      await repo.cleanup();
    }
  });
});
