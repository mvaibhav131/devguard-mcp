export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'unmerged'
  | 'untracked'
  | 'unknown';

export type Language = 'typescript' | 'javascript' | 'json' | 'markdown' | 'other';

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  language: Language;
  /** null for binary and untracked files. */
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
  hunks?: Hunk[];
  hunksTruncated?: boolean;
}

const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
};

export function detectLanguage(filePath: string): Language {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return EXTENSION_LANGUAGE[fileName.slice(dot).toLowerCase()] ?? 'other';
}
