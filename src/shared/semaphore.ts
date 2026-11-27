/**
 * Lets only `max` tasks run at the same time; the others wait in order.
 * A waiting task leaves the queue when its signal aborts.
 */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as unknown);

    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(grant);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(signal?.reason as unknown);
      };
      this.waiting.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private release(): void {
    this.active--;
    this.waiting.shift()?.();
  }
}
