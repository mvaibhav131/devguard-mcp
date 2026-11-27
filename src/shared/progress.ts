/** Reports how far a long analysis is. `progress` only ever increases; `total` stays the same. */
export type ProgressReporter = (progress: number, total: number, message: string) => void;

export const NO_PROGRESS: ProgressReporter = () => {};

export interface ProgressSink {
  (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; total?: number; message?: string };
  }): Promise<void>;
}

/**
 * A reporter that sends MCP progress notifications when the client asked for them (it sent a progress token).
 * The first and the final update are always sent, the ones in between at most every `throttleMs`.
 */
export function createProgressReporter(
  progressToken: string | number | undefined,
  send: ProgressSink,
  throttleMs = 250,
  now: () => number = Date.now,
): ProgressReporter {
  if (progressToken === undefined) return NO_PROGRESS;

  let last = -1;
  let lastSentAt = 0;

  return (progress, total, message) => {
    if (progress <= last) return;
    const final = progress >= total;
    if (!final && last >= 0 && now() - lastSentAt < throttleMs) return;

    last = progress;
    lastSentAt = now();
    try {
      send({ method: 'notifications/progress', params: { progressToken, progress, total, message } }).catch(() => {
        // The client may be gone or have cancelled; progress is best effort.
      });
    } catch {
      // Same as above.
    }
  };
}
