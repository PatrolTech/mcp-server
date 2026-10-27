/** Ventana fija: como mucho `limit` usos cada `windowMs`. */
export interface RateLimitRule {
  limit: number;
  windowMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  /** Segundos hasta que se abre la siguiente ventana (0 si está permitido). */
  retryAfterSec: number;
}

/** Decisión a partir del contador de la ventana y el tiempo que le queda. */
export function decide(hits: number, ttlMs: number, rule: RateLimitRule): RateLimitDecision {
  return hits <= rule.limit
    ? { allowed: true, retryAfterSec: 0 }
    : { allowed: false, retryAfterSec: Math.max(1, Math.ceil(ttlMs / 1000)) };
}
