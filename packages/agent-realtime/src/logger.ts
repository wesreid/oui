/**
 * The server logs refusals, joins and results as structured records. pino's
 * `(object, message)` signature is the shape, so a product passes its own
 * pino logger unchanged.
 */
export interface RealtimeLogger {
  debug(data: Record<string, unknown>, msg: string): void;
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/** One JSON line per record. Debug records are written only when `LOG_LEVEL=debug`. */
export function createConsoleLogger(): RealtimeLogger {
  const line = (level: string, data: Record<string, unknown>, msg: string) =>
    JSON.stringify({ level, time: Date.now(), msg, ...serializable(data) });
  return {
    debug: (data, msg) => {
      if (process.env.LOG_LEVEL === 'debug') console.log(line('debug', data, msg));
    },
    info: (data, msg) => console.log(line('info', data, msg)),
    warn: (data, msg) => console.warn(line('warn', data, msg)),
    error: (data, msg) => console.error(line('error', data, msg)),
  };
}

/** Errors serialize to `{}` in JSON; keep their message and stack. */
function serializable(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value;
  }
  return out;
}
