import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createShutdownController, installProcessHandlers } from '../../src/lifecycle.js';
import { createLogger } from '../../src/shared/logger.js';

function setup(close: () => Promise<void>, timeoutMs = 5_000) {
  const lines: string[] = [];
  const logger = createLogger({ level: 'debug', write: (line) => lines.push(line) });
  const exit = vi.fn<(code: number) => void>();
  const controller = createShutdownController({ close, logger, timeoutMs, exit });
  const proc = new EventEmitter();
  installProcessHandlers(proc, controller, logger);
  return { proc, exit, lines };
}

describe('shutdown', () => {
  it('closes once and exits with 0 on a signal, even if the signal repeats', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { proc, exit } = setup(close);

    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalled());

    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('exits with 1 after closing when an uncaught exception or unhandled rejection happens', async () => {
    const close = vi.fn(() => Promise.resolve());
    const { proc, exit, lines } = setup(close);

    proc.emit('uncaughtException', new Error('boom'));
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(close).toHaveBeenCalledTimes(1);
    expect(lines.join('\n')).toContain('uncaught exception');

    const second = setup(vi.fn(() => Promise.resolve()));
    second.proc.emit('unhandledRejection', new Error('later'));
    await vi.waitFor(() => expect(second.exit).toHaveBeenCalledWith(1));
  });

  it('reports a failing close and exits with 1', async () => {
    const { proc, exit, lines } = setup(() => Promise.reject(new Error('close failed')));

    proc.emit('SIGTERM');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(lines.join('\n')).toContain('error while closing the server');
  });

  it('forces the exit when close never finishes', async () => {
    const { proc, exit, lines } = setup(() => new Promise<void>(() => {}), 50);

    proc.emit('SIGINT');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

    expect(lines.join('\n')).toContain('shutdown timed out');
  });
});
