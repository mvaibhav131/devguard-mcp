import { DevGuardError } from '../../shared/errors.js';
import type { ChangeSelection, DiffMode, DiffSelectionInfo, DiffService } from '../diff/diff.service.js';
import type { FileStatus } from '../diff/diff.types.js';
import { isSourceFile } from './module-resolver.js';

export interface ChangedFile {
  path: string;
  status: FileStatus | 'explicit';
  oldPath?: string;
}

export interface ChangeSetRequest {
  /** Explicit files instead of git changes. Cannot be combined with mode, base, head or paths. */
  files?: readonly string[] | undefined;
  mode?: DiffMode | undefined;
  base?: string | undefined;
  head?: string | undefined;
  includeUntracked: boolean;
  paths?: readonly string[] | undefined;
}

export type ChangeSelectionInfo =
  | ({ source: 'git' } & DiffSelectionInfo)
  | { source: 'files'; files: string[] };

export interface ChangeSet {
  selection: ChangeSelectionInfo;
  files: ChangedFile[];
  /** The list of changed files was cut off. */
  scanLimited: boolean;
}

export interface ChangeSetDeps {
  diff: Pick<DiffService, 'collectChanges'>;
  confinePath: (input: string) => Promise<{ relativePath: string }>;
}

export interface ChangeDescription {
  /** Every changed path, including the old path of renames. */
  changedPaths: Set<string>;
  /** Changed paths that no longer exist, so importers of deleted or renamed files can still be linked. */
  extraKnown: Set<string>;
  /** Changed TypeScript and JavaScript files, the starting points of the import analysis. */
  seeds: string[];
}

export function describeChanges(files: readonly ChangedFile[]): ChangeDescription {
  const changedPaths = new Set<string>();
  const extraKnown = new Set<string>();
  const seeds = new Set<string>();

  for (const file of files) {
    changedPaths.add(file.path);
    if (file.status === 'deleted') extraKnown.add(file.path);
    if (isSourceFile(file.path)) seeds.add(file.path);
    if (file.oldPath !== undefined) {
      changedPaths.add(file.oldPath);
      extraKnown.add(file.oldPath);
      if (isSourceFile(file.oldPath)) seeds.add(file.oldPath);
    }
  }
  return { changedPaths, extraKnown, seeds: [...seeds].sort() };
}

/** Turns either a git selection or an explicit file list into the set of changed files. */
export class ChangeSetResolver {
  constructor(private readonly deps: ChangeSetDeps) {}

  async resolve(request: ChangeSetRequest, signal?: AbortSignal): Promise<ChangeSet> {
    if (request.files !== undefined) {
      if (request.mode !== undefined || request.base !== undefined || request.head !== undefined || request.paths !== undefined) {
        throw new DevGuardError('INVALID_INPUT', '"files" cannot be combined with "mode", "base", "head" or "paths".');
      }
      const confined = await Promise.all(request.files.map(async (input) => (await this.deps.confinePath(input)).relativePath));
      const files = [...new Set(confined)].sort();
      return {
        selection: { source: 'files', files },
        files: files.map((path) => ({ path, status: 'explicit' as const })),
        scanLimited: false,
      };
    }

    const selection: ChangeSelection = {
      mode: request.mode ?? 'workingTree',
      base: request.base,
      head: request.head,
      includeUntracked: request.includeUntracked,
      paths: request.paths,
    };
    const collected = await this.deps.diff.collectChanges(selection, signal);

    return {
      selection: { source: 'git', ...collected.selection },
      files: collected.all.map((file) => {
        const changed: ChangedFile = { path: file.path, status: file.status };
        if (file.oldPath !== undefined) changed.oldPath = file.oldPath;
        return changed;
      }),
      scanLimited: collected.scanLimited,
    };
  }
}
