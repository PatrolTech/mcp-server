import { randomUUID } from 'node:crypto';
import type { Logger } from '@patroltech/agent-capabilities';
import type { KeyedLock, LockedRun } from '../../application/ports/KeyedLock.js';
import { DEFAULT_LOCK_WAIT_MS } from './MemoryKeyedLock.js';

/** Lo único que usamos del cliente de Redis (ioredis lo cumple; `eval` es el EVAL de Redis). */
export interface RedisLockClient {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/** Borra la clave solo si sigue siendo nuestra (no la de otro que la cogió tras caducar). */
export const RELEASE_LOCK_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/** Alarga la caducidad solo si la clave sigue siendo nuestra. */
export const RENEW_LOCK_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

export const MCP_PROPOSALS_LOCK_PREFIX = 'mcp-proposals';
/**
 * Red de seguridad: un proceso que muere con la clave no la retiene más de esto. Mientras el
 * dueño sigue vivo, la renueva cada tercio de esto: nunca la pierde a mitad (una confirmación de
 * 10 cambios con el backend lento puede durar más).
 */
export const DEFAULT_LOCK_TTL_MS = 60_000;
const DEFAULT_POLL_MS = 50;
const UNAVAILABLE_WARN_INTERVAL_MS = 60_000;

export interface RedisKeyedLockOptions {
  client: RedisLockClient;
  /** REDIS_NAMESPACE / APP_ENVIRONMENT: producción y staging comparten Redis. */
  namespace: string;
  logger: Logger;
  ttlMs?: number;
  waitMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Exclusión por clave en el Redis compartido (`SET NX PX`, renovación mientras dura y liberación
 * condicionada), clave `<namespace>:lock:mcp-proposals:<key>`: vale para todos los workers. Es una
 * dependencia de corrección, no una optimización: si Redis falla, NO cae a la memoria del proceso
 * (no sería global entre workers) sino que se niega (`acquired: false`, la herramienta responde
 * «busy»), con un aviso por minuto.
 */
export class RedisKeyedLock implements KeyedLock {
  private lastWarnAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: RedisKeyedLockOptions) {}

  async run<T>(key: string, body: () => Promise<T>): Promise<LockedRun<T>> {
    const { client, ttlMs = DEFAULT_LOCK_TTL_MS } = this.options;
    const redisKey = `${this.options.namespace}:lock:${MCP_PROPOSALS_LOCK_PREFIX}:${key}`;
    const token = randomUUID();
    let acquired: boolean;
    try {
      acquired = await this.acquire(redisKey, token);
    } catch (error) {
      this.warnUnavailable(error);
      // Un SET que Redis sí aplicó pero cuya respuesta no llegó (timeout) dejaría la clave nuestra
      // retenida el TTL entero (el usuario, «busy» un minuto): se libera con el mismo token, si
      // se puede. Si no es nuestra, el script no la toca.
      await client.eval(RELEASE_LOCK_LUA, 1, redisKey, token).catch(() => undefined);
      return { acquired: false };
    }
    if (!acquired) return { acquired: false };
    const renewal = setInterval(
      () => {
        client.eval(RENEW_LOCK_LUA, 1, redisKey, token, ttlMs).then(
          (renewed) => {
            // 0 = la clave ya no es nuestra (caducó durante un corte y otro la tomó): el cuerpo
            // sigue sin exclusión (lo cubre la comprobación de «confirmando» al proponer). Se
            // avisa y se deja de renovar. Sin la clave en el log: lleva el id del usuario.
            if (Number(renewed) === 0) {
              clearInterval(renewal);
              this.options.logger.warn('mcp.proposal_lock.lost', {
                lock: MCP_PROPOSALS_LOCK_PREFIX,
              });
            }
          },
          (error: unknown) => {
            this.warnUnavailable(error);
          }
        );
      },
      Math.max(1, Math.floor(ttlMs / 3))
    );
    try {
      return { acquired: true, value: await body() };
    } finally {
      clearInterval(renewal);
      await client.eval(RELEASE_LOCK_LUA, 1, redisKey, token).catch(() => undefined);
    }
  }

  private async acquire(redisKey: string, token: string): Promise<boolean> {
    const { client, ttlMs = DEFAULT_LOCK_TTL_MS, waitMs = DEFAULT_LOCK_WAIT_MS } = this.options;
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + waitMs;
    for (;;) {
      if ((await client.set(redisKey, token, 'PX', ttlMs, 'NX')) === 'OK') return true;
      if (Date.now() + pollMs > deadline) return false;
      await sleep(pollMs);
    }
  }

  private warnUnavailable(error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < UNAVAILABLE_WARN_INTERVAL_MS) return;
    this.lastWarnAt = now;
    this.options.logger.warn('mcp.proposal_lock.redis_unavailable', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
