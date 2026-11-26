import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { ImpactService } from '../core/impact/impact.service.js';
import { changeSelectionOutputSchema, changeSelectionShape, truncationOutputSchema } from './selection-schema.js';
import { ANALYZE_CHANGE_IMPACT } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const inputSchema = z.strictObject({
  ...changeSelectionShape,
  includeTests: z.boolean().default(true).describe('Include test files in the list of impacted files.'),
});

export const impactOutputSchema = z.object({
  schemaVersion: z.literal(1),
  precision: z.literal('heuristic'),
  selection: changeSelectionOutputSchema,
  changed: z.object({ total: z.number().int(), sourceFiles: z.number().int(), otherFiles: z.number().int() }),
  depth: z.number().int(),
  summary: z.object({ impacted: z.number().int(), direct: z.number().int(), transitive: z.number().int(), tests: z.number().int() }),
  hotspots: z.array(z.object({ path: z.string(), directImporters: z.number().int() })),
  unresolved: z.object({
    total: z.number().int(),
    items: z.array(
      z.object({
        importer: z.string(),
        specifier: z.string(),
        reason: z.enum(['file-not-found', 'alias-target-not-found', 'package-imports-unsupported', 'outside-workspace', 'absolute-path']),
      }),
    ),
  }),
  graph: z.object({
    sourceFilesRead: z.number().int(),
    edges: z.number().int(),
    externalImports: z.number().int(),
    unresolvedImports: z.number().int(),
    nonLiteralDynamicImports: z.number().int(),
    limited: z.boolean(),
  }),
  limitations: z.array(z.string()),
  impacted: z.array(
    z.object({
      path: z.string(),
      relation: z.enum(['direct', 'transitive']),
      depth: z.number().int(),
      via: z.array(z.string()),
      isTest: z.boolean(),
    }),
  ),
  truncation: truncationOutputSchema,
});

export function registerAnalyzeChangeImpactTool(server: McpServer, deps: ToolRuntime & { service: ImpactService }): void {
  server.registerTool(
    ANALYZE_CHANGE_IMPACT,
    {
      title: 'Analyze change impact',
      description:
        'Finds which other TypeScript or JavaScript files may be affected by a set of changed files, by following imports backwards: ' +
        'who imports the changed files, and who imports those, up to a depth. ' +
        "The changed files come from git (default: all uncommitted changes; or 'staged'; or a branch 'range' like a pull request) or from an explicit list in 'files'. " +
        "Returns impacted files with relation 'direct' or 'transitive', the import chain ('via'), hotspots (changed files with the most direct importers), " +
        'imports that could not be resolved, and an explicit list of limitations. ' +
        'The result is HEURISTIC: static imports are followed, but dependency injection, events, computed dynamic imports, barrel re-exports and non-source changes (package.json, tsconfig) are not. ' +
        'Treat it as a starting point for review, not as proof, and say so in your answer. ' +
        "Results are ordered, paged and size-limited: when 'truncation.truncated' is true, follow 'truncation.hint'. Read-only.",
      inputSchema,
      outputSchema: impactOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(ANALYZE_CHANGE_IMPACT, deps, (args, signal) => deps.service.analyze(args, signal)),
  );
}
