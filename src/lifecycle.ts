import type { Logger } from './shared/logger.js';

export interface ShutdownOptions {
  close: () => Promise<void>;
  logger: Logger;
  /** Hard limit after which the process exits even if close() has not finished. */
  timeoutMs: number;
  exit?: (code: number) => void;
}

export interface ShutdownController {
  /** Idempotent: only the first call closes the server. */
  shutdown(reason: string, exitCode?: number): Promise<void>;
}

export function createShutdownController(options: ShutdownOptions): ShutdownController {
  const { close, logger, timeoutMs, exit = (code: number) => process.exit(code) } = options;
  let running: Promise<void> | undefined;

  return {
    shutdown(reason, exitCode = 0) {
      running ??= (async () => {
        logger.info('shutting down', { reason });

        const timer = setTimeout(() => {
          logger.error('shutdown timed out, forcing exit');
          exit(1);
        }, timeoutMs);
        timer.unref();

        let code = exitCode;
        try {
          await close();
        } catch (error) {
          logger.error('error while closing the server', { error });
          code = code === 0 ? 1 : code;
        }
        clearTimeout(timer);
        exit(code);
      })();
      return running;
    },
  };
}

/**
 * Signals are best effort: Windows has no real SIGTERM and may kill the process outright.
 * The reliable shutdown path is the client closing stdin, which the SDK transport handles itself.
 */
export function installProcessHandlers(proc: NodeJS.EventEmitter, controller: ShutdownController, logger: Logger): void {
  proc.on('SIGINT', () => void controller.shutdown('SIGINT'));
  proc.on('SIGTERM', () => void controller.shutdown('SIGTERM'));
  proc.on('uncaughtException', (error: unknown) => {
    logger.error('uncaught exception', { error });
    void controller.shutdown('uncaughtException', 1);
  });
  proc.on('unhandledRejection', (reason: unknown) => {
    logger.error('unhandled rejection', { error: reason });
    void controller.shutdown('unhandledRejection', 1);
  });
}
