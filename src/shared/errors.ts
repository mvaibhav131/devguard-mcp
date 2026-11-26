export const ERROR_CODES = [
  'CONFIG_INVALID',
  'INVALID_INPUT',
  'INVALID_REF',
  'PATH_OUTSIDE_WORKSPACE',
  'NOT_A_GIT_REPO',
  'GIT_TIMEOUT',
  'GIT_FAILED',
  'LIMIT_EXCEEDED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface DevGuardErrorOptions {
  /** A short, actionable suggestion that is safe to show to the user or the model. */
  hint?: string;
  cause?: unknown;
}

/** Expected, classified failure. Anything that is not a DevGuardError is treated as a bug. */
export class DevGuardError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: DevGuardErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DevGuardError';
    this.code = code;
    this.hint = options.hint;
  }
}
