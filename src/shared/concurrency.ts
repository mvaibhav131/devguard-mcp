/** Runs `fn` for every item with at most `limit` running at the same time. Stops early when the signal aborts. */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  signal: AbortSignal | undefined,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      signal?.throwIfAborted();
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index] as T);
    }
  };

  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
}
