import { describe, expect, it } from 'vitest';

import { isSourceFile, resolveSpecifier, type ResolverContext } from '../../src/core/impact/module-resolver.js';
import { loadAliasConfig, NO_ALIASES, parseJsonc } from '../../src/core/impact/tsconfig-paths.js';
import { fileStem, isTestFile } from '../../src/core/tests/test-files.js';

function context(files: string[], extra: Partial<ResolverContext> = {}): ResolverContext {
  return { files: new Set(files), extraKnown: new Set(), aliases: NO_ALIASES, ...extra };
}

describe('isSourceFile', () => {
  it.each([
    ['src/a.ts', true],
    ['src/a.tsx', true],
    ['src/a.mjs', true],
    ['types/a.d.ts', true],
    ['README.md', false],
    ['src/data.json', false],
    ['node_modules/pkg/index.js', false],
    ['dist/index.js', false],
    ['packages/app/build/out.js', false],
  ])('%s -> %s', (file, expected) => {
    expect(isSourceFile(file)).toBe(expected);
  });
});

describe('resolveSpecifier', () => {
  it('resolves relative imports with extension probing, index files and NodeNext ".js" specifiers', () => {
    const ctx = context(['src/a.ts', 'src/b.tsx', 'src/lib/index.ts', 'src/c.mts', 'src/legacy.js', 'src/data.json']);

    expect(resolveSpecifier('./a', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/a.ts' });
    expect(resolveSpecifier('./a.js', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/a.ts' });
    expect(resolveSpecifier('./b.js', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/b.tsx' });
    expect(resolveSpecifier('./c.mjs', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/c.mts' });
    expect(resolveSpecifier('./lib', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/lib/index.ts' });
    expect(resolveSpecifier('./legacy.js', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/legacy.js' });
    expect(resolveSpecifier('./data.json', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/data.json' });
    expect(resolveSpecifier('../a', 'src/lib/deep.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/a.ts' });
    expect(resolveSpecifier('.', 'src/lib/deep.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/lib/index.ts' });
  });

  it('links imports of deleted or renamed files through extraKnown', () => {
    const ctx = context(['src/main.ts'], { extraKnown: new Set(['src/gone.ts']) });

    expect(resolveSpecifier('./gone', 'src/main.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/gone.ts' });
  });

  it('classifies packages, assets and unresolved specifiers', () => {
    const ctx = context(['src/a.ts']);

    expect(resolveSpecifier('zod', 'src/a.ts', ctx)).toEqual({ kind: 'external' });
    expect(resolveSpecifier('@scope/pkg/sub', 'src/a.ts', ctx)).toEqual({ kind: 'external' });
    expect(resolveSpecifier('node:fs', 'src/a.ts', ctx)).toEqual({ kind: 'external' });
    expect(resolveSpecifier('./style.css', 'src/a.ts', ctx)).toEqual({ kind: 'asset' });
    expect(resolveSpecifier('./missing', 'src/a.ts', ctx)).toEqual({ kind: 'unresolved', reason: 'file-not-found' });
    expect(resolveSpecifier('../../outside', 'src/a.ts', ctx)).toEqual({ kind: 'unresolved', reason: 'outside-workspace' });
    expect(resolveSpecifier('#internal/x', 'src/a.ts', ctx)).toEqual({ kind: 'unresolved', reason: 'package-imports-unsupported' });
    expect(resolveSpecifier('/abs/path', 'src/a.ts', ctx)).toEqual({ kind: 'unresolved', reason: 'absolute-path' });
  });

  it('resolves tsconfig paths (longest prefix wins) and baseUrl', () => {
    const ctx = context(['src/utils/log.ts', 'src/core/index.ts', 'lib/shared.ts'], {
      aliases: {
        baseUrl: '',
        paths: [
          { pattern: '@/*', targets: ['src/*'] },
          { pattern: '@core', targets: ['src/core'] },
          { pattern: '@missing/*', targets: ['nowhere/*'] },
        ],
      },
    });

    expect(resolveSpecifier('@/utils/log', 'x.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/utils/log.ts' });
    expect(resolveSpecifier('@core', 'x.ts', ctx)).toEqual({ kind: 'resolved', path: 'src/core/index.ts' });
    expect(resolveSpecifier('@missing/a', 'x.ts', ctx)).toEqual({ kind: 'unresolved', reason: 'alias-target-not-found' });
    expect(resolveSpecifier('lib/shared', 'x.ts', ctx)).toEqual({ kind: 'resolved', path: 'lib/shared.ts' });
    expect(resolveSpecifier('lodash', 'x.ts', ctx)).toEqual({ kind: 'external' });
  });
});

describe('parseJsonc and loadAliasConfig', () => {
  it('parses comments and trailing commas', () => {
    expect(parseJsonc('{ /* c */ "a": [1, 2,], // x\n "b": "//not a comment", }')).toEqual({ a: [1, 2], b: '//not a comment' });
    expect(parseJsonc('not json')).toBeUndefined();
  });

  const reader = (files: Record<string, string>) => async (file: string) => files[file];

  it('reads baseUrl and paths from the root tsconfig', async () => {
    const config = await loadAliasConfig(
      reader({ 'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }' }),
    );

    expect(config).toEqual({ baseUrl: '', paths: [{ pattern: '@/*', targets: ['src/*'] }] });
  });

  it('resolves paths relative to the config file when there is no baseUrl', async () => {
    const config = await loadAliasConfig(
      reader({ 'tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./app/*"] } } }' }),
    );

    expect(config).toEqual({ baseUrl: undefined, paths: [{ pattern: '~/*', targets: ['app/*'] }] });
  });

  it('follows a relative "extends" and lets the child override paths', async () => {
    const files = {
      'tsconfig.json': '{ "extends": "./config/base", "compilerOptions": { "paths": { "@own/*": ["own/*"] } } }',
      'config/base.json': '{ "compilerOptions": { "baseUrl": "..", "paths": { "@base/*": ["base/*"] } } }',
    };

    expect(await loadAliasConfig(reader(files))).toEqual({ baseUrl: '', paths: [{ pattern: '@own/*', targets: ['own/*'] }] });
    expect(await loadAliasConfig(reader({ ...files, 'tsconfig.json': '{ "extends": "./config/base.json" }' }))).toEqual({
      baseUrl: '',
      paths: [{ pattern: '@base/*', targets: ['base/*'] }],
    });
  });

  it('falls back to jsconfig.json and to no aliases', async () => {
    expect(await loadAliasConfig(reader({ 'jsconfig.json': '{ "compilerOptions": { "baseUrl": "src" } }' }))).toEqual({ baseUrl: 'src', paths: [] });
    expect(await loadAliasConfig(reader({}))).toEqual(NO_ALIASES);
    expect(await loadAliasConfig(reader({ 'tsconfig.json': 'broken' }))).toEqual(NO_ALIASES);
  });
});

describe('test file helpers', () => {
  it.each([
    ['src/a.test.ts', true],
    ['src/a.spec.tsx', true],
    ['src/a.test.mjs', true],
    ['src/__tests__/helper.ts', true],
    ['tests/unit/a.ts', false],
    ['src/a.ts', false],
    ['src/contest.ts', false],
  ])('isTestFile(%s) is %s', (file, expected) => {
    expect(isTestFile(file)).toBe(expected);
  });

  it('computes the same stem for a source file and its test', () => {
    expect(fileStem('src/a.ts')).toBe('a');
    expect(fileStem('tests/unit/a.test.ts')).toBe('a');
    expect(fileStem('src/a.spec.tsx')).toBe('a');
    expect(fileStem('src/user-service.ts')).toBe('user-service');
  });
});
