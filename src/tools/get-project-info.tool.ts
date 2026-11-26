import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { ProjectInfoService } from '../core/project/project-info.service.js';
import { GET_PROJECT_INFO } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const inputSchema = z.strictObject({});

export const projectInfoOutputSchema = z.object({
  schemaVersion: z.literal(1),
  server: z.object({ name: z.string(), version: z.string() }),
  runtime: z.object({ node: z.string(), platform: z.string() }),
  workspace: z.object({
    name: z.string(),
    isGitRepo: z.boolean(),
    isRepoRoot: z.boolean(),
    branch: z.string().nullable(),
    headShortSha: z.string().nullable(),
    detached: z.boolean(),
  }),
  git: z.object({ available: z.boolean(), version: z.string().nullable(), error: z.string().optional() }),
  languageScope: z.array(z.string()),
  effectiveLimits: z.object({
    maxResponseBytes: z.number(),
    gitTimeoutMs: z.number(),
    toolTimeoutMs: z.number(),
    maxFilesScanned: z.number(),
    maxHunksPerFile: z.number(),
    maxSourceFiles: z.number(),
    maxSourceFileBytes: z.number(),
    defaultPageSize: z.number(),
    maxPageSize: z.number(),
  }),
  tools: z.array(z.string()),
});

export function registerGetProjectInfoTool(server: McpServer, deps: ToolRuntime & { service: ProjectInfoService }): void {
  server.registerTool(
    GET_PROJECT_INFO,
    {
      title: 'Get project info',
      description:
        'Returns basic facts about the workspace DevGuard is analysing: server version, Node.js runtime, git availability and version, ' +
        'current branch and HEAD commit, the supported languages (TypeScript and JavaScript) and the active response limits. ' +
        'Read-only. Call this first to confirm that DevGuard is connected and pointed at the right repository.',
      inputSchema,
      outputSchema: projectInfoOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(GET_PROJECT_INFO, deps, (_args, signal) => deps.service.getInfo(signal)),
  );
}
