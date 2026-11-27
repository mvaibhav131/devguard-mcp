import type { CollectedChanges } from '../../src/core/diff/diff.service.js';
import type { FileStatus } from '../../src/core/diff/diff.types.js';
import { ChangeSetResolver, type ChangedFile } from '../../src/core/impact/change-set.js';
import { ImportGraphBuilder } from '../../src/core/impact/import-graph.js';
import type { ReadOutcome, SourceFilesPort } from '../../src/core/impact/source-files.js';
import { DEFAULT_LIMITS, type Limits } from '../../src/shared/limits.js';

/** An in-memory workspace for the import graph, impact and test discovery tests. */
export class FakeSource implements SourceFilesPort {
  constructor(
    private readonly files: Record<string, string>,
    private readonly skipped: Record<string, 'too-large' | 'binary' | 'symlink'> = {},
  ) {}

  listFiles(): Promise<{ paths: string[]; truncated: boolean }> {
    return Promise.resolve({ paths: [...Object.keys(this.files), ...Object.keys(this.skipped)], truncated: false });
  }

  readText(path: string): Promise<ReadOutcome> {
    const reason = this.skipped[path];
    if (reason) return Promise.resolve({ status: 'skipped', reason });
    const text = this.files[path];
    return Promise.resolve(text === undefined ? { status: 'skipped', reason: 'missing' } : { status: 'ok', text });
  }
}

export const SAMPLE_PROJECT: Record<string, string> = {
  'package.json': JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '1.0.0' } }),
  'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } }, }',
  'vitest.config.ts': 'export default {};',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a.js';\nexport const b = a;\n",
  'src/c.ts': "import { b } from './b';\nexport const c = b;\n",
  'src/d.ts': "import './c';\n",
  'src/alias.ts': "import { a } from '@/a';\nexport { a };\n",
  'src/lonely.ts': 'export const lonely = 1;\n',
  'src/types.ts': 'export type T = 1;\n',
  'src/uses-type.ts': "import type { T } from './types';\nexport const t: T = 1;\n",
  'src/messy.ts': "import './nope';\nimport zod from 'zod';\nimport './style.css';\nconst lazy = import(name);\n",
  'src/a.test.ts': "import { describe } from 'vitest';\nimport { a } from './a';\n",
  'tests/c.test.ts': "import { c } from '../src/c';\n",
  'README.md': '# readme\n',
};

export function resolverFor(changed: ChangedFile[], scanLimited = false): ChangeSetResolver {
  return new ChangeSetResolver({
    confinePath: (input) => Promise.resolve({ relativePath: input }),
    diff: {
      collectChanges: () =>
        Promise.resolve({
          selection: { mode: 'workingTree', includeUntracked: true },
          all: changed.map((file) => ({
            path: file.path,
            ...(file.oldPath !== undefined && { oldPath: file.oldPath }),
            status: file.status as FileStatus,
            language: 'typescript' as const,
            additions: file.additions === undefined ? 1 : file.additions,
            deletions: file.deletions === undefined ? 0 : file.deletions,
            isBinary: file.isBinary ?? false,
          })),
          scanLimited,
        } as unknown as CollectedChanges),
    },
  });
}

export function graphBuilderFor(source: SourceFilesPort, overrides: Partial<Limits> = {}): ImportGraphBuilder {
  return new ImportGraphBuilder({ source, limits: { ...DEFAULT_LIMITS, ...overrides } });
}

export const defaultRequest = { includeUntracked: true, limit: 50, offset: 0 } as const;
