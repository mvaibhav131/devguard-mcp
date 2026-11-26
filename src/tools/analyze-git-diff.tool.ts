import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import type { DiffService } from '../core/diff/diff.service.js';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PATH_LENGTH,
  MAX_PATHS_PER_REQUEST,
  MAX_REF_LENGTH,
} from '../shared/limits.js';
import { ANALYZE_GIT_DIFF } from './tool-names.js';
import { READ_ONLY_TOOL_ANNOTATIONS, toolHandler, type ToolRuntime } from './tool-result.js';

const inputSchema = z.strictObject({
  mode: z
    .enum(['workingTree', 'staged', 'range'])
    .default('workingTree')
    .describe(
      "'workingTree' (default): all uncommitted changes compared with HEAD, plus untracked files. " +
        "'staged': only staged changes. " +
        "'range': changes on 'head' since it diverged from 'base' (like a pull request); requires 'base'.",
    ),
  base: z.string().max(MAX_REF_LENGTH).optional().describe("Only for mode 'range': base branch, tag or commit, for example 'main'."),
  head: z.string().max(MAX_REF_LENGTH).optional().describe("Only for mode 'range': branch, tag or commit to compare. Defaults to HEAD."),
  includeUntracked: z
    .boolean()
    .default(true)
    .describe('Include files that git does not track yet (respecting .gitignore). Their line counts are null.'),
  paths: z
    .array(z.string().min(1).max(MAX_PATH_LENGTH))
    .max(MAX_PATHS_PER_REQUEST)
    .optional()
    .describe("Limit the analysis to these files or folders, relative to the repository root, for example ['src/core']."),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe('Maximum number of files to return.'),
  offset: z.number().int().min(0).default(0).describe("Number of files to skip. Use 'truncation.nextOffset' from the previous result."),
});

const fileSchema = z.object({
  path: z.string(),
  oldPath: z.string().optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'typeChanged', 'unmerged', 'untracked', 'unknown']),
  language: z.enum(['typescript', 'javascript', 'json', 'markdown', 'other']),
  additions: z.number().int().nullable(),
  deletions: z.number().int().nullable(),
  isBinary: z.boolean(),
  hunks: z
    .array(z.object({ oldStart: z.number().int(), oldLines: z.number().int(), newStart: z.number().int(), newLines: z.number().int() }))
    .optional(),
  hunksTruncated: z.boolean().optional(),
});

const resolvedRefSchema = z.object({ input: z.string(), sha: z.string() });

export const diffAnalysisOutputSchema = z.object({
  schemaVersion: z.literal(1),
  selection: z.object({
    mode: z.enum(['workingTree', 'staged', 'range']),
    base: resolvedRefSchema.optional(),
    head: resolvedRefSchema.optional(),
    paths: z.array(z.string()).optional(),
    includeUntracked: z.boolean(),
  }),
  summary: z.object({
    filesChanged: z.number().int(),
    additions: z.number().int(),
    deletions: z.number().int(),
    binaryFiles: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    byLanguage: z.record(z.string(), z.number().int()),
  }),
  hunkCoverage: z.enum(['complete', 'partial', 'unavailable']),
  files: z.array(fileSchema),
  truncation: z.object({
    truncated: z.boolean(),
    reason: z.enum(['FILE_LIMIT', 'BYTE_BUDGET', 'SCAN_LIMIT']).optional(),
    returned: z.number().int(),
    total: z.number().int(),
    omitted: z.number().int(),
    nextOffset: z.number().int().optional(),
    hint: z.string().optional(),
  }),
});

export function registerAnalyzeGitDiffTool(server: McpServer, deps: ToolRuntime & { service: DiffService }): void {
  server.registerTool(
    ANALYZE_GIT_DIFF,
    {
      title: 'Analyze git diff',
      description:
        "Analyses the Git changes of the workspace repository and returns structured, deterministic facts: per-file status (added, modified, deleted, renamed, untracked), " +
        'added and deleted line counts, language, and changed line ranges (hunks), plus a summary over all changed files. ' +
        "Modes: 'workingTree' (default) for uncommitted work, 'staged' for the index only, 'range' to compare a branch with a base like a pull request. " +
        'It does not return file contents or patch text. Results are ordered by amount of change, paged and size-limited: ' +
        "when 'truncation.truncated' is true, follow 'truncation.hint' (for example call again with the given offset) and mention that the result is partial. " +
        'Read-only.',
      inputSchema,
      outputSchema: diffAnalysisOutputSchema,
      annotations: READ_ONLY_TOOL_ANNOTATIONS,
    },
    toolHandler(ANALYZE_GIT_DIFF, deps, (args, signal) => deps.service.analyze(args, signal)),
  );
}
