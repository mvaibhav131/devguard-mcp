import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

import { MAX_REF_LENGTH } from '../shared/limits.js';
import { isSafeRefName } from '../shared/refs.js';

export const REVIEW_MY_CHANGES = 'review_my_changes';

const argsSchema = z.object({
  base: z
    .string()
    .max(MAX_REF_LENGTH)
    .refine(isSafeRefName, { message: 'Use a branch, tag or commit name such as "main".' })
    .optional()
    .describe('Compare the current branch with this base (for example "main") like a pull request. Leave empty to review uncommitted changes.'),
});

/** The text of the prompt. `base` must already be a safe ref name. */
export function buildReviewPrompt(base?: string): string {
  const scope = base
    ? `Review the changes of the current branch compared with "${base}": use mode "range" with base "${base}" in every DevGuard tool call (head defaults to HEAD).`
    : 'Review my current uncommitted changes: use the default mode in every DevGuard tool call.';

  return [
    `${scope}`,
    '',
    'Work with the DevGuard tools, in this order, and do not guess what they can tell you:',
    '1. analyze_git_diff: what changed.',
    '2. review_changes: deterministic findings (secrets, risky APIs, suppressed checks, focused tests, missing tests) in the added lines.',
    '3. analyze_change_impact: which other files may be affected.',
    '4. discover_tests: which changed files have no mapped test, and which tests are affected.',
    '5. assess_risk: the overall risk with its factors.',
    '',
    'Then write a structured review report with these sections:',
    '- Summary: two or three sentences and the risk band.',
    '- What changed: the main files and the nature of the change.',
    '- Findings: the review findings by severity, each with file, line and evidence. Never repeat a secret; the evidence is already masked.',
    '- Impact: the files that may be affected and the import chains that lead to them.',
    '- Test gaps: changed files without a mapped test, and the affected tests.',
    '- Risk: the score, the band, and the two or three factors that contribute most, each with its evidence.',
    '- Recommended actions: ordered, concrete steps.',
    '- Limitations and confidence: what the tools cannot see and how reliable the result is.',
    '',
    'Rules:',
    '- Quote the evidence from the tool results instead of paraphrasing loosely.',
    '- Impact, test and risk results are heuristic. Say so, and report the confidence and the limitations that matter here.',
    '- Review findings are pattern matches, not proof. Say which ones you consider real after reading the evidence.',
    '- If a result has truncation.truncated set to true, follow its hint or state clearly that the result is partial.',
    '- DevGuard never runs tests, so do not claim that tests pass or fail. You may suggest the commands it returns.',
    '- If a tool returns an error, show its code and hint and stop; do not make up a result.',
  ].join('\n');
}

export function registerReviewMyChangesPrompt(server: McpServer): void {
  server.registerPrompt(
    REVIEW_MY_CHANGES,
    {
      title: 'Review my changes',
      description:
        'Reviews the current git changes with the DevGuard tools (diff, impact, tests, risk) and writes a structured report with evidence, limitations and recommended actions.',
      argsSchema,
    },
    ({ base }) => ({ messages: [{ role: 'user', content: { type: 'text', text: buildReviewPrompt(base) } }] }),
  );
}
