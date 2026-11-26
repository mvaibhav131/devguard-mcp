import { spawnSync } from 'node:child_process';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';

import { TOOL_NAMES } from '../../src/tools/tool-names.js';
import { createFixtureRepo } from '../fixtures/fixture-repo.js';

// Runs the compiled server (dist/index.js) as a real child process. Use `npm run test:stdio`, which builds first.
const SERVER_ENTRY = 'dist/index.js';

describe('DevGuard MCP server as a stdio process', () => {
  it('completes the handshake and serves tools without any stray output on stdout', async () => {
    const repo = await createFixtureRepo();
    const client = new Client({ name: 'devguard-stdio-test', version: '0.0.0' });
    try {
      // A single non-JSON-RPC byte on stdout would make connect() or any call below fail.
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY, '--workspace-root', repo.root] }));

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES]);

      const info = await client.callTool({ name: 'get_project_info', arguments: {} });
      expect(info.isError).not.toBe(true);
      expect(info.structuredContent).toMatchObject({ workspace: { isGitRepo: true, branch: 'main' } });

      await repo.write('src/a.ts', 'export const a = 100;\n');
      const diff = await client.callTool({ name: 'analyze_git_diff', arguments: {} });
      expect(diff.structuredContent).toMatchObject({ summary: { filesChanged: 1 } });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  it('fails fast with a structured error on stderr and nothing on stdout when the configuration is invalid', () => {
    const result = spawnSync(process.execPath, [SERVER_ENTRY, '--workspace-root', 'relative/path'], { encoding: 'utf8', timeout: 20_000 });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('CONFIG_INVALID');
  });
});
