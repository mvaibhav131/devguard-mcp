import { describe, expect, it } from 'vitest';

import { runProcess, type RunProcessOptions } from '../../src/infrastructure/process/process-runner.js';

function node(script: string, extra: Partial<RunProcessOptions> = {}, ...scriptArgs: string[]) {
  return runProcess({
    command: process.execPath,
    args: ['-e', script, ...scriptArgs],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 10_000,
    maxStdoutBytes: 1_000_000,
    ...extra,
  });
}

describe('runProcess', () => {
  it('captures stdout, stderr and the exit code', async () => {
    const result = await node("process.stdout.write('hi'); console.error('bad'); process.exit(3)");

    expect(result).toMatchObject({ exitCode: 3, stdoutTruncated: false, timedOut: false, aborted: false });
    expect(result.stdout.toString()).toBe('hi');
    expect(result.stderr.trim()).toBe('bad');
  });

  it('passes arguments verbatim without a shell', async () => {
    const result = await node('process.stdout.write(process.argv[1])', {}, 'a && echo pwned');

    expect(result.stdout.toString()).toBe('a && echo pwned');
  });

  it('kills the process when the timeout expires', async () => {
    const started = Date.now();

    const result = await node('setTimeout(() => {}, 60000)', { timeoutMs: 200 });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('stops reading at the byte cap and marks the output as truncated', async () => {
    const result = await node("process.stdout.write('x'.repeat(200000))", { maxStdoutBytes: 1_000 });

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(1_000);
  });

  it('kills the process when the signal aborts, and does not start when already aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);

    const running = await node('setTimeout(() => {}, 60000)', { signal: controller.signal });
    expect(running.aborted).toBe(true);

    const notStarted = await node("process.stdout.write('never')", { signal: AbortSignal.abort() });
    expect(notStarted).toMatchObject({ aborted: true, exitCode: null });
    expect(notStarted.stdout.length).toBe(0);
  });

  it('rejects when the executable does not exist', async () => {
    await expect(
      runProcess({
        command: 'devguard-definitely-not-a-command',
        args: [],
        cwd: process.cwd(),
        env: process.env,
        timeoutMs: 5_000,
        maxStdoutBytes: 1_000,
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
