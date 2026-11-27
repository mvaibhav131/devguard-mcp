import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const read = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), 'utf8');

interface PackageJson {
  name: string;
  private?: boolean;
  bin?: Record<string, string>;
  files?: string[];
  scripts: Record<string, string>;
  engines: { node: string };
  dependencies: Record<string, string>;
}

const pkg = JSON.parse(read('package.json')) as PackageJson;

describe('package metadata', () => {
  it('exposes the compiled entry point as the devguard-mcp command, and the entry has a shebang', () => {
    expect(pkg.bin).toEqual({ 'devguard-mcp': 'dist/index.js' });
    expect(/^#!\/usr\/bin\/env node\r?\n/.test(read('src/index.ts'))).toBe(true);
    // Emitted files use LF on every OS, so the shebang works when the package is installed on Linux and macOS.
    expect(read('tsconfig.build.json')).toContain('"newLine": "lf"');
  });

  it('ships only compiled code and the README, without source maps, tests or docs', () => {
    expect(pkg.files).toEqual(['dist/**/*.js', 'README.md']);
  });

  it('builds before packing and verifies before publishing', () => {
    expect(pkg.scripts['prepack']).toBe('npm run build');
    expect(pkg.scripts['prepublishOnly']).toContain('npm test');
  });

  it('keeps exactly two runtime dependencies with exact versions', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['@modelcontextprotocol/server', 'zod']);
    for (const version of Object.values(pkg.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('requires a Node.js version that the dependencies support', () => {
    expect(pkg.engines.node).toBe('>=22.12.0');
  });
});
