import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config/config.js';
import { createShutdownController, installProcessHandlers } from './lifecycle.js';
import { createServer } from './server.js';
import { DEFAULT_LIMITS } from './shared/limits.js';
import { createLogger } from './shared/logger.js';
import { SERVER_VERSION } from './shared/version.js';

// Safety net: a dependency that logs through console.log, info or debug would corrupt the JSON-RPC stream on stdout.
for (const method of ['log', 'info', 'debug'] as const) {
  console[method] = (...args: unknown[]) => console.error(...args);
}

async function main(): Promise<void> {
  const config = await loadConfig(process.argv.slice(2), process.env, process.cwd());
  const logger = createLogger({ level: config.logLevel });

  logger.info('devguard-mcp starting', {
    version: SERVER_VERSION,
    node: process.versions.node,
    platform: process.platform,
    workspaceRoot: config.workspaceRoot,
    logLevel: config.logLevel,
  });

  const handle = serveStdio(() => createServer({ config, logger }));
  const controller = createShutdownController({
    close: () => handle.close(),
    logger,
    timeoutMs: DEFAULT_LIMITS.shutdownTimeoutMs,
  });
  installProcessHandlers(process, controller, logger);

  logger.info('devguard-mcp ready on stdio');
}

main().catch((error: unknown) => {
  createLogger({ level: 'error' }).error('startup failed', { error });
  process.exitCode = 1;
});
