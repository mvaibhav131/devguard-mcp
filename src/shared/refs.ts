import { MAX_REF_LENGTH } from './limits.js';

// Starts with an alphanumeric character, so a ref can never be parsed as a command line option.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@~^-]*$/;

/** The grammar every user supplied git ref must match before it gets anywhere near git. */
export function isSafeRefName(ref: string): boolean {
  return ref.length > 0 && ref.length <= MAX_REF_LENGTH && REF_PATTERN.test(ref) && !ref.includes('..') && !ref.includes('//');
}
