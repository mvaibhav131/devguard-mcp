import { afterEach, describe, expect, it, vi } from 'vitest';

import { DevGuardError } from '../../src/shared/errors.js';
import { createLogger } from '../../src/shared/logger.js';

const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const logger = createLogger({ level, write: (line) => lines.push(line), now: fixedNow });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, parsed };
}

describe('logger', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes one JSON line per call and skips levels below the threshold', () => {
    const { logger, parsed } = capture('info');

    logger.debug('hidden');
    logger.info('shown', { files: 3 });

    expect(parsed()).toEqual([{ time: '2026-01-01T00:00:00.000Z', level: 'info', msg: 'shown', files: 3 }]);
  });

  it('adds child bindings and does not let fields overwrite reserved keys', () => {
    const { logger, parsed } = capture();

    logger.child({ requestId: 'r-1' }).info('call', { level: 'fake', msg: 'fake' });

    expect(parsed()[0]).toMatchObject({ requestId: 'r-1', level: 'info', msg: 'call' });
  });

  it('serializes errors without a stack for expected ones and with a stack for unexpected ones', () => {
    const { logger, parsed } = capture();

    logger.error('expected', { error: new DevGuardError('GIT_FAILED', 'git broke', { hint: 'retry' }) });
    logger.error('unexpected', { error: new Error('boom') });

    const [expected, unexpected] = parsed() as [{ error: Record<string, unknown> }, { error: Record<string, unknown> }];
    expect(expected.error).toEqual({ name: 'DevGuardError', code: 'GIT_FAILED', message: 'git broke', hint: 'retry' });
    expect(unexpected.error['stack']).toEqual(expect.stringContaining('boom'));
  });

  it('never throws, even for circular fields or a failing writer', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const { logger, parsed } = capture();

    expect(() => logger.info('circular', { circular })).not.toThrow();
    expect(parsed()[0]).toMatchObject({ msg: 'circular', logError: 'fields could not be serialized' });

    const broken = createLogger({
      level: 'info',
      write: () => {
        throw new Error('EPIPE');
      },
    });
    expect(() => broken.info('x')).not.toThrow();
  });

  it('writes to stderr and never to stdout by default', () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    createLogger({ level: 'info' }).info('hello');

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledTimes(1);
  });
});
