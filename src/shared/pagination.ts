import { takeWithinBudget } from './budget.js';

export type TruncationReason = 'FILE_LIMIT' | 'BYTE_BUDGET' | 'SCAN_LIMIT';

export interface Truncation {
  truncated: boolean;
  reason?: TruncationReason;
  returned: number;
  total: number;
  omitted: number;
  nextOffset?: number;
  hint?: string;
}

export interface PageOptions {
  offset: number;
  limit: number;
  /** Bytes available for the items themselves, after everything else in the response is accounted for. */
  budgetBytes: number;
  /** True when the input data was cut off before it reached the paging step. */
  scanLimited: boolean;
  /** What the items are called in the hint, for example "files". */
  noun: string;
  /** How the caller can ask for less, for example 'narrow the request with "paths"'. */
  narrowAdvice: string;
  scanNote: string;
}

export const TRUNCATION_RESERVE_BYTES = 600;

/**
 * Takes one page of an ordered list, limited by count and by serialized size, and describes what was left out
 * so that the model knows how to continue. Always returns at least one item when the page is not empty.
 */
export function pageWithinBudget<T>(items: readonly T[], options: PageOptions): { page: T[]; truncation: Truncation } {
  const candidates = items.slice(options.offset, options.offset + options.limit);
  const { taken, omitted: cutByBudget } = takeWithinBudget(candidates, Math.max(0, options.budgetBytes));

  const total = items.length;
  const returned = taken.length;
  const remaining = Math.max(0, total - options.offset - returned);
  const nextOffset = remaining > 0 ? options.offset + returned : undefined;

  let reason: TruncationReason | undefined;
  if (options.scanLimited) reason = 'SCAN_LIMIT';
  else if (cutByBudget > 0) reason = 'BYTE_BUDGET';
  else if (remaining > 0) reason = 'FILE_LIMIT';

  const truncation: Truncation = { truncated: reason !== undefined, returned, total, omitted: remaining };
  if (reason !== undefined) truncation.reason = reason;
  if (nextOffset !== undefined) truncation.nextOffset = nextOffset;

  if (reason !== undefined) {
    const next = nextOffset === undefined ? '' : ` Call again with offset=${nextOffset} for the next page.`;
    switch (reason) {
      case 'SCAN_LIMIT':
        truncation.hint = `${options.scanNote} Totals are lower bounds, so ${options.narrowAdvice}.${next}`;
        break;
      case 'BYTE_BUDGET':
        truncation.hint = `Response size limit reached after ${returned} ${options.noun}.${next} Use a smaller "limit" or ${options.narrowAdvice}.`;
        break;
      case 'FILE_LIMIT':
        truncation.hint = `Returned ${returned} of ${total} ${options.noun}.${next} You can also ${options.narrowAdvice}.`;
        break;
    }
  }
  return { page: taken, truncation };
}
