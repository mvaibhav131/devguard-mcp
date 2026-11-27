import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { RiskService } from '../core/risk/risk.service.js';
import { changeSelectionOutputSchema, changeSelectionShape } from './selection-schema.js';
import { ASSESS_RISK } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const { mode, base, head, includeUntracked, paths, files, depth } = changeSelectionShape;
const inputSchema = z.strictObject({ mode, base, head, includeUntracked, paths, files, depth });

const confidenceSchema = z.enum(['high', 'medium', 'low']);

const factorSchema = z.object({
  id: z.enum(['change_size', 'change_spread', 'blast_radius', 'test_coverage_gap', 'critical_paths', 'change_kinds']),
  name: z.string(),
  weight: z.number(),
  status: z.enum(['computed', 'unavailable']),
  metrics: z.record(z.string(), z.number()),
  normalized: z.number().nullable(),
  contribution: z.number().nullable(),
  confidence: confidenceSchema,
  evidence: z.array(z.string()),
  limitations: z.array(z.string()),
});

export const riskOutputSchema = z.object({
  schemaVersion: z.literal(1),
  scoreVersion: z.number().int(),
  precision: z.literal('heuristic'),
  selection: changeSelectionOutputSchema,
  overallScore: z.number().int(),
  band: z.enum(['low', 'medium', 'high', 'critical']),
  bands: z.array(z.object({ band: z.enum(['low', 'medium', 'high', 'critical']), min: z.number().int(), max: z.number().int() })),
  coverage: z.number(),
  confidence: confidenceSchema,
  factors: z.array(factorSchema),
  recommendations: z.array(z.string()),
  suggestedCommands: z.array(
    z.object({
      framework: z.enum(['vitest', 'jest', 'mocha', 'node:test']),
      command: z.string(),
      files: z.number().int(),
      omittedFiles: z.number().int(),
    }),
  ),
  limitations: z.array(z.string()),
  changed: z.object({ total: z.number().int(), sourceFiles: z.number().int(), testFiles: z.number().int(), otherFiles: z.number().int() }),
});

export function registerAssessRiskTool(server: McpServer, deps: ToolRuntime & { service: RiskService }): void {
  server.registerTool(
    ASSESS_RISK,
    {
      title: 'Assess risk',
      description:
        'Estimates the regression risk of a set of changes with a fixed, documented and explainable model. ' +
        'It combines six factors, each with a weight, the measured values, evidence and a confidence: change size (changed lines), change spread (files and folders), ' +
        'blast radius (files that import the changed files), test coverage gap (changed source files without a mapped test), critical paths (dependencies, CI/CD, environment, build config, security, database, payments by file name) ' +
        'and change kinds (deleted, renamed or conflicted source files). The overall score (0 to 100) is the sum of the factor contributions and maps to a band: low, medium, high, critical. ' +
        "Also returns recommendations derived from the factors and suggested commands to run the affected tests (never executed). " +
        "The changed files come from git (default: all uncommitted changes; or 'staged'; or a branch 'range') or from an explicit list in 'files', which makes the line-based factors unavailable ('coverage' < 1). " +
        'The result is HEURISTIC: it supports a review and does not predict defects. Explain the main contributing factors to the user, quote the evidence, and mention the confidence and limitations. Read-only.',
      inputSchema,
      outputSchema: riskOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(ASSESS_RISK, deps, (args, signal, progress) => deps.service.assess(args, signal, progress)),
  );
}
