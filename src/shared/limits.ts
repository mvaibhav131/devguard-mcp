export interface Limits {
  /** Upper bound for the serialized structured payload of one tool result. */
  maxResponseBytes: number;
  /** Time limit for a single git process. */
  gitTimeoutMs: number;
  /** Time limit for one whole tool call. */
  toolTimeoutMs: number;
  /** Maximum stdout read from git for name-status, numstat and ls-files. */
  gitOutputCapBytes: number;
  /** Maximum stdout read from git for the -U0 patch used to extract hunks. */
  patchOutputCapBytes: number;
  maxFilesScanned: number;
  maxHunksPerFile: number;
  shutdownTimeoutMs: number;
}

export const DEFAULT_LIMITS: Readonly<Limits> = {
  maxResponseBytes: 16 * 1024,
  gitTimeoutMs: 15_000,
  toolTimeoutMs: 30_000,
  gitOutputCapBytes: 4 * 1024 * 1024,
  patchOutputCapBytes: 2 * 1024 * 1024,
  maxFilesScanned: 5_000,
  maxHunksPerFile: 20,
  shutdownTimeoutMs: 3_000,
};

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_PATHS_PER_REQUEST = 20;
export const MAX_PATH_LENGTH = 1024;
export const MAX_REF_LENGTH = 200;
