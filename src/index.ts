import { loadConfig } from './config/config.js';
import { createLogger } from './shared/logger.js';

async function main(): Promise<void> {
  const config = await loadConfig(process.argv.slice(2), process.env, process.cwd());
  const logger = createLogger({ level: config.logLevel });

  logger.info('devguard-mcp starting (MCP server not implemented yet)', {
    workspaceRoot: config.workspaceRoot,
    logLevel: config.logLevel,
  });
}

main().catch((error: unknown) => {
  createLogger({ level: 'error' }).error('startup failed', { error });
  process.exitCode = 1;
});
