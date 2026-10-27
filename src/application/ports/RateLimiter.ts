import type { RateLimitDecision, RateLimitRule } from '../../domain/rate-limit/rateLimit.js';

/** Puerto: cuenta un uso de `key` y dice si cabe en la regla. */
export interface RateLimiter {
  consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}
