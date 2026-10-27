import {
  decide,
  type RateLimitDecision,
  type RateLimitRule,
} from '../../domain/rate-limit/rateLimit.js';
import type { RateLimiter } from '../../application/ports/RateLimiter.js';

interface Window {
  hits: number;
  resetAt: number;
}

/** Más ventanas vivas que esto: se purgan las caducadas antes de abrir otra. */
const PRUNE_THRESHOLD = 10_000;

/**
 * Contador de ventana fija en la memoria del proceso. Solo es el respaldo cuando no hay Redis:
 * con varios workers el límite efectivo es `limit × workers`.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, Window>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
  }

  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
    const now = this.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      this.pruneIfLarge(now);
      window = { hits: 0, resetAt: now + rule.windowMs };
      this.windows.set(key, window);
    }
    window.hits += 1;
    return Promise.resolve(decide(window.hits, window.resetAt - now, rule));
  }

  private pruneIfLarge(now: number): void {
    if (this.windows.size < PRUNE_THRESHOLD) return;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}
