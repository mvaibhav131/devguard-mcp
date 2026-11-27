import path from 'node:path';

import type { AddedLine } from '../diff/diff-parser.js';
import { detectLanguage, type Language } from '../diff/diff.types.js';
import { hasExcludedSegment } from '../impact/module-resolver.js';
import { isTestFile } from '../tests/test-files.js';

export type Severity = 'error' | 'warning' | 'info';
export type Category = 'security' | 'correctness' | 'maintainability' | 'tests';

export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { error: 0, warning: 1, info: 2 };

export interface RuleInfo {
  id: string;
  category: Category;
  severity: Severity;
  description: string;
  suggestion: string;
}

export interface RuleContext {
  path: string;
  language: Language;
  isTest: boolean;
  /** TypeScript or JavaScript. */
  isCode: boolean;
}

export interface Finding {
  rule: string;
  category: Category;
  severity: Severity;
  file: string;
  /** Absent for findings about a whole file. */
  line?: number;
  /** The offending line, trimmed. Secrets are masked and never leave the server. */
  evidence: string;
}

interface LineRule extends RuleInfo {
  appliesTo: (context: RuleContext) => boolean;
  /** Rules for markers that live in comments also look at comment lines; the others skip them. */
  includeComments?: boolean;
  /** The evidence to report (already masked), or undefined when the line is fine. */
  match: (text: string) => string | undefined;
}

const MAX_EVIDENCE_LENGTH = 160;
const REDACTED = '[REDACTED]';

const LOCKFILES: ReadonlySet<string> = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock']);

/** Generated files and lock files are noisy and not reviewed by hand. */
export function isGeneratedPath(filePath: string): boolean {
  const name = path.posix.basename(filePath);
  return LOCKFILES.has(name) || /\.min\.[cm]?js$/.test(name) || name.endsWith('.map') || hasExcludedSegment(filePath);
}

export function contextFor(filePath: string): RuleContext {
  const language = detectLanguage(filePath);
  return { path: filePath, language, isTest: isTestFile(filePath), isCode: language === 'typescript' || language === 'javascript' };
}

const trimEvidence = (text: string): string => {
  const trimmed = text.trim();
  return trimmed.length > MAX_EVIDENCE_LENGTH ? `${trimmed.slice(0, MAX_EVIDENCE_LENGTH)}...` : trimmed;
};

const maskMatches = (text: string, pattern: RegExp): string =>
  trimEvidence(text.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), REDACTED));

const isCommentLine = (text: string): boolean => /^\s*(?:\/\/|\/\*|\*)/.test(text);

const anyText = (context: RuleContext): boolean => !isGeneratedPath(context.path);
const code = (context: RuleContext): boolean => context.isCode && !isGeneratedPath(context.path);
const productionCode = (context: RuleContext): boolean => code(context) && !context.isTest;
const testCode = (context: RuleContext): boolean => code(context) && context.isTest;
const typescriptProduction = (context: RuleContext): boolean => productionCode(context) && context.language === 'typescript';

function pattern(info: RuleInfo, expression: RegExp, appliesTo: LineRule['appliesTo'], includeComments = false): LineRule {
  return { ...info, appliesTo, includeComments, match: (text) => (expression.test(text) ? trimEvidence(text) : undefined) };
}

function secret(info: RuleInfo, expression: RegExp): LineRule {
  return { ...info, appliesTo: anyText, includeComments: true, match: (text) => (expression.test(text) ? maskMatches(text, expression) : undefined) };
}

