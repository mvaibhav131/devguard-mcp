export type DiffSpec =
  | { kind: 'workingTree'; hasHead: boolean }
  | { kind: 'staged' }
  | { kind: 'range'; baseSha: string; headSha: string };

export type DiffFormat = 'name-status' | 'numstat' | 'patch';

export interface GitData {
  data: Buffer;
  /** True when git output hit the byte cap and was cut off. */
  truncated: boolean;
}

export interface RepoState {
  isRepo: boolean;
  /** True when the workspace root is the top-level directory of the repository. */
  isRepoRoot: boolean;
  branch: string | null;
  headSha: string | null;
  detached: boolean;
}

export const NOT_A_REPO: Readonly<RepoState> = {
  isRepo: false,
  isRepoRoot: false,
  branch: null,
  headSha: null,
  detached: false,
};

/** What the diff service needs from git. Implemented by infrastructure/git/git-client.ts. */
export interface DiffGitPort {
  repoState(signal?: AbortSignal): Promise<RepoState>;
  resolveCommit(ref: string, signal?: AbortSignal): Promise<string>;
  readDiff(request: {
    spec: DiffSpec;
    format: DiffFormat;
    pathspecs: readonly string[];
    maxBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<GitData>;
  listUntracked(request: {
    pathspecs: readonly string[];
    maxBytes: number;
    signal?: AbortSignal | undefined;
  }): Promise<GitData>;
}
