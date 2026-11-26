import { DevGuardError } from '../../shared/errors.js';
import type { Limits } from '../../shared/limits.js';
import { runProcess, type RunProcessResult } from '../process/process-runner.js';
import { buildGitArgs, buildGitEnv } from './git-args.js';

export interface GitCommand {
  /** Subcommand and its arguments, without the global hardening options. */
  args: readonly string[];
  maxBytes: number;
  /** Exit codes that are a normal answer (for example 1 for "not found"). Defaults to [0]. */
  okExitCodes?: readonly number[];
  signal?: AbortSignal | undefined;
}

export interface GitOutput {
  stdout: Buffer;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}

export interface GitRunnerOptions {
  /** Canonical workspace root. */
  cwd: string;
  limits: Pick<Limits, 'gitTimeoutMs'>;
  executable?: string;
}

function isTimeoutReason(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'TimeoutError';
}

/** The single place that executes git: allowlisted subcommands, sanitized env, bounded time and output. */
export class GitRunner {
  private readonly cwd: string;
  private readonly timeoutMs: number;
  private readonly executable: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: GitRunnerOptions) {
    this.cwd = options.cwd;
    this.timeoutMs = options.limits.gitTimeoutMs;
    this.executable = options.executable ?? 'git';
    this.env = buildGitEnv();
  }

  async run(command: GitCommand): Promise<GitOutput> {
    const args = buildGitArgs(command.args);

    let result: RunProcessResult;
    try {
      result = await runProcess({
        command: this.executable,
        args,
        cwd: this.cwd,
        env: this.env,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: command.maxBytes,
        signal: command.signal,
      });
    } catch (cause) {
      throw new DevGuardError('GIT_FAILED', 'Could not start git.', {
        hint: 'Install git and make sure it is available on PATH.',
        cause,
      });
    }

    if (result.aborted) {
      const reason: unknown = command.signal?.reason;
      if (isTimeoutReason(reason)) throw this.timeoutError();
      throw reason instanceof Error ? reason : new Error('The request was cancelled.');
    }
    if (result.timedOut) throw this.timeoutError();

    if (result.stdoutTruncated) {
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, truncated: true };
    }

    const exitCode = result.exitCode ?? -1;
    if (!(command.okExitCodes ?? [0]).includes(exitCode)) {
      throw this.classifyFailure(result.stderr, exitCode);
    }
    return { stdout: result.stdout, stderr: result.stderr, exitCode, truncated: false };
  }

  private timeoutError(): DevGuardError {
    return new DevGuardError('GIT_TIMEOUT', 'The git operation exceeded its time limit.', {
      hint: 'Narrow the request with "paths" or a smaller range.',
    });
  }

  private redact(text: string): string {
    return [this.cwd, this.cwd.replaceAll('\\', '/')].reduce((result, variant) => result.split(variant).join('<workspace>'), text);
  }

  private classifyFailure(stderr: string, exitCode: number): DevGuardError {
    if (/not a git repository/i.test(stderr)) {
      return new DevGuardError('NOT_A_GIT_REPO', 'The workspace is not a git repository.', {
        hint: 'Point --workspace-root at the top-level folder of a git repository.',
      });
    }
    if (/dubious ownership/i.test(stderr)) {
      return new DevGuardError('GIT_FAILED', 'Git refuses to read this repository because it is owned by another user.', {
        hint: 'Review the repository, then add it to git safe.directory yourself. DevGuard never changes git configuration.',
      });
    }
    const firstLine = this.redact(stderr).trim().split('\n')[0]?.slice(0, 300) ?? '';
    return new DevGuardError('GIT_FAILED', `git exited with code ${exitCode}${firstLine ? `: ${firstLine}` : '.'}`);
  }
}
