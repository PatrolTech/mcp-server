import type { Logger } from '@patroltech/agent-capabilities';
import { Redis } from 'ioredis';
import type { KeyedLock } from '../../application/ports/KeyedLock.js';
import type { RateLimiter } from '../../application/ports/RateLimiter.js';
import { MemoryKeyedLock } from '../locks/MemoryKeyedLock.js';
import { RedisKeyedLock } from '../locks/RedisKeyedLock.js';
import { MemoryRateLimiter } from '../rate-limit/MemoryRateLimiter.js';
import { DEFAULT_COMMAND_TIMEOUT_MS, RedisRateLimiter } from '../rate-limit/RedisRateLimiter.js';

export interface CreateSharedStoresOptions {
  redisUrl?: string;
  namespace: string;
  logger: Logger;
}

export interface SharedStores {
  rateLimiter: RateLimiter;
  /** Exclusión por usuario y cliente de las propuestas (un lote vivo por clave). */
  proposalLock: KeyedLock;
  /**
   * `PING` al Redis compartido (con el mismo límite de 500 ms de cada comando), para la sonda de
   * readiness; ausente sin `REDIS_URL`.
   */
  ping?: () => Promise<boolean>;
  /** Cierra la conexión a Redis (apagado ordenado). */
  close(): Promise<void>;
}

/**
 * El estado compartido entre workers (límites de uso y exclusión de propuestas) sobre UNA
 * conexión al Redis compartido si hay `REDIS_URL` y, si no (solo development/test), en memoria
 * con un aviso al arrancar. El cliente no encola comandos sin conexión: con Redis caído cada
 * llamada falla al momento; el limitador cuenta entonces en memoria (es una optimización) y la
 * exclusión se niega (es de corrección).
 */
export function createSharedStores(options: CreateSharedStoresOptions): SharedStores {
  const { redisUrl, namespace, logger } = options;
  if (!redisUrl) {
    // Solo fuera de production/staging (la configuración exige REDIS_URL allí).
    logger.warn('mcp.shared_state.memory_fallback', {
      reason: 'REDIS_URL not configured',
      stores: ['rate-limit', 'proposal-lock'],
      scope: 'single-process',
    });
    return {
      rateLimiter: new MemoryRateLimiter(),
      proposalLock: new MemoryKeyedLock(),
      close: () => Promise.resolve(),
    };
  }

  const client = new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Un Redis conectado pero colgado tampoco debe bloquear (el limitador corta igual a 500 ms).
    commandTimeout: DEFAULT_COMMAND_TIMEOUT_MS,
  });
  // Sin oyente, un 'error' del socket tumbaría el proceso; el aviso lo da quien lo usa.
  client.on('error', () => undefined);
  return {
    rateLimiter: new RedisRateLimiter({ client, namespace, logger }),
    proposalLock: new RedisKeyedLock({ client, namespace, logger }),
    // `ping` lanza si Redis no contesta (sin conexión o pasados los 500 ms).
    ping: async () => {
      await client.ping();
      return true;
    },
    close: async () => {
      await client.quit().catch(() => client.disconnect());
    },
  };
}
