import { describe, expect, it } from 'vitest';

import {
  parseNameStatusZ,
  parseNulSeparatedPaths,
  parseNumstatZ,
  parsePatchSections,
} from '../../src/core/diff/diff-parser.js';
import { detectLanguage } from '../../src/core/diff/diff.types.js';
import { takeWithinBudget } from '../../src/shared/budget.js';

describe('parseNameStatusZ', () => {
  it('parses every status, renames, copies, spaces, unicode and newlines in names', () => {
    const output = [
      'M', 'src/a.ts',
      'A', 'docs/new file.md',
      'D', 'gone.ts',
      'R100', 'old.ts', 'new.ts',
      'C75', 'orig.ts', 'copy.ts',
      'T', 'link',
      'U', 'conflict.ts',
      'X', 'strange.ts',
      'M', 'src/ünï.ts',
      'M', 'line\nbreak.ts',
      '',
    ].join('\0');

    expect(parseNameStatusZ(output)).toEqual([
      { status: 'modified', path: 'src/a.ts' },
      { status: 'added', path: 'docs/new file.md' },
      { status: 'deleted', path: 'gone.ts' },
      { status: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
      { status: 'copied', path: 'copy.ts', oldPath: 'orig.ts' },
      { status: 'typeChanged', path: 'link' },
      { status: 'unmerged', path: 'conflict.ts' },
      { status: 'unknown', path: 'strange.ts' },
      { status: 'modified', path: 'src/ünï.ts' },
      { status: 'modified', path: 'line\nbreak.ts' },
    ]);
  });

  it('drops an incomplete trailing record and handles empty output', () => {
    expect(parseNameStatusZ('M\0a.ts\0R100\0old.ts')).toEqual([{ status: 'modified', path: 'a.ts' }]);
    expect(parseNameStatusZ('')).toEqual([]);
  });
});

describe('parseNumstatZ', () => {
  it('parses counts, binary files, renames and paths with spaces', () => {
    const output = ['1\t2\tsrc/a.ts', '-\t-\tassets/logo.bin', '3\t0\t', 'old.ts', 'new.ts', '0\t0\tdocs/old name.md', ''].join('\0');

    const map = parseNumstatZ(output);

    expect(map.get('src/a.ts')).toEqual({ additions: 1, deletions: 2, isBinary: false });
    expect(map.get('assets/logo.bin')).toEqual({ additions: null, deletions: null, isBinary: true });
    expect(map.get('new.ts')).toEqual({ additions: 3, deletions: 0, isBinary: false });
    expect(map.has('old.ts')).toBe(false);
    expect(map.get('docs/old name.md')).toEqual({ additions: 0, deletions: 0, isBinary: false });
  });
});

describe('parseNulSeparatedPaths', () => {
  it('splits on NUL and ignores empty entries', () => {
    expect(parseNulSeparatedPaths('a.ts\0dir/b c.ts\0')).toEqual(['a.ts', 'dir/b c.ts']);
    expect(parseNulSeparatedPaths('')).toEqual([]);
  });
});

describe('parsePatchSections', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1 @@',
    '-old',
    '-old2',
    '+new',
    '+diff --git a/fake b/fake',
    '@@ -10 +9,0 @@ function x() {',
    'diff --git a/assets/logo.bin b/assets/logo.bin',
    'Binary files a/assets/logo.bin and b/assets/logo.bin differ',
    'diff --git a/old.ts b/new.ts',
    'similarity index 100%',
    'rename from old.ts',
    'rename to new.ts',
    'diff --git a/added.ts b/added.ts',
    '--- /dev/null',
    '+++ b/added.ts',
    '@@ -0,0 +1,5 @@',
    '@@ -20,0 +30,2 @@',
    '@@ -40,3 +50,3 @@',
  ].join('\n');

  it('returns one section per file with hunk ranges, defaulting omitted counts to 1', () => {
    const sections = parsePatchSections(patch, 20);

    expect(sections).toHaveLength(4);
    expect(sections[0]?.hunks).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 1 },
      { oldStart: 10, oldLines: 1, newStart: 9, newLines: 0 },
    ]);
    expect(sections[1]?.hunks).toEqual([]);
    expect(sections[2]?.hunks).toEqual([]);
    expect(sections[3]?.hunks[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 5 });
  });

  it('does not treat a content line that merely mentions "diff --git" as a file header', () => {
    expect(parsePatchSections(patch, 20)).toHaveLength(4);
  });

  it('caps hunks per file and flags the truncation', () => {
    const sections = parsePatchSections(patch, 2);

    expect(sections[3]?.hunks).toHaveLength(2);
    expect(sections[3]?.truncated).toBe(true);
    expect(sections[0]?.truncated).toBe(false);
  });
});

describe('detectLanguage', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/App.TSX', 'typescript'],
    ['types/index.d.ts', 'typescript'],
    ['lib/a.mjs', 'javascript'],
    ['a.test.js', 'javascript'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['.gitignore', 'other'],
    ['Makefile', 'other'],
    ['dir.ts/file', 'other'],
    ['image.png', 'other'],
  ])('%s is %s', (file, language) => {
    expect(detectLanguage(file)).toBe(language);
  });
});

describe('takeWithinBudget', () => {
  const items = ['aaaa', 'bbbb', 'cccc', 'dddd']; // each item costs 6 bytes as JSON plus 1 for the separator

  it('takes items in order while they fit', () => {
    expect(takeWithinBudget(items, 14)).toEqual({ taken: ['aaaa', 'bbbb'], omitted: 2 });
    expect(takeWithinBudget(items, 1000)).toEqual({ taken: items, omitted: 0 });
  });

  it('always takes the first item so that paging makes progress', () => {
    expect(takeWithinBudget(items, 0)).toEqual({ taken: ['aaaa'], omitted: 3 });
    expect(takeWithinBudget([], 0)).toEqual({ taken: [], omitted: 0 });
  });
});
