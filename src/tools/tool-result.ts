import { randomUUID } from 'node:crypto';

import { DevGuardError } from '../shared/errors.js';
import type { Limits } from '../shared/limits.js';
import type { Logger } from '../shared/logger.js';
import { createProgressReporter, type ProgressReporter, type ProgressSink } from '../shared/progress.js';
import type { Semaphore } from '../shared/semaphore.js';

/** The part of the SDK handler context that DevGuard uses. */
export interface ToolContextLike {
  mcpReq: {
    signal: AbortSignal;
    _meta?: { progressToken?: string | number | undefined } | undefined;
    notify: ProgressSink;
  };
}

export interface ToolRuntime {
  logger: Logger;
  limits: Limits;
  /** Shared by all tools: limits how many calls run at the same time. */
  gate: Semaphore;
}

export interface ToolOptions {
  /** Light tools skip the concurrency gate so that they never wait behind heavy analyses. Defaults to true. */
  gated?: boolean;
}

// `type` aliases on purpose: unlike interfaces they are assignable to the SDK result type, which has an index signature.
export type TextBlock = {
  type: 'text';
  text: string;
};

export type ToolSuccess<T> = {
  content: TextBlock[];
  structuredContent: T;
};

export type ToolFailure = {
  content: TextBlock[];
  isError: true;
};

/** Every DevGuard tool only reads. Clients may use these hints to skip confirmation prompts. */
export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

let requestCounter = 0;

function failure(text: string): ToolFailure {
  return { content: [{ type: 'text', text }], isError: true };
}

function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * Wraps a tool implementation with the behaviour every tool shares:
 * a deadline combined with client cancellation, a concurrency gate, progress notifications, request logging,
 * and error mapping. Expected failures (DevGuardError) become readable tool errors; anything else is logged
 * in detail and reported to the model only as an opaque reference.
 */
export function toolHandler<Args, Payload extends object>(
  name: string,
  runtime: ToolRuntime,
  run: (args: Args, signal: AbortSignal, progress: ProgressReporter) => Promise<Payload>,
  options: ToolOptions = {},
): (args: Args, ctx: ToolContextLike) => Promise<ToolSuccess<Payload> | ToolFailure> {
  return async (args, ctx) => {
    const log = runtime.logger.child({ tool: name, requestId: `${name}-${++requestCounter}` });
    const started = performance.now();
    // The deadline also covers the time spent waiting for a free slot.
    const signal = AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(runtime.limits.toolTimeoutMs)]);
    const progress = createProgressReporter(ctx.mcpReq._meta?.progressToken, (notification) => ctx.mcpReq.notify(notification));

    log.debug('tool call started');
    try {
      const execute = () => run(args, signal, progress);
      const payload = options.gated === false ? await execute() : await runtime.gate.run(execute, signal);
      const text = JSON.stringify(payload);
      log.info('tool call succeeded', { durationMs: elapsedMs(started), responseBytes: Buffer.byteLength(text, 'utf8') });
      return { content: [{ type: 'text', text }], structuredContent: payload };
    } catch (error) {
      if (ctx.mcpReq.signal.aborted) {
        // The SDK discards the response of a cancelled request.
        log.info('tool call cancelled', { durationMs: elapsedMs(started) });
        return failure('CANCELLED: The request was cancelled.');
      }
      if (error instanceof Error && error.name === 'TimeoutError') {
        log.warn('tool call timed out', { durationMs: elapsedMs(started) });
        return failure('TIMEOUT: The analysis exceeded its time limit. Hint: narrow the request or reduce the depth.');
      }
      if (error instanceof DevGuardError) {
        log.warn('tool call failed', { code: error.code, durationMs: elapsedMs(started), error });
        return failure(`${error.code}: ${error.message}${error.hint ? ` Hint: ${error.hint}` : ''}`);
      }
      const reference = randomUUID().slice(0, 8);
      log.error('tool call crashed', { reference, durationMs: elapsedMs(started), error });
      return failure(`INTERNAL: Unexpected error (reference ${reference}). Details are in the DevGuard server log.`);
    }
  };
}
