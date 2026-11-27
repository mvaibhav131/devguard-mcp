import { McpServer } from '@modelcontextprotocol/server';

import type { Config } from './config/config.js';
import { ChangeSetResolver } from './core/impact/change-set.js';
import { ImpactService } from './core/impact/impact.service.js';
import { ImportGraphBuilder } from './core/impact/import-graph.js';
import { DiffService } from './core/diff/diff.service.js';
import { ProjectInfoService } from './core/project/project-info.service.js';
import { RiskService } from './core/risk/risk.service.js';
import { ReviewService } from './core/review/review.service.js';
import { TestDiscoveryService } from './core/tests/test-discovery.service.js';
import { confinePath } from './infrastructure/fs/workspace-fs.js';
import { GitClient } from './infrastructure/git/git-client.js';
import { GitRunner } from './infrastructure/git/git-runner.js';
import { WorkspaceSourceFiles } from './infrastructure/workspace-source-files.js';
import { DEFAULT_LIMITS, type Limits } from './shared/limits.js';
import type { Logger } from './shared/logger.js';
import { Semaphore } from './shared/semaphore.js';
import { SERVER_NAME, SERVER_VERSION } from './shared/version.js';
import { registerAnalyzeChangeImpactTool } from './tools/analyze-change-impact.tool.js';
import { registerAnalyzeGitDiffTool } from './tools/analyze-git-diff.tool.js';
import { registerAssessRiskTool } from './tools/assess-risk.tool.js';
import { registerDiscoverTestsTool } from './tools/discover-tests.tool.js';
import { registerGetProjectInfoTool } from './tools/get-project-info.tool.js';
import { registerReviewMyChangesPrompt } from './prompts/review-my-changes.prompt.js';
import { registerReviewChangesTool } from './tools/review-changes.tool.js';
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
  const confine = (input: string) => confinePath(workspaceRoot, input);
  const source = new WorkspaceSourceFiles(git, workspaceRoot, limits.gitOutputCapBytes);

  const diffService = new DiffService({ git, confinePath: confine, limits });
  const changes = new ChangeSetResolver({ diff: diffService, confinePath: confine });
  const graphBuilder = new ImportGraphBuilder({ source, limits });
  const impactService = new ImpactService({ changes, graphBuilder, limits });
  const testDiscoveryService = new TestDiscoveryService({ changes, graphBuilder, source, limits });
  const riskService = new RiskService({ changes, graphBuilder, impact: impactService, tests: testDiscoveryService, limits });
  const reviewService = new ReviewService({ diff: diffService, source, tests: testDiscoveryService, limits });
  const projectInfoService = new ProjectInfoService({
    git,
    workspaceRoot,
    limits,
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    toolNames: TOOL_NAMES,
  });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.server.onclose = () => logger.info('connection closed');

  const runtime = { logger, limits, gate: new Semaphore(limits.maxConcurrentCalls) };
  registerGetProjectInfoTool(server, { ...runtime, service: projectInfoService });
  registerAnalyzeGitDiffTool(server, { ...runtime, service: diffService });
  registerAnalyzeChangeImpactTool(server, { ...runtime, service: impactService });
  registerDiscoverTestsTool(server, { ...runtime, service: testDiscoveryService });
  registerAssessRiskTool(server, { ...runtime, service: riskService });
  registerReviewChangesTool(server, { ...runtime, service: reviewService });
  registerReviewMyChangesPrompt(server);

  return server;
}
