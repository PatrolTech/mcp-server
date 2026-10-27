import type { Logger } from '@patroltech/agent-capabilities';
import {
  decide,
  type RateLimitDecision,
  type RateLimitRule,
} from '../../domain/rate-limit/rateLimit.js';
import type { RateLimiter } from '../../application/ports/RateLimiter.js';
import { MemoryRateLimiter } from './MemoryRateLimiter.js';

/** Lo único que usamos del cliente de Redis (ioredis lo cumple). */
export interface RedisEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Script Lua (EVAL de Redis), el mismo que el `sharedRateLimitStore` del backend: INCR y, en el
 * primer uso de la ventana, PEXPIRE. Atómico en el servidor: dos workers no se pisan.
 */
export const RATE_LIMIT_INCREMENT_LUA = `local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}`;

/** Separa estos contadores de los demás limitadores del Redis compartido. */
export const MCP_TOOL_PREFIX = 'mcp-tool';
const UNAVAILABLE_WARN_INTERVAL_MS = 60_000;

function parseCounterReply(reply: unknown): { hits: number; ttlMs: number } {
  if (Array.isArray(reply) && reply.length >= 2) {
    const hits = Number(reply[0]);
    const ttlMs = Number(reply[1]);
    if (Number.isFinite(hits) && Number.isFinite(ttlMs)) return { hits, ttlMs };
  }
  throw new Error('Unexpected rate-limit reply');
}

/** Un Redis conectado pero colgado no puede bloquear las herramientas: se cuenta en memoria. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 500;

export interface RedisRateLimiterOptions {
  client: RedisEvalClient;
  /** REDIS_NAMESPACE / APP_ENVIRONMENT: producción y staging comparten Redis. */
  namespace: string;
  logger: Logger;
  now?: () => number;
  /** Espera máxima por el contador de Redis (por defecto, 500 ms). */
  commandTimeoutMs?: number;
}

/** El resultado del comando, o un rechazo si tarda más de `timeoutMs`. */
async function withTimeout<T>(command: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('Redis command timed out'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([command, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ventana fija en el Redis compartido, clave `<namespace>:rate-limit:mcp-tool:<key>`: el límite
 * vale para todos los workers. Si Redis falla en una llamada, cuenta en memoria (degradado, con un
 * aviso por minuto) en lugar de tumbar la herramienta.
 */
export class RedisRateLimiter implements RateLimiter {
  private readonly fallback: MemoryRateLimiter;
  private readonly now: () => number;
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RedisRateLimiterOptions) {
    this.now = options.now ?? Date.now;
    this.fallback = new MemoryRateLimiter({ now: this.now });
  }

  async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const redisKey = `${this.options.namespace}:rate-limit:${MCP_TOOL_PREFIX}:${key}`;
    try {
      const reply = await withTimeout(
        this.options.client.eval(RATE_LIMIT_INCREMENT_LUA, 1, redisKey, rule.windowMs),
        this.options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
      );
      const { hits, ttlMs } = parseCounterReply(reply);
      return decide(hits, ttlMs, rule);
    } catch (error) {
      this.warnUnavailable(error);
      return this.fallback.consume(key, rule);
    }
  }

  private warnUnavailable(error: unknown): void {
    const now = this.now();
    if (now - this.lastWarnAt < UNAVAILABLE_WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.options.logger.warn('mcp.rate_limit.redis_unavailable', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
