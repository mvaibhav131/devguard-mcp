import * as z from 'zod/v4';

import {
  DEFAULT_IMPACT_DEPTH,
  DEFAULT_PAGE_SIZE,
  MAX_EXPLICIT_FILES,
  MAX_IMPACT_DEPTH,
  MAX_PAGE_SIZE,
  MAX_PATH_LENGTH,
  MAX_PATHS_PER_REQUEST,
  MAX_REF_LENGTH,
} from '../shared/limits.js';

const modeSchema = z.enum(['workingTree', 'staged', 'range']);

/** Input fields shared by the tools that work on a set of changed files. */
export const changeSelectionShape = {
  mode: modeSchema
    .optional()
    .describe(
      "Where the changed files come from. 'workingTree' (default): all uncommitted changes compared with HEAD, plus untracked files. " +
        "'staged': only staged changes. 'range': changes on 'head' since it diverged from 'base' (like a pull request); requires 'base'. " +
        "Not allowed together with 'files'.",
    ),
  base: z.string().max(MAX_REF_LENGTH).optional().describe("Only for mode 'range': base branch, tag or commit, for example 'main'."),
  head: z.string().max(MAX_REF_LENGTH).optional().describe("Only for mode 'range': branch, tag or commit to compare. Defaults to HEAD."),
  includeUntracked: z.boolean().default(true).describe('Include files that git does not track yet (respecting .gitignore).'),
  paths: z
    .array(z.string().min(1).max(MAX_PATH_LENGTH))
    .max(MAX_PATHS_PER_REQUEST)
    .optional()
    .describe("Limit the git changes to these files or folders, relative to the repository root, for example ['src/core']."),
  files: z
    .array(z.string().min(1).max(MAX_PATH_LENGTH))
    .max(MAX_EXPLICIT_FILES)
    .optional()
    .describe("Analyse exactly these files (repository-relative) instead of reading git changes. Not allowed together with 'mode', 'base', 'head' or 'paths'."),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_IMPACT_DEPTH)
    .default(DEFAULT_IMPACT_DEPTH)
    .describe('How many import levels to follow: 1 = direct importers only.'),
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE).describe('Maximum number of items to return.'),
  offset: z.number().int().min(0).default(0).describe("Number of items to skip. Use 'truncation.nextOffset' from the previous result."),
};

const resolvedRefSchema = z.object({ input: z.string(), sha: z.string() });

export const changeSelectionOutputSchema = z.object({
  source: z.enum(['git', 'files']),
  mode: modeSchema.optional(),
  base: resolvedRefSchema.optional(),
  head: resolvedRefSchema.optional(),
  paths: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  includeUntracked: z.boolean().optional(),
});

export const truncationOutputSchema = z.object({
  truncated: z.boolean(),
  reason: z.enum(['FILE_LIMIT', 'BYTE_BUDGET', 'SCAN_LIMIT']).optional(),
  returned: z.number().int(),
  total: z.number().int(),
  omitted: z.number().int(),
  nextOffset: z.number().int().optional(),
  hint: z.string().optional(),
});
