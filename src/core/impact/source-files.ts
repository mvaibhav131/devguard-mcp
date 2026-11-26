export type SkipReason = 'missing' | 'outside' | 'symlink' | 'too-large' | 'binary' | 'unreadable';

export type ReadOutcome = { status: 'ok'; text: string } | { status: 'skipped'; reason: SkipReason };

/** What the impact and test analysis need from the workspace. Implemented by infrastructure/workspace-source-files.ts. */
export interface SourceFilesPort {
  /** Every file known to git (and not ignored), as repository-relative POSIX paths. */
  listFiles(request: { includeUntracked: boolean; signal?: AbortSignal | undefined }): Promise<{ paths: string[]; truncated: boolean }>;
  readText(path: string, maxBytes: number): Promise<ReadOutcome>;
}