const GENERIC_SECRET = /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token|auth[_-]?key|private[_-]?key)[A-Za-z0-9_]*)\s*[:=]\s*(['"`])([^'"`\s]{8,})\2/i;
const PLACEHOLDER = /^(?:\$\{|<|\{\{|process\.env|your[_-]|example|changeme|placeholder|x{3,}|\*{3,}|test|dummy|sample|fake|todo)/i;

const SECURITY_SUGGESTION = 'Remove it from the change, rotate it if it was ever real, and load it from the environment or a secret store.';

export const LINE_RULES: readonly LineRule[] = [
  secret(
    { id: 'secret-private-key', category: 'security', severity: 'error', description: 'A private key block was added.', suggestion: SECURITY_SUGGESTION },
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  ),
  secret(
    { id: 'secret-aws-access-key', category: 'security', severity: 'error', description: 'An AWS access key id was added.', suggestion: SECURITY_SUGGESTION },
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  ),
  secret(
    { id: 'secret-github-token', category: 'security', severity: 'error', description: 'A GitHub token was added.', suggestion: SECURITY_SUGGESTION },
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
  ),
  secret(
    { id: 'secret-slack-token', category: 'security', severity: 'error', description: 'A Slack token was added.', suggestion: SECURITY_SUGGESTION },
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  ),
  {
    id: 'secret-generic-assignment',
    category: 'security',
    severity: 'warning',
    description: 'A string literal that looks like a hard-coded credential is assigned to a name such as password, secret, token or api key.',
    suggestion: SECURITY_SUGGESTION,
    appliesTo: anyText,
    includeComments: true,
    match: (text) => {
      if (text.includes('process.env')) return undefined;
      const found = GENERIC_SECRET.exec(text);
      const value = found?.[3];
      if (value === undefined || PLACEHOLDER.test(value)) return undefined;
      return trimEvidence(text.replace(value, REDACTED));
    },
  },
  pattern(
    { id: 'dangerous-eval', category: 'security', severity: 'error', description: 'eval() or new Function() runs a string as code.', suggestion: 'Avoid dynamic code execution; use a parser, a lookup table or a safe API.' },
    /(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\(/,
    code,
  ),
  pattern(
    { id: 'dangerous-html', category: 'security', severity: 'warning', description: 'Raw HTML is written to the page, which can allow cross-site scripting.', suggestion: 'Use textContent or a framework binding, or sanitize the HTML first.' },
    /\.(?:inner|outer)HTML\s*=|dangerouslySetInnerHTML|\bdocument\.write\s*\(/,
    productionCode,
  ),
  pattern(
    { id: 'command-injection-risk', category: 'security', severity: 'warning', description: 'A shell command is built from dynamic input, or a shell is enabled.', suggestion: 'Use execFile or spawn with an argument array and no shell.' },
    /\bexec(?:Sync)?\s*\(\s*(?:`[^`]*\$\{|["'][^"']*["']\s*\+)|\bshell\s*:\s*true\b/,
    productionCode,
  ),
  pattern(
    { id: 'weak-hash', category: 'security', severity: 'warning', description: 'MD5 or SHA-1 is not safe for security purposes.', suggestion: 'Use SHA-256 or better, or a password hashing function for passwords.' },
    /createHash\(\s*['"](?:md5|sha1)['"]\s*\)/i,
    productionCode,
  ),
  pattern(
    { id: 'insecure-random', category: 'security', severity: 'warning', description: 'Math.random() is not cryptographically secure but is used for something that looks security related.', suggestion: 'Use crypto.randomUUID() or crypto.randomBytes().' },
    /(?=.*Math\.random\s*\()(?=.*(?:token|secret|password|salt|nonce|session|key))/i,
    productionCode,
  ),
  pattern(
    { id: 'tls-verification-disabled', category: 'security', severity: 'error', description: 'TLS certificate verification is disabled.', suggestion: 'Keep verification on; trust the right certificate authority instead.' },
    /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    productionCode,
  ),
  pattern(
    { id: 'plain-http-url', category: 'security', severity: 'info', description: 'A plain http:// URL was added.', suggestion: 'Use https:// unless it is a local address.' },
    /["'`]http:\/\/(?!(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]*\.local\b))[\w.-]+/,
    productionCode,
  ),
  pattern(
    { id: 'ts-suppression', category: 'correctness', severity: 'warning', description: '@ts-ignore or @ts-nocheck switches off type checking.', suggestion: 'Fix the type error, or use @ts-expect-error with a reason.' },
    /@ts-(?:ignore|nocheck)\b/,
    code,
    true,
  ),
  pattern(
    { id: 'eslint-disable', category: 'correctness', severity: 'info', description: 'A lint rule is disabled.', suggestion: 'Fix the cause, or keep the disable narrow and explain why.' },
    /eslint-disable/,
    code,
    true,
  ),
  pattern(
    { id: 'any-type', category: 'correctness', severity: 'info', description: 'The any type switches off type checking for this value.', suggestion: 'Use unknown and narrow it, or a precise type.' },
    /:\s*any\b|\bas\s+any\b|<any>|\bany\[\]/,
    typescriptProduction,
  ),
  pattern(
    { id: 'empty-catch', category: 'correctness', severity: 'warning', description: 'An empty catch block hides errors.', suggestion: 'Handle the error, log it, or explain with a comment why ignoring it is safe.' },
    /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    code,
  ),
  pattern(
    { id: 'debugger-statement', category: 'correctness', severity: 'warning', description: 'A debugger statement was left in the code.', suggestion: 'Remove it before merging.' },
    /^\s*debugger\b/,
    code,
  ),
  pattern(
    { id: 'console-output', category: 'maintainability', severity: 'info', description: 'console.log, console.debug or console.trace in production code.', suggestion: 'Use the project logger, or remove the debug output.' },
    /\bconsole\.(?:log|debug|trace)\s*\(/,
    productionCode,
  ),
  pattern(
    { id: 'focused-test', category: 'tests', severity: 'error', description: 'A focused test (.only, fit, fdescribe) makes the test run skip all the others.', suggestion: 'Remove .only before merging.' },
    /\b(?:describe|it|test|context)\.only\s*\(|\b(?:fit|fdescribe)\s*\(/,
    testCode,
  ),
  pattern(
    { id: 'skipped-test', category: 'tests', severity: 'warning', description: 'A test is skipped.', suggestion: 'Fix or delete the test, or link the reason for skipping it.' },
    /\b(?:describe|it|test|context)\.skip\s*\(|\b(?:xit|xdescribe|xtest)\s*\(/,
    testCode,
  ),
  pattern(
    { id: 'todo-marker', category: 'maintainability', severity: 'info', description: 'A TODO, FIXME, HACK or XXX marker was added.', suggestion: 'Resolve it, or track it in an issue.' },
    /\b(?:TODO|FIXME|HACK|XXX)\b/,
    anyText,
    true,
  ),
];

/** Whole-file rules, evaluated by the review service rather than line by line. */
export const FILE_RULES: readonly RuleInfo[] = [
  {
    id: 'large-added-block',
    category: 'maintainability',
    severity: 'info',
    description: 'A large amount of code was added to a single file.',
    suggestion: 'Consider splitting it so that it can be reviewed and tested in pieces.',
  },
  {
    id: 'missing-tests',
    category: 'tests',
    severity: 'warning',
    description: 'A changed source file has no test that imports it (directly or indirectly) or shares its name.',
    suggestion: 'Add or extend a test, or confirm that existing tests cover it.',
  },
];

export const LARGE_ADDED_BLOCK_LINES = 400;

export const ALL_RULES: readonly RuleInfo[] = [...LINE_RULES, ...FILE_RULES].map(({ id, category, severity, description, suggestion }) => ({
  id,
  category,
  severity,
  description,
  suggestion,
}));

export interface AppliedRules {
  findings: Finding[];
  /** Findings dropped because a rule already reported the per-file maximum. */
  omitted: number;
}

/** Runs the line rules on the added lines of one file. */
export function applyLineRules(context: RuleContext, lines: readonly AddedLine[], rules: readonly LineRule[], maxPerRule: number): AppliedRules {
  const findings: Finding[] = [];
  const applicable = rules.filter((rule) => rule.appliesTo(context));
  const perRule = new Map<string, number>();
  let omitted = 0;

  for (const { line, text } of lines) {
    const comment = isCommentLine(text);
    for (const rule of applicable) {
      if (comment && !rule.includeComments) continue;
      const evidence = rule.match(text);
      if (evidence === undefined) continue;

      const count = perRule.get(rule.id) ?? 0;
      perRule.set(rule.id, count + 1);
      if (count >= maxPerRule) {
        omitted++;
        continue;
      }
      findings.push({ rule: rule.id, category: rule.category, severity: rule.severity, file: context.path, line, evidence });
    }
  }
  return { findings, omitted };
}
