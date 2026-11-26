import type { FileStatus, Hunk } from './diff.types.js';

const STATUS_BY_LETTER: Readonly<Record<string, FileStatus>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typeChanged',
  U: 'unmerged',
};

export interface NameStatusEntry {
  status: FileStatus;
  path: string;
  oldPath?: string;
}

/** Parses `git diff --name-status -z`. Incomplete trailing records are dropped. */
export function parseNameStatusZ(output: string): NameStatusEntry[] {
  const tokens = output.split('\0');
  const entries: NameStatusEntry[] = [];

  let index = 0;
  while (index < tokens.length) {
    const code = tokens[index++];
    if (!code) continue;

    const letter = code.charAt(0);
    const status = STATUS_BY_LETTER[letter] ?? 'unknown';

    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[index++];
      const path = tokens[index++];
      if (!oldPath || !path) break;
      entries.push({ status, path, oldPath });
    } else {
      const path = tokens[index++];
      if (!path) break;
      entries.push({ status, path });
    }
  }
  return entries;
}

export interface NumstatEntry {
  /** null for binary files. */
  additions: number | null;
  deletions: number | null;
  isBinary: boolean;
}

/** Parses `git diff --numstat -z` into a map keyed by the (new) path. */
export function parseNumstatZ(output: string): Map<string, NumstatEntry> {
  const tokens = output.split('\0');
  const entries = new Map<string, NumstatEntry>();

  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index++];
    if (!token) continue;

    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(token);
    if (!match) continue;

    const [, added = '-', deleted = '-', inlinePath = ''] = match;
    let path = inlinePath;
    if (path === '') {
      // Renames and copies are written as "<added>\t<deleted>\t\0<old>\0<new>\0".
      index++;
      path = tokens[index++] ?? '';
    }
    if (path === '') continue;

    const isBinary = added === '-' || deleted === '-';
    entries.set(path, {
      additions: isBinary ? null : Number(added),
      deletions: isBinary ? null : Number(deleted),
      isBinary,
    });
  }
  return entries;
}

/** Parses `git ls-files -z` output. */
export function parseNulSeparatedPaths(output: string): string[] {
  return output.split('\0').filter((path) => path !== '');
}

export interface PatchSection {
  hunks: Hunk[];
  /** True when the file had more hunks than the per-file cap. */
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Extracts hunk ranges from `git diff -U0` output, one section per changed file in git's order.
 * Content lines always start with "+", "-", " " or "\", so a line starting with "diff " is a file header.
 */
export function parsePatchSections(patch: string, maxHunksPerFile: number): PatchSection[] {
  const sections: PatchSection[] = [];
  let current: PatchSection | undefined;

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ') || line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      current = { hunks: [], truncated: false };
      sections.push(current);
      continue;
    }
    if (!current) continue;

    const match = HUNK_HEADER.exec(line);
    if (!match) continue;

    if (current.hunks.length >= maxHunksPerFile) {
      current.truncated = true;
      continue;
    }
    current.hunks.push({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  return sections;
}
