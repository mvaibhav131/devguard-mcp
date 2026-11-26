import { describe, expect, it } from 'vitest';

import { extractImports, type ImportRef } from '../../src/core/impact/import-extractor.js';

const specifiers = (source: string): string[] => extractImports(source).imports.map((ref) => ref.specifier);
const find = (source: string, specifier: string): ImportRef | undefined =>
  extractImports(source).imports.find((ref) => ref.specifier === specifier);

describe('extractImports', () => {
  it('finds static imports in all common forms', () => {
    const source = `
      import a from './a';
      import { b, c as d } from "./b";
      import * as e from './e.js';
      import f, { g } from './f';
      import type { T } from './types';
      import {
        multi,
        line,
      } from './multi';
      import './side-effect';
      import json from './data.json' with { type: 'json' };
    `;

    expect(specifiers(source)).toEqual(['./a', './b', './e.js', './f', './types', './multi', './side-effect', './data.json']);
    expect(find(source, './types')).toMatchObject({ kind: 'import', typeOnly: true });
    expect(find(source, './a')).toMatchObject({ kind: 'import', typeOnly: false });
    expect(find(source, './side-effect')).toMatchObject({ kind: 'side-effect' });
  });

  it('finds re-exports and keeps their type-only flag', () => {
    const source = `
      export * from './all';
      export * as ns from './ns';
      export { x, y as z } from './named';
      export type { Shape } from './shape';
      export type * from './more-types';
      export { local };
      export const value = 1;
    `;

    expect(specifiers(source)).toEqual(['./all', './ns', './named', './shape', './more-types']);
    expect(find(source, './shape')).toMatchObject({ kind: 'export-from', typeOnly: true });
    expect(find(source, './all')).toMatchObject({ kind: 'export-from', typeOnly: false });
  });

  it('finds dynamic imports and require calls with literal specifiers and counts the others', () => {
    const source = `
      const a = await import('./lazy');
      const b = require("./cjs");
      import legacy = require('./legacy');
      const c = await import(name);
      const d = require(\`./dir/\${file}\`);
      const e = await import(\`./template-without-expression\`);
    `;

    const result = extractImports(source);

    expect(result.imports.map((ref) => [ref.specifier, ref.kind])).toEqual([
      ['./lazy', 'dynamic-import'],
      ['./cjs', 'require'],
      ['./legacy', 'require'],
      ['./template-without-expression', 'dynamic-import'],
    ]);
    expect(result.nonLiteralDynamic).toBe(2);
  });

  it('ignores imports inside comments, strings, templates and regular expressions', () => {
    const source = `
      // import fake from './line-comment';
      /* import fake from './block-comment'; */
      const s = "import fake from './in-string'";
      const t = \`import fake from './in-template' \${ "import x from './in-expression'" }\`;
      const r = /import\\s+from\\s+['"]\\.\\/in-regex['"]/;
      import real from './real';
    `;

    expect(specifiers(source)).toEqual(['./real']);
  });

  it('ignores property names, import.meta and object keys', () => {
    const source = `
      const url = import.meta.url;
      const o = { import: 1, require: 2 };
      obj.import('./not-a-module');
      loader.require('./not-a-module-either');
      function require(name) { return name; }
      import real from './real';
    `;

    expect(specifiers(source)).toEqual(['./real']);
  });

  it('is not confused by JSX text, division and unterminated quotes', () => {
    const source = `
      import React from 'react';
      const ratio = total / count / 2;
      const el = <p>Don't panic</p>;
      const q = "it's";
      import next from './next';
    `;

    expect(specifiers(source)).toEqual(['react', './next']);
  });

  it('deduplicates identical imports and strips a byte order mark', () => {
    expect(specifiers("\uFEFFimport a from './a';\nimport b from './a';")).toEqual(['./a']);
  });

  it('returns nothing for empty or import-free source', () => {
    expect(extractImports('').imports).toEqual([]);
    expect(extractImports('export const a = 1;\nfunction f() {}').imports).toEqual([]);
  });
});
