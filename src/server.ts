import { McpServer } from '@modelcontextprotocol/server';

import type { Config } from './config/config.js';
import { DiffService } from './core/diff/diff.service.js';
import { ProjectInfoService } from './core/project/project-info.service.js';
import { confinePath } from './infrastructure/fs/workspace-fs.js';
import { GitClient } from './infrastructure/git/git-client.js';
import { GitRunner } from './infrastructure/git/git-runner.js';
import { DEFAULT_LIMITS, type Limits } from './shared/limits.js';
import type { Logger } from './shared/logger.js';
import { SERVER_NAME, SERVER_VERSION } from './shared/version.js';
import { registerAnalyzeGitDiffTool } from './tools/analyze-git-diff.tool.js';
import { registerGetProjectInfoTool } from './tools/get-project-info.tool.js';
import { TOOL_NAMES } from './tools/tool-names.js';

export interface ServerDeps {
  config: Pick<Config, 'workspaceRoot'>;
  logger: Logger;
  limits?: Partial<Limits>;
}

/** Composition root: builds the services once and registers the tools. Stateless between calls. */
export function createServer(deps: ServerDeps): McpServer {
  const { workspaceRoot } = deps.config;
  const { logger } = deps;
  const limits: Limits = { ...DEFAULT_LIMITS, ...deps.limits };

  const git = new GitClient(new GitRunner({ cwd: workspaceRoot, limits }), workspaceRoot);
  const diffService = new DiffService({ git, confinePath: (input) => confinePath(workspaceRoot, input), limits });
  const projectInfoService = new ProjectInfoService({
    git,
    workspaceRoot,
    limits,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    toolNames: TOOL_NAMES,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.server.onclose = () => logger.info('connection closed');

  const runtime = { logger, limits };
  registerGetProjectInfoTool(server, { ...runtime, service: projectInfoService });
  registerAnalyzeGitDiffTool(server, { ...runtime, service: diffService });

  return server;
}
