import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { ReviewService } from '../core/review/review.service.js';
import { changeSelectionOutputSchema, changeSelectionShape, truncationOutputSchema } from './selection-schema.js';
import { REVIEW_CHANGES } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const { mode, base, head, includeUntracked, paths, limit, offset } = changeSelectionShape;

const severitySchema = z.enum(['error', 'warning', 'info']);
const categorySchema = z.enum(['security', 'correctness', 'maintainability', 'tests']);

const inputSchema = z.strictObject({
  mode,
  base,
  head,
  includeUntracked,
  paths,
  minSeverity: severitySchema.default('info').describe("Only report findings of this severity or higher. Order: 'error', 'warning', 'info'."),
  categories: z.array(categorySchema).max(4).optional().describe('Only run the rules of these categories. Default: all.'),
  limit,
  offset,
});

const ruleInfoShape = {
  id: z.string(),
  category: categorySchema,
  severity: severitySchema,
  description: z.string(),
  suggestion: z.string(),
};

export const reviewOutputSchema = z.object({
  schemaVersion: z.literal(1),
  precision: z.literal('heuristic'),
  selection: changeSelectionOutputSchema,
  summary: z.object({
    filesReviewed: z.number().int(),
    addedLinesScanned: z.number().int(),
    findings: z.number().int(),
    bySeverity: z.record(z.string(), z.number().int()),
    byCategory: z.record(z.string(), z.number().int()),
  }),
  coverage: z.object({
    untrackedFilesRead: z.number().int(),
    skippedFiles: z.object({ generated: z.number().int(), binary: z.number().int(), unreadable: z.number().int(), overCap: z.number().int() }),
    patchComplete: z.boolean(),
    patchAligned: z.boolean(),
  }),
  rulesRun: z.array(z.string()),
  rules: z.array(z.object({ ...ruleInfoShape, count: z.number().int() })),
  limitations: z.array(z.string()),
  findings: z.array(
    z.object({
      rule: z.string(),
      category: categorySchema,
      severity: severitySchema,
      file: z.string(),
      line: z.number().int().optional(),
      evidence: z.string(),
    }),
  ),
  truncation: truncationOutputSchema,
});

export function registerReviewChangesTool(server: McpServer, deps: ToolRuntime & { service: ReviewService }): void {
  server.registerTool(
    REVIEW_CHANGES,
    {
      title: 'Review changes',
      description:
        'Reviews the lines added by a set of git changes with deterministic rules and returns findings with evidence. ' +
        'Rules cover security (hard-coded secrets and private keys, eval, raw HTML, shell command injection patterns, disabled TLS verification, weak hashes), ' +
        'correctness (@ts-ignore, empty catch blocks, debugger statements, the any type, lint disables), tests (focused or skipped tests, changed files without a mapped test) ' +
        'and maintainability (TODO markers, console output, very large additions). ' +
        'Only added lines are examined, never existing code; generated files and lock files are skipped; secrets are masked in the evidence. ' +
        "Each finding has rule, severity (error, warning, info), file, line and evidence; every triggered rule is explained once in 'rules' with a suggestion. " +
        "The changed files come from git (default: all uncommitted changes including untracked files; or 'staged'; or a branch 'range' like a pull request). " +
        'The result is HEURISTIC: line-based pattern matching, not a parser or a security scanner, so verify a finding before acting on it and say so in your answer. ' +
        "Filter with 'minSeverity' and 'categories'. Results are ordered by severity, paged and size-limited: when 'truncation.truncated' is true, follow 'truncation.hint'. Read-only.",
      inputSchema,
      outputSchema: reviewOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(REVIEW_CHANGES, deps, (args, signal, progress) => deps.service.review({ ...args, mode: args.mode ?? 'workingTree' }, signal, progress)),
  );
}
