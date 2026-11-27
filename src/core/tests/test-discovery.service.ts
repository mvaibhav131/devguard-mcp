import path from 'node:path';

import { jsonBytes } from '../../shared/budget.js';
import type { Limits } from '../../shared/limits.js';
import { pageWithinBudget, TRUNCATION_RESERVE_BYTES, type Truncation } from '../../shared/pagination.js';
import { NO_PROGRESS, type ProgressReporter } from '../../shared/progress.js';
import { ANALYSIS_STEPS, prepareAnalysis } from '../impact/analysis-input.js';
import { type ChangeSelectionInfo, type ChangedFile, type ChangeSet, type ChangeSetRequest, type ChangeSetResolver } from '../impact/change-set.js';
import { walkImporters, type ImportGraph, type ImportGraphBuilder } from '../impact/import-graph.js';
import { graphLimitations } from '../impact/limitations.js';
import { isSourceFile } from '../impact/module-resolver.js';
import type { SourceFilesPort } from '../impact/source-files.js';
import { fileStem, isTestFile } from './test-files.js';

export type FrameworkName = 'vitest' | 'jest' | 'mocha' | 'node:test';
export type Evidence = 'imports-directly' | 'imports-transitively' | 'name-match';

export interface TestDiscoveryRequest extends ChangeSetRequest {
  depth: number;
  limit: number;
  offset: number;
}

export type DiscoveryOptions = Pick<TestDiscoveryRequest, 'depth' | 'limit' | 'offset'>;

export interface TestLink {
  path: string;
  framework: FrameworkName | 'unknown';
  evidence: Evidence;
  /** Import distance from the changed file, for imports-* evidence. */
  depth?: number;
}

export interface TestMapping {
  file: string;
  status: string;
  tests: TestLink[];
  /** Tests that were found but not listed. */
  moreTests: number;
}

export interface SuggestedCommand {
  framework: FrameworkName;
  command: string;
  files: number;
  omittedFiles: number;
}

export interface TestDiscovery {
  schemaVersion: 1;
  precision: 'heuristic';
  selection: ChangeSelectionInfo;
  frameworks: { name: FrameworkName; evidence: string[] }[];
  changed: { total: number; sourceFiles: number; testFiles: number; otherFiles: number };
  summary: { changedSourceFiles: number; withTests: number; withoutTests: number; affectedTestFiles: number };
  untested: { total: number; paths: string[] };
  affectedTests: { total: number; paths: string[] };
  suggestedCommands: SuggestedCommand[];
  limitations: string[];
  mapping: TestMapping[];
  truncation: Truncation;
}

export interface TestDiscoveryDeps {
  changes: ChangeSetResolver;
  graphBuilder: ImportGraphBuilder;
  source: Pick<SourceFilesPort, 'readText'>;
  limits: Limits;
}

const MAX_TESTS_PER_FILE = 10;
const MAX_LISTED_PATHS = 50;
const MAX_FILES_PER_COMMAND = 25;
const PACKAGE_JSON_BYTES = 256 * 1024;

const COMMAND_PREFIX: Readonly<Record<FrameworkName, string>> = {
  vitest: 'npx vitest run',
  jest: 'npx jest',
  mocha: 'npx mocha',
  'node:test': 'node --test',
};

const TEST_LIMITATIONS: readonly string[] = [
  'Heuristic: a test is linked to a changed file when it imports it (directly or within the given depth) or has the same file name. DevGuard does not run tests or measure coverage.',
  '"No mapped test" means no import or naming link was found. It is not proof that the code is untested, and a linked test may not exercise the change.',
  'Test files are recognised by name (*.test.* and *.spec.* files, and files under __tests__). Other layouts are not detected.',
  'The framework is detected from package.json, root configuration files and imports in test files.',
  'Suggested commands are only suggestions and are never executed. They use the framework defaults and do not know custom include or exclude rules, workspaces or separate configurations.',
];

