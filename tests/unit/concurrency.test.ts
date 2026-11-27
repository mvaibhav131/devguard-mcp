import { describe, expect, it } from 'vitest';

import { createProgressReporter, NO_PROGRESS, type ProgressSink } from '../../src/shared/progress.js';
import { Semaphore } from '../../src/shared/semaphore.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Semaphore', () => {
  it('never runs more than the allowed number of tasks at once and keeps the order', async () => {
    const gate = new Semaphore(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((id) =>
        gate.run(async () => {
          started.push(id);
          active++;
          peak = Math.max(peak, active);
          await sleep(20);
          active--;
        }),
      ),
    );

    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
  });

  it('frees the slot when a task fails', async () => {
    const gate = new Semaphore(1);

    await expect(gate.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(gate.run(() => Promise.resolve('after'))).resolves.toBe('after');
  });

  it('lets a waiting task leave the queue when its signal aborts, without blocking the others', async () => {
    const gate = new Semaphore(1);
    const controller = new AbortController();
    const order: string[] = [];

    const first = gate.run(async () => {
      order.push('first');
      await sleep(40);
    });
    const waiting = gate.run(async () => void order.push('aborted'), controller.signal);
    const third = gate.run(async () => void order.push('third'));
    controller.abort(new Error('gave up'));

    await expect(waiting).rejects.toThrow('gave up');
    await Promise.all([first, third]);
    expect(order).toEqual(['first', 'third']);
  });

  it('rejects immediately for a signal that is already aborted', async () => {
    await expect(new Semaphore(1).run(() => Promise.resolve(1), AbortSignal.abort(new Error('early')))).rejects.toThrow('early');
  });
});

describe('createProgressReporter', () => {
  const collect = () => {
    const sent: { progress: number; total?: number | undefined; message?: string | undefined }[] = [];
    const sink: ProgressSink = (notification) => {
      sent.push(notification.params);
      return Promise.resolve();
    };
    return { sent, sink };
  };

  it('does nothing without a progress token', () => {
    const { sent, sink } = collect();

    expect(createProgressReporter(undefined, sink)).toBe(NO_PROGRESS);
    expect(sent).toEqual([]);
  });

  it('always sends the first and the final update, throttles the ones in between and never goes backwards', () => {
    const { sent, sink } = collect();
    let clock = 1_000;
    const report = createProgressReporter('token', sink, 250, () => clock);

    report(0, 3, 'start');
    report(1, 3, 'too soon');
    clock += 300;
    report(1.5, 3, 'later');
    report(1.2, 3, 'backwards');
    report(3, 3, 'done');
    report(3, 3, 'duplicate');

    expect(sent.map((update) => update.message)).toEqual(['start', 'later', 'done']);
    expect(sent.map((update) => update.progress)).toEqual([0, 1.5, 3]);
  });

  it('survives a failing sink', () => {
    const failing: ProgressSink = () => Promise.reject(new Error('closed'));
    const throwing: ProgressSink = () => {
      throw new Error('sync');
    };

    expect(() => createProgressReporter(1, failing)(0, 1, 'x')).not.toThrow();
    expect(() => createProgressReporter(1, throwing)(0, 1, 'x')).not.toThrow();
  });
});
