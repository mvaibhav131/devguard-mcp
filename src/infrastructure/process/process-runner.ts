import { spawn } from 'node:child_process';

export interface RunProcessOptions {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal | undefined;
}

export interface RunProcessResult {
  /** null when the process was killed. */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
  stdoutTruncated: boolean;
  timedOut: boolean;
  aborted: boolean;
}

const STDERR_CAP_BYTES = 8 * 1024;

/**
 * Runs a program without a shell. Output is bounded, and the process is killed when the
 * timeout expires, the byte cap is exceeded or the signal aborts. This is the only module that
 * spawns processes.
 */
export function runProcess(options: RunProcessOptions): Promise<RunProcessResult> {
  const { command, args, cwd, env, timeoutMs, maxStdoutBytes, signal } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({
        exitCode: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        stdoutTruncated: false,
        timedOut: false,
        aborted: true,
      });
      return;
    }

    const child = spawn(command, [...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutSize = 0;
    let stderrSize = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let aborted = false;

    const kill = (): void => {
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    const onAbort = (): void => {
      aborted = true;
      kill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutTruncated) return;
      const remaining = maxStdoutBytes - stdoutSize;
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutSize = maxStdoutBytes;
        stdoutTruncated = true;
        kill();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutSize += chunk.length;
    });

    child.stderr.on('data', (chunk: Buffer) => {
      const remaining = STDERR_CAP_BYTES - stderrSize;
      if (remaining <= 0) return;
      const part = chunk.subarray(0, remaining);
      stderrChunks.push(part);
      stderrSize += part.length;
    });

    child.on('error', (error) => {
      cleanup();
      reject(error);
    });

    child.on('close', (exitCode) => {
      cleanup();
      resolve({
        exitCode,
        stdout: Buffer.concat(stdoutChunks),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutTruncated,
        timedOut,
        aborted,
      });
    });
  });
}
