import { DevGuardError } from './errors.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that adds `bindings` (for example a requestId) to every line. */
  child(bindings: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  bindings?: LogFields;
  /** Receives one JSON line without the trailing newline. Defaults to stderr. */
  write?: (line: string) => void;
  now?: () => Date;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

// stdout carries the MCP JSON-RPC protocol, so logs must never go there.
function writeToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function serializeError(error: Error): Record<string, unknown> {
  if (error instanceof DevGuardError) {
    return { name: error.name, code: error.code, message: error.message, hint: error.hint };
  }
  return { name: error.name, message: error.message, stack: error.stack };
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function stringify(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, replacer);
  } catch {
    return JSON.stringify({
      time: entry['time'],
      level: entry['level'],
      msg: entry['msg'],
      logError: 'fields could not be serialized',
    });
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const { level, bindings = {}, write = writeToStderr, now = () => new Date() } = options;
  const threshold = SEVERITY[level];

  const log = (severity: LogLevel, message: string, fields?: LogFields): void => {
    if (SEVERITY[severity] < threshold) return;

    // Reserved keys come last so that fields cannot overwrite them.
    const line = stringify({
      ...bindings,
      ...fields,
      time: now().toISOString(),
      level: severity,
      msg: message,
    });

    try {
      write(line);
    } catch {
      // stderr can be closed when the client disconnects; logging must never crash the server.
    }
  };

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (extra) => createLogger({ ...options, bindings: { ...bindings, ...extra } }),
  };
}
