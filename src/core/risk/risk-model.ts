import path from 'node:path';

import { isSourceFile } from '../impact/module-resolver.js';
import { isTestFile } from '../tests/test-files.js';

export type FactorId =
  | 'change_size'
  | 'change_spread'
  | 'blast_radius'
  | 'test_coverage_gap'
  | 'critical_paths'
  | 'change_kinds';

export type RiskBand = 'low' | 'medium' | 'high' | 'critical';

/** Bump when weights, scales or bands change, so scores from different releases are not compared by accident. */
export const SCORE_VERSION = 1;

/** Fixed and documented. They add up to 1. */
export const RISK_WEIGHTS: Readonly<Record<FactorId, number>> = {
  change_size: 0.2,
  change_spread: 0.1,
  blast_radius: 0.25,
  test_coverage_gap: 0.2,
  critical_paths: 0.15,
  change_kinds: 0.1,
};

export const FACTOR_ORDER: readonly FactorId[] = [
  'change_size',
  'change_spread',
  'blast_radius',
  'test_coverage_gap',
  'critical_paths',
  'change_kinds',
];

export const RISK_BANDS: readonly { band: RiskBand; min: number; max: number }[] = [
  { band: 'low', min: 0, max: 24 },
  { band: 'medium', min: 25, max: 49 },
  { band: 'high', min: 50, max: 74 },
  { band: 'critical', min: 75, max: 100 },
];

/** A measured value at or below `low` scores 0 and at or above `high` scores 1; in between it is linear. */
export const SCALES = {
  linesChanged: { low: 20, high: 800 },
  changedFiles: { low: 3, high: 30 },
  topLevelFolders: { low: 1, high: 6 },
  impactedFiles: { low: 2, high: 40 },
  directImporters: { low: 2, high: 20 },
  criticalFiles: { low: 0, high: 4 },
  changeKindPoints: { low: 0, high: 5 },
} as const;

/** The test gap counts only 75% when test files changed together with the code. */
export const TEST_GAP_MITIGATION = 0.75;

export function bandFor(score: number): RiskBand {
  return RISK_BANDS.find((entry) => score >= entry.min && score <= entry.max)?.band ?? 'critical';
}

export function scale(value: number, low: number, high: number): number {
  if (high <= low) return 0;
  return Math.round(Math.min(1, Math.max(0, (value - low) / (high - low))) * 1000) / 1000;
}

export type CriticalCategory = 'dependencies' | 'ci-cd' | 'environment' | 'build-config' | 'security' | 'database' | 'payments';

const SECURITY_WORDS =
  /(^|[/._-])(auth|authn|authz|authentication|authorization|security|crypto|password|passwd|secret|secrets|token|tokens|jwt|oauth|permission|permissions|rbac|acl|session|csrf|cors)([/._-]|$)/;
const DATABASE_WORDS = /(^|[/._-])(migration|migrations|database|db|prisma|sql|knex|sequelize|typeorm)([/._-]|$)/;
const PAYMENT_WORDS = /(^|[/._-])(payment|payments|billing|invoice|invoices|checkout|stripe)([/._-]|$)/;

/** Name based. A sensitive file with an ordinary name is not detected, which the factor reports. */
export function criticalCategory(filePath: string): CriticalCategory | undefined {
  const lower = filePath.toLowerCase();
  const name = path.posix.basename(lower);

  if (/^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(name)) return 'dependencies';
  if (lower.startsWith('.github/workflows/') || /^(\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile|dockerfile.*|docker-compose.*\.ya?ml)$/.test(name)) return 'ci-cd';
  if (/^\.env(\..*)?$/.test(name)) return 'environment';
  if (/^(tsconfig.*\.json|jsconfig\.json|(vite|vitest|jest|webpack|rollup|babel|eslint)\.config\..+|\.babelrc.*|\.eslintrc.*)$/.test(name)) return 'build-config';

  // Names such as "auth" or "db" only count in production source code, not in tests or documentation.
  if (!isSourceFile(filePath) || isTestFile(filePath)) return undefined;
  if (SECURITY_WORDS.test(lower)) return 'security';
  if (DATABASE_WORDS.test(lower)) return 'database';
  if (PAYMENT_WORDS.test(lower)) return 'payments';
  return undefined;
}
