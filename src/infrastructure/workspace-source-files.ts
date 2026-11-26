import { parseNulSeparatedPaths } from '../core/diff/diff-parser.js';
import type { ReadOutcome, SourceFilesPort } from '../core/impact/source-files.js';
import { readWorkspaceText } from './fs/workspace-fs.js';
import type { GitClient } from './git/git-client.js';

/** Lists files through git (so .gitignore is respected) and reads them with the workspace safety checks. */
export class WorkspaceSourceFiles implements SourceFilesPort {
  constructor(
    private readonly git: GitClient,
    private readonly root: string,
    private readonly maxListBytes: number,
  ) {}

  async listFiles(request: { includeUntracked: boolean; signal?: AbortSignal | undefined }): Promise<{ paths: string[]; truncated: boolean }> {
    const output = await this.git.listFiles({ includeUntracked: request.includeUntracked, maxBytes: this.maxListBytes, signal: request.signal });

    let paths = parseNulSeparatedPaths(output.data.toString('utf8'));
    // The last entry of a cut-off listing may be incomplete.
    if (output.truncated) paths = paths.slice(0, -1);
    return { paths: [...new Set(paths)], truncated: output.truncated };
  }

  readText(path: string, maxBytes: number): Promise<ReadOutcome> {
    return readWorkspaceText(this.root, path, maxBytes);
  }
}
