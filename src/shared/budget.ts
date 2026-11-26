export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export interface BudgetResult<T> {
  taken: T[];
  /** Number of items that did not fit. */
  omitted: number;
}

/**
 * Takes items in order while their serialized size fits into `budgetBytes`.
 * Always takes at least one item (when there is one) so that paging makes progress.
 */
export function takeWithinBudget<T>(items: readonly T[], budgetBytes: number): BudgetResult<T> {
  const taken: T[] = [];
  let used = 0;

  for (const item of items) {
    const cost = jsonBytes(item) + 1;
    if (taken.length > 0 && used + cost > budgetBytes) break;
    taken.push(item);
    used += cost;
  }
  return { taken, omitted: items.length - taken.length };
}