function quoteArgument(value: string): string {
  return /^[\w./@-]+$/.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export class TestDiscoveryService {
  constructor(private readonly deps: TestDiscoveryDeps) {}

  async discover(request: TestDiscoveryRequest, signal?: AbortSignal, progress: ProgressReporter = NO_PROGRESS): Promise<TestDiscovery> {
    const { changeSet, graph } = await prepareAnalysis(this.deps.changes, this.deps.graphBuilder, request, signal, progress);
    const result = await this.discoverChangeSet(changeSet, graph, request);
    progress(ANALYSIS_STEPS, ANALYSIS_STEPS, 'Done');
    return result;
  }

  /** The discovery itself, for callers that already resolved the change set and built the graph. */
  async discoverChangeSet(changeSet: ChangeSet, graph: ImportGraph, request: DiscoveryOptions): Promise<TestDiscovery> {
    const { limits } = this.deps;

    const testFiles = [...graph.files].filter(isTestFile).sort(byPath);
    const frameworks = await this.detectFrameworks(graph, testFiles);
    const frameworkOf = (file: string): FrameworkName | 'unknown' => this.frameworkOf(file, graph, frameworks.map((f) => f.name));

    const testsByStem = new Map<string, string[]>();
    for (const file of testFiles) {
      const stem = fileStem(file);
      testsByStem.set(stem, [...(testsByStem.get(stem) ?? []), file]);
    }

    const isTestable = (file: ChangedFile): boolean => isSourceFile(file.path) && !isTestFile(file.path) && !file.path.endsWith('.d.ts');
    const changedTests = changeSet.files.filter((file) => isSourceFile(file.path) && isTestFile(file.path)).map((file) => file.path);
    const changedSources = changeSet.files.filter(isTestable).sort((a, b) => byPath(a.path, b.path));

    const affected = new Set<string>(changedTests);
    const mapping: TestMapping[] = [];
    const untested: string[] = [];

    for (const file of changedSources) {
      const identities = [file.path, ...(file.oldPath !== undefined ? [file.oldPath] : [])];
      const links = new Map<string, TestLink>();

      for (const identity of identities) {
        const hits = walkImporters(graph, [identity], request.depth, new Set(identities));
        for (const [importer, hit] of hits) {
          if (!isTestFile(importer) || links.has(importer)) continue;
          links.set(importer, {
            path: importer,
            framework: frameworkOf(importer),
            evidence: hit.depth === 1 ? 'imports-directly' : 'imports-transitively',
            depth: hit.depth,
          });
        }
      }

      const stem = fileStem(file.path);
      if (stem !== 'index') {
        for (const testPath of testsByStem.get(stem) ?? []) {
          if (!links.has(testPath)) links.set(testPath, { path: testPath, framework: frameworkOf(testPath), evidence: 'name-match' });
        }
      }

      const rank: Record<Evidence, number> = { 'imports-directly': 0, 'imports-transitively': 1, 'name-match': 2 };
      const tests = [...links.values()].sort((a, b) => rank[a.evidence] - rank[b.evidence] || (a.depth ?? 0) - (b.depth ?? 0) || byPath(a.path, b.path));
      for (const test of tests) affected.add(test.path);

      mapping.push({ file: file.path, status: file.status, tests: tests.slice(0, MAX_TESTS_PER_FILE), moreTests: Math.max(0, tests.length - MAX_TESTS_PER_FILE) });
      if (tests.length === 0 && file.status !== 'deleted') untested.push(file.path);
    }

    const affectedPaths = [...affected].sort(byPath);
    const otherFiles = changeSet.files.length - changedSources.length - changedTests.length;
    const limitations = [...TEST_LIMITATIONS, ...graphLimitations(graph.stats)];
    if (testFiles.length === 0) limitations.push('No test files (*.test.* or *.spec.*) were found in the workspace.');

    const skeleton = {
      schemaVersion: 1,
      precision: 'heuristic',
      selection: changeSet.selection,
      frameworks,
      changed: { total: changeSet.files.length, sourceFiles: changedSources.length, testFiles: changedTests.length, otherFiles },
      summary: {
        changedSourceFiles: changedSources.length,
        withTests: mapping.filter((entry) => entry.tests.length > 0).length,
        withoutTests: untested.length,
        affectedTestFiles: affectedPaths.length,
      },
      untested: { total: untested.length, paths: untested.slice(0, MAX_LISTED_PATHS) },
      affectedTests: { total: affectedPaths.length, paths: affectedPaths.slice(0, MAX_LISTED_PATHS) },
      suggestedCommands: this.suggestCommands(affectedPaths, frameworkOf),
      limitations,
      mapping: [] as TestMapping[],
    } as const;

    const { page, truncation } = pageWithinBudget(mapping, {
      offset: request.offset,
      limit: request.limit,
      budgetBytes: limits.maxResponseBytes - jsonBytes(skeleton) - TRUNCATION_RESERVE_BYTES,
      scanLimited: changeSet.scanLimited || graph.stats.limited,
      noun: 'changed files',
      narrowAdvice: 'analyse fewer changed files',
      scanNote: 'The change set or the source tree is larger than DevGuard analyses (see "limitations").',
    });

    return { ...skeleton, mapping: page, truncation };
  }

  private async detectFrameworks(graph: ImportGraph, testFiles: readonly string[]): Promise<{ name: FrameworkName; evidence: string[] }[]> {
    const evidence = new Map<FrameworkName, string[]>();
    const add = (name: FrameworkName, text: string): void => {
      evidence.set(name, [...(evidence.get(name) ?? []), text]);
    };

    const outcome = await this.deps.source.readText('package.json', PACKAGE_JSON_BYTES);
    if (outcome.status === 'ok') {
      try {
        const pkg = JSON.parse(outcome.text) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; scripts?: Record<string, unknown> };
        const dependencies = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
        for (const name of ['vitest', 'jest', 'mocha'] as const) {
          if (dependencies.has(name)) add(name, `package.json lists "${name}"`);
        }
        for (const name of ['@jest/globals', 'ts-jest', 'babel-jest']) {
          if (dependencies.has(name)) add('jest', `package.json lists "${name}"`);
        }

        const script = typeof pkg.scripts?.['test'] === 'string' ? pkg.scripts['test'] : '';
        const label = `package.json script "test": ${JSON.stringify(script.slice(0, 80))}`;
        if (/\bvitest\b/.test(script)) add('vitest', label);
        if (/\bjest\b/.test(script)) add('jest', label);
        if (/\bmocha\b/.test(script)) add('mocha', label);
        if (/\bnode\s+(?:\S+\s+)*--test\b/.test(script)) add('node:test', label);
      } catch {
        // An unreadable package.json simply yields no evidence.
      }
    }

    for (const file of graph.allPaths) {
      if (file.includes('/')) continue;
      if (/^vitest\.(?:config|workspace)\./.test(file)) add('vitest', `configuration file ${file}`);
      else if (/^jest\.config\./.test(file)) add('jest', `configuration file ${file}`);
      else if (/^\.mocharc/.test(file)) add('mocha', `configuration file ${file}`);
    }

    const importsOf = (specifier: string): boolean => testFiles.some((file) => graph.externals.get(file)?.includes(specifier));
    if (importsOf('vitest')) add('vitest', 'test files import "vitest"');
    if (importsOf('@jest/globals')) add('jest', 'test files import "@jest/globals"');
    if (importsOf('mocha')) add('mocha', 'test files import "mocha"');
    if (importsOf('node:test')) add('node:test', 'test files import "node:test"');

    return [...evidence].map(([name, items]) => ({ name, evidence: items })).sort((a, b) => byPath(a.name, b.name));
  }

  private frameworkOf(file: string, graph: ImportGraph, detected: readonly FrameworkName[]): FrameworkName | 'unknown' {
    const specifiers = graph.externals.get(file) ?? [];
    if (specifiers.includes('vitest')) return 'vitest';
    if (specifiers.includes('@jest/globals')) return 'jest';
    if (specifiers.includes('node:test')) return 'node:test';
    if (specifiers.includes('mocha')) return 'mocha';

    // Globals style (jest, mocha, vitest with globals): only unambiguous when a single framework is configured.
    const globalStyle = detected.filter((name) => name !== 'node:test');
    return globalStyle.length === 1 ? (globalStyle[0] as FrameworkName) : 'unknown';
  }

  private suggestCommands(testPaths: readonly string[], frameworkOf: (file: string) => FrameworkName | 'unknown'): SuggestedCommand[] {
    const groups = new Map<FrameworkName, string[]>();
    for (const file of testPaths) {
      const framework = frameworkOf(file);
      if (framework === 'unknown') continue;
      groups.set(framework, [...(groups.get(framework) ?? []), file]);
    }

    return [...groups]
      .sort(([a], [b]) => byPath(a, b))
      .map(([framework, files]) => {
        const listed = files.slice(0, MAX_FILES_PER_COMMAND);
        return {
          framework,
          command: `${COMMAND_PREFIX[framework]} ${listed.map((file) => quoteArgument(path.posix.normalize(file))).join(' ')}`,
          files: listed.length,
          omittedFiles: files.length - listed.length,
        };
      });
  }
}
