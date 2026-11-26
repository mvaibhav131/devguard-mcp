import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { TestDiscoveryService } from '../core/tests/test-discovery.service.js';
import { changeSelectionOutputSchema, changeSelectionShape, truncationOutputSchema } from './selection-schema.js';
import { DISCOVER_TESTS } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const inputSchema = z.strictObject(changeSelectionShape);

const frameworkSchema = z.enum(['vitest', 'jest', 'mocha', 'node:test']);

export const testDiscoveryOutputSchema = z.object({
  schemaVersion: z.literal(1),
  precision: z.literal('heuristic'),
  selection: changeSelectionOutputSchema,
  frameworks: z.array(z.object({ name: frameworkSchema, evidence: z.array(z.string()) })),
  changed: z.object({ total: z.number().int(), sourceFiles: z.number().int(), testFiles: z.number().int(), otherFiles: z.number().int() }),
  summary: z.object({
    changedSourceFiles: z.number().int(),
    withTests: z.number().int(),
    withoutTests: z.number().int(),
    affectedTestFiles: z.number().int(),
  }),
  untested: z.object({ total: z.number().int(), paths: z.array(z.string()) }),
  affectedTests: z.object({ total: z.number().int(), paths: z.array(z.string()) }),
  suggestedCommands: z.array(
    z.object({ framework: frameworkSchema, command: z.string(), files: z.number().int(), omittedFiles: z.number().int() }),
  ),
  limitations: z.array(z.string()),
  mapping: z.array(
    z.object({
      file: z.string(),
      status: z.string(),
      tests: z.array(
        z.object({
          path: z.string(),
          framework: z.enum(['vitest', 'jest', 'mocha', 'node:test', 'unknown']),
          evidence: z.enum(['imports-directly', 'imports-transitively', 'name-match']),
          depth: z.number().int().optional(),
        }),
      ),
      moreTests: z.number().int(),
    }),
  ),
  truncation: truncationOutputSchema,
});

export function registerDiscoverTestsTool(server: McpServer, deps: ToolRuntime & { service: TestDiscoveryService }): void {
  server.registerTool(
    DISCOVER_TESTS,
    {
      title: 'Discover tests',
      description:
        'Finds the test files related to a set of changed files and shows which changed source files appear to have no tests. ' +
        'Detects the test framework (vitest, jest, mocha, node:test) from package.json, configuration files and imports in test files. ' +
        "Maps each changed source file to tests that import it directly or transitively, or that share its file name (for example src/a.ts and a.test.ts), " +
        'lists the affected test files and suggests commands to run them (it never runs anything). ' +
        "The changed files come from git (default: all uncommitted changes; or 'staged'; or a branch 'range') or from an explicit list in 'files'. " +
        "The result is HEURISTIC: DevGuard does not run tests or measure coverage, and 'no mapped test' means no import or naming link was found, not that the code is untested. " +
        "State that caveat in your answer. Results are paged and size-limited: when 'truncation.truncated' is true, follow 'truncation.hint'. Read-only.",
      inputSchema,
      outputSchema: testDiscoveryOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(DISCOVER_TESTS, deps, (args, signal) => deps.service.discover(args, signal)),
  );
}
