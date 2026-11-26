import type { DiffFormat, DiffGitPort, DiffSpec, GitData, RepoState } from '../../core/diff/git-port.js';
import { NOT_A_REPO } from '../../core/diff/git-port.js';
import { DevGuardError } from '../../shared/errors.js';
import { isSameDirectory } from '../fs/workspace-fs.js';
import { isFullSha, validateRefInput } from './git-args.js';
import type { GitRunner } from './git-runner.js';

const SMALL_OUTPUT_BYTES = 8 * 1024;

const FORMAT_ARGS: Record<DiffFormat, readonly string[]> = {
  'name-status': ['--name-status', '-z'],
  numstat: ['--numstat', '-z'],
  patch: ['-U0'],
};

function requireSha(value: string): string {
  if (!isFullSha(value)) throw new DevGuardError('INTERNAL', 'Expected a resolved commit id.');
  return value;
}

function specArgs(spec: DiffSpec): string[] {
  switch (spec.kind) {
    case 'workingTree':
      return spec.hasHead ? ['HEAD'] : ['--cached'];
    case 'staged':
      return ['--cached'];
    case 'range':
      return [`${requireSha(spec.baseSha)}...${requireSha(spec.headSha)}`];
  }
}

/** Typed, read-only git operations. Callers never see or build raw git argument lists. */
export class GitClient implements DiffGitPort {
  constructor(
    private readonly runner: GitRunner,
    private readonly root: string,
  ) {}

  /** Returns null when git cannot be started. */
  async version(signal?: AbortSignal): Promise<string | null> {
    try {
      const output = await this.runner.run({ args: ['--version'], maxBytes: SMALL_OUTPUT_BYTES, signal });
      return /git version (\S+)/.exec(output.stdout.toString('utf8'))?.[1] ?? null;
    } catch (error) {
      if (error instanceof DevGuardError && error.code === 'GIT_FAILED') return null;
      throw error;
    }
  }

  async repoState(signal?: AbortSignal): Promise<RepoState> {
    let topLevel: string;
    try {
      const output = await this.runner.run({ args: ['rev-parse', '--show-toplevel'], maxBytes: SMALL_OUTPUT_BYTES, signal });
      topLevel = output.stdout.toString('utf8').trim();
    } catch (error) {
      if (error instanceof DevGuardError && error.code === 'NOT_A_GIT_REPO') return { ...NOT_A_REPO };
      throw error;
    }

    const branchOutput = await this.runner.run({
      args: ['symbolic-ref', '--short', '-q', 'HEAD'],
      maxBytes: SMALL_OUTPUT_BYTES,
      okExitCodes: [0, 1],
      signal,
    });
    const headOutput = await this.runner.run({
      args: ['rev-parse', '--verify', '--quiet', 'HEAD'],
      maxBytes: SMALL_OUTPUT_BYTES,
      okExitCodes: [0, 1],
      signal,
    });

    const branch = branchOutput.exitCode === 0 ? branchOutput.stdout.toString('utf8').trim() || null : null;
    const headSha = headOutput.exitCode === 0 ? headOutput.stdout.toString('utf8').trim() || null : null;

    return {
      isRepo: true,
      isRepoRoot: await isSameDirectory(topLevel, this.root),
      branch,
      headSha,
      detached: branch === null && headSha !== null,
    };
  }

  async resolveCommit(ref: string, signal?: AbortSignal): Promise<string> {
    validateRefInput(ref);

    const output = await this.runner.run({
      args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`],
      maxBytes: SMALL_OUTPUT_BYTES,
      okExitCodes: [0, 1],
      signal,
    });
    if (output.exitCode !== 0) {
      throw new DevGuardError('INVALID_REF', `Git ref ${JSON.stringify(ref)} does not resolve to a commit.`, {
        hint: 'Check the branch, tag or commit name. For a shallow clone the ref may not be available locally.',
      });
    }
    return requireSha(output.stdout.toString('utf8').trim());
  }

  async readDiff(request: {
    spec: DiffSpec;
    format: DiffFormat;
    pathspecs: readonly string[];
    maxBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<GitData> {
    const output = await this.runner.run({
      args: [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-M',
        ...FORMAT_ARGS[request.format],
        ...specArgs(request.spec),
        '--',
        ...request.pathspecs,
      ],
      maxBytes: request.maxBytes,
      signal: request.signal,
    });
    return { data: output.stdout, truncated: output.truncated };
  }

  async listUntracked(request: {
    pathspecs: readonly string[];
    maxBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<GitData> {
    const output = await this.runner.run({
      args: ['ls-files', '--others', '--exclude-standard', '-z', '--', ...request.pathspecs],
      maxBytes: request.maxBytes,
      signal: request.signal,
    });
    return { data: output.stdout, truncated: output.truncated };
  }
}
