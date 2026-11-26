import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const srcRoot = fileURLToPath(new URL('../../src', import.meta.url));

interface SourceFile {
  relativePath: string;
  content: string;
  imports: string[];
}

const files: SourceFile[] = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
  .filter((entry) => entry.endsWith('.ts'))
  .map((entry) => {
    const relativePath = entry.replaceAll('\\', '/');
    const content = readFileSync(path.join(srcRoot, entry), 'utf8');
    const imports = [...content.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '');
    return { relativePath, content, imports };
  });

const importers = (predicate: (specifier: string) => boolean): string[] =>
  files.filter((file) => file.imports.some(predicate)).map((file) => file.relativePath).sort();

describe('architecture boundaries', () => {
  it('finds the source files', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('keeps core free of I/O, the SDK and outer layers', () => {
    const forbidden = /^node:(fs|child_process)|^@modelcontextprotocol\/|^zod|\/(infrastructure|tools|config)\//;
    const violations = files
      .filter((file) => file.relativePath.startsWith('core/'))
      .filter((file) => file.imports.some((specifier) => forbidden.test(specifier)))
      .map((file) => file.relativePath);

    expect(violations).toEqual([]);
  });

  it('spawns processes only in the process runner and touches the filesystem only in workspace-fs', () => {
    expect(importers((specifier) => specifier.startsWith('node:child_process'))).toEqual(['infrastructure/process/process-runner.ts']);
    expect(importers((specifier) => /^node:fs/.test(specifier))).toEqual(['infrastructure/fs/workspace-fs.ts']);
  });

  it('confines the MCP SDK and zod to the entry points and the tools layer', () => {
    const sdkUsers = importers((specifier) => specifier.startsWith('@modelcontextprotocol/'));
    expect(sdkUsers.every((file) => file === 'index.ts' || file === 'server.ts' || file.startsWith('tools/'))).toBe(true);

    const zodUsers = importers((specifier) => specifier.startsWith('zod'));
    expect(zodUsers.every((file) => file.startsWith('tools/'))).toBe(true);
  });

  it('never writes to stdout, which is reserved for the MCP protocol', () => {
    const offenders = files
      .filter((file) => /\bconsole\.(log|info|debug)\s*\(|\bprocess\.stdout\b/.test(file.content))
      .map((file) => file.relativePath);

    expect(offenders).toEqual([]);
  });
});
