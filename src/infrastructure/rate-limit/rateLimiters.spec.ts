import type { Logger } from '@patroltech/agent-capabilities';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRateLimiter } from './MemoryRateLimiter.js';
import {
  RATE_LIMIT_INCREMENT_LUA,
  RedisRateLimiter,
  type RedisEvalClient,
} from './RedisRateLimiter.js';
import { MemoryKeyedLock } from '../locks/MemoryKeyedLock.js';
import { createSharedStores } from '../redis/createSharedStores.js';

const RULE = { limit: 3, windowMs: 60_000 };

let logger: Logger;
beforeEach(() => {
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

describe('MemoryRateLimiter (fixed window)', () => {
  it('allows up to the limit and then refuses with the seconds left in the window', async () => {
    let now = 1_000_000;
    const limiter = new MemoryRateLimiter({ now: () => now });
    for (let n = 0; n < 3; n += 1) {
      expect((await limiter.consume('u1:tool', RULE)).allowed).toBe(true);
    }
    now += 15_500;
    expect(await limiter.consume('u1:tool', RULE)).toEqual({ allowed: false, retryAfterSec: 45 });
  });

  it('counts each key on its own and opens a new window once the old one ends', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter({ now: () => now });
    for (let n = 0; n < 3; n += 1) await limiter.consume('a', RULE);
    expect((await limiter.consume('b', RULE)).allowed).toBe(true);
    expect((await limiter.consume('a', RULE)).allowed).toBe(false);
    now += 60_000;
    expect((await limiter.consume('a', RULE)).allowed).toBe(true);
  });
});

describe('RedisRateLimiter', () => {
  it('counts with the INCR+PEXPIRE script under `<namespace>:rate-limit:mcp-tool:<key>`', async () => {
    const client: RedisEvalClient = { eval: vi.fn(() => Promise.resolve([4, 30_000])) };
    const limiter = new RedisRateLimiter({ client, namespace: 'staging', logger });

    const decision = await limiter.consume('user-1:patroltech_rounds_get_status', RULE);

    expect(client.eval).toHaveBeenCalledWith(
      RATE_LIMIT_INCREMENT_LUA,
      1,
      'staging:rate-limit:mcp-tool:user-1:patroltech_rounds_get_status',
      60_000
    );
    expect(decision).toEqual({ allowed: false, retryAfterSec: 30 });
    expect(RATE_LIMIT_INCREMENT_LUA).toContain("redis.call('INCR'");
    expect(RATE_LIMIT_INCREMENT_LUA).toContain("redis.call('PEXPIRE'");
  });

  it('allows while the counter is within the limit', async () => {
    const client: RedisEvalClient = { eval: vi.fn(() => Promise.resolve([3, 59_000])) };
    const limiter = new RedisRateLimiter({ client, namespace: 'test', logger });
    expect((await limiter.consume('k', RULE)).allowed).toBe(true);
  });

  it('falls back to counting in memory, warning once per minute, when Redis fails', async () => {
    const client: RedisEvalClient = {
      eval: vi.fn(() => Promise.reject(new Error('connection refused'))),
    };
    const limiter = new RedisRateLimiter({ client, namespace: 'test', logger });

    for (let n = 0; n < 3; n += 1) {
      expect((await limiter.consume('k', RULE)).allowed).toBe(true);
    }
    expect((await limiter.consume('k', RULE)).allowed).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('mcp.rate_limit.redis_unavailable', {
      reason: 'connection refused',
    });
  });

  it('does not wait for a Redis that hangs: after the command timeout it counts in memory', async () => {
    const client: RedisEvalClient = { eval: vi.fn(() => new Promise<never>(() => undefined)) };
    const limiter = new RedisRateLimiter({
      client,
      namespace: 'test',
      logger,
      commandTimeoutMs: 20,
    });

    const started = Date.now();
    const decision = await limiter.consume('k', RULE);

    expect(decision.allowed).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logger.warn).toHaveBeenCalledWith('mcp.rate_limit.redis_unavailable', {
      reason: 'Redis command timed out',
    });
  });

  it('treats an unexpected reply as a failure (memory fallback)', async () => {
    const client: RedisEvalClient = { eval: vi.fn(() => Promise.resolve('OK')) };
    const limiter = new RedisRateLimiter({ client, namespace: 'test', logger });
    expect((await limiter.consume('k', RULE)).allowed).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('createSharedStores', () => {
  it('without REDIS_URL counts and locks per process and warns once', async () => {
    const { rateLimiter, proposalLock, close } = createSharedStores({ namespace: 'test', logger });
    expect(rateLimiter).toBeInstanceOf(MemoryRateLimiter);
    expect(proposalLock).toBeInstanceOf(MemoryKeyedLock);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Ops must see that the proposal lock is single-process too (only allowed without REDIS_URL).
    expect(logger.warn).toHaveBeenCalledWith('mcp.shared_state.memory_fallback', {
      reason: 'REDIS_URL not configured',
      stores: ['rate-limit', 'proposal-lock'],
      scope: 'single-process',
    });
    await close();
  });
});
