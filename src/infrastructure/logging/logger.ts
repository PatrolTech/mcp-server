import type { Logger } from '@patroltech/agent-capabilities';
import type { LogLevel } from '../../config.js';

/**
 * El logger del servicio: el del paquete más un canal `always` para lo que NO depende de
 * LOG_LEVEL (la auditoría `mcp.tool_call`, requisito de seguridad, y el latido `mcp.heartbeat`,
 * del que depende el monitor de proceso caído). Se escribe a stdout con `level: 'info'`.
 */
export interface ServiceLogger extends Logger {
  always(message: string, meta?: Record<string, unknown>): void;
}

export interface CreateLoggerOptions {
  service: string;
  env: string;
  version: string;
  level: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function serializeError(error: Error, env: string): Record<string, unknown> {
  const serialized: Record<string, unknown> = { name: error.name, message: error.message };
  if (env !== 'production' && error.stack) {
    serialized.stack = error.stack;
  }
  return serialized;
}

function serializeMeta(meta: Record<string, unknown>, env: string): Record<string, unknown> {
  const { err, ...rest } = meta;
  return err instanceof Error ? { ...rest, err: serializeError(err, env) } : meta;
}

/** Un logger nunca debe lanzar: si el meta no se serializa (ciclos, BigInt) se escribe una línea mínima. */
function stringify(entry: Record<string, unknown>, base: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ ...base, serializationError: true });
  }
}

/**
 * Logger JSON de una línea por entrada: info a stdout, warn y error a stderr; lo que está por
 * debajo de `level` no se escribe, salvo `always`.
 */
export function createLogger(options: CreateLoggerOptions): ServiceLogger {
  const { service, env, version, level } = options;

  const write = (
    entryLevel: 'info' | 'warn' | 'error',
    message: string,
    meta?: Record<string, unknown>
  ) => {
    const base = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      service,
      env,
      version,
    };
    const entry = { ...(meta ? serializeMeta(meta, env) : {}), ...base };
    const stream = entryLevel === 'info' ? process.stdout : process.stderr;
    stream.write(`${stringify(entry, base)}\n`);
  };

  const filtered =
    (entryLevel: 'info' | 'warn' | 'error') =>
    (message: string, meta?: Record<string, unknown>) => {
      if (LEVEL_RANK[entryLevel] >= LEVEL_RANK[level]) write(entryLevel, message, meta);
    };

  return {
    info: filtered('info'),
    warn: filtered('warn'),
    error: filtered('error'),
    always: (message, meta) => {
      write('info', message, meta);
    },
  };
}
