import type { Logger } from '@patroltech/agent-capabilities';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryKeyedLock } from './MemoryKeyedLock.js';
import {
  RELEASE_LOCK_LUA,
  RENEW_LOCK_LUA,
  RedisKeyedLock,
  type RedisLockClient,
} from './RedisKeyedLock.js';

let logger: Logger;
beforeEach(() => {
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Redis falso con SET NX PX (con caducidad real) y los scripts de liberar y renovar. */
function fakeRedis(): RedisLockClient & {
  keys: Map<string, { value: string; expiresAt: number }>;
} {
  const keys = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt <= Date.now()) keys.delete(key);
    return keys.get(key);
  };
  return {
    keys,
    set: vi.fn((key: string, value: string, _px: 'PX', ttlMs: number) => {
      if (live(key)) return Promise.resolve(null);
      keys.set(key, { value, expiresAt: Date.now() + ttlMs });
      return Promise.resolve('OK');
    }),
    eval: vi.fn((script: string, _numKeys: number, ...args: (string | number)[]) => {
      const [key, token, ttlMs] = args.map(String);
      const entry = live(key);
      if (entry?.value !== token) return Promise.resolve(0);
      if (script === RELEASE_LOCK_LUA) keys.delete(key);
      else if (script === RENEW_LOCK_LUA) entry.expiresAt = Date.now() + Number(ttlMs);
      else throw new Error('unexpected script');
      return Promise.resolve(1);
    }),
  };
}

describe.each([
  ['MemoryKeyedLock', () => new MemoryKeyedLock({ waitMs: 200 })],
  [
    'RedisKeyedLock',
    () =>
      new RedisKeyedLock({
        client: fakeRedis(),
        namespace: 'test',
        logger,
        waitMs: 200,
        pollMs: 5,
      }),
  ],
] as const)('%s', (_name, create) => {
  it('runs the bodies of one key one after the other, in arrival order', async () => {
    const lock = create();
    const events: string[] = [];
    const body = (name: string, ms: number) => async () => {
      events.push(`${name}:start`);
      await tick(ms);
      events.push(`${name}:end`);
      return name;
    };

    const results = await Promise.all([lock.run('k', body('a', 20)), lock.run('k', body('b', 5))]);

    expect(results).toEqual([
      { acquired: true, value: 'a' },
      { acquired: true, value: 'b' },
    ]);
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('does not make different keys wait for each other', async () => {
    const lock = create();
    const events: string[] = [];
    await Promise.all([
      lock.run('k1', async () => {
        events.push('k1:start');
        await tick(30);
        events.push('k1:end');
      }),
      lock.run('k2', async () => {
        events.push('k2:start');
        await tick(1);
        events.push('k2:end');
      }),
    ]);
    expect(events.indexOf('k2:end')).toBeLessThan(events.indexOf('k1:end'));
  });

  it('gives up after waitMs without running the body', async () => {
    const lock = create();
    const second = vi.fn(() => Promise.resolve('never'));
    const first = lock.run('k', () => tick(400));
    await tick(5);

    const outcome = await lock.run('k', second);

    expect(outcome).toEqual({ acquired: false });
    expect(second).not.toHaveBeenCalled();
    await first;
  });

  it('releases the key when the body throws', async () => {
    const lock = create();
    await expect(lock.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await lock.run('k', () => Promise.resolve(1))).toEqual({ acquired: true, value: 1 });
  });
});

describe('RedisKeyedLock', () => {
  it('uses SET NX PX on <namespace>:lock:mcp-proposals:<key> and releases only its own token', async () => {
    const client = fakeRedis();
    const lock = new RedisKeyedLock({ client, namespace: 'prod', logger, ttlMs: 60_000 });

    await lock.run('mcp:user-1:abc', () => Promise.resolve());

    expect(client.set).toHaveBeenCalledWith(
      'prod:lock:mcp-proposals:mcp:user-1:abc',
      expect.any(String),
      'PX',
      60_000,
      'NX'
    );
    expect(client.keys.size).toBe(0);
  });

  it('keeps the key while the holder runs longer than the TTL (renewal), and frees it after', async () => {
    const client = fakeRedis();
    const lock = new RedisKeyedLock({
      client,
      namespace: 'test',
      logger,
      // Margen amplio frente a las pausas del bucle de eventos con la suite entera en marcha:
      // renueva cada ~100 ms y solo falla si algo bloquea el proceso más de 300 ms seguidos.
      ttlMs: 300,
      waitMs: 3000,
      pollMs: 10,
    });
    const events: string[] = [];

    await Promise.all([
      lock.run('k', async () => {
        events.push('a:start');
        await tick(1000);
        events.push('a:end');
      }),
      tick(400).then(() =>
        lock.run('k', () => {
          events.push('b:start');
          return Promise.resolve();
        })
      ),
    ]);

    expect(events).toEqual(['a:start', 'a:end', 'b:start']);
    expect(client.keys.size).toBe(0);
  });

  it('warns once and stops renewing when a renewal finds the key is no longer ours', async () => {
    const client = fakeRedis();
    // Margen frente a pausas del bucle de eventos: basta con que haya una renovación en 500 ms.
    const lock = new RedisKeyedLock({ client, namespace: 'test', logger, ttlMs: 60, pollMs: 5 });
    const renewals = () =>
      vi.mocked(client.eval).mock.calls.filter(([script]) => script === RENEW_LOCK_LUA).length;

    await lock.run('k', async () => {
      // Someone else took the key (it expired during a Redis blip).
      const [key] = [...client.keys.keys()];
      client.keys.set(key, { value: 'someone-else', expiresAt: Date.now() + 60_000 });
      await tick(500);
    });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('mcp.proposal_lock.lost', {
      lock: 'mcp-proposals',
    });
    expect(renewals()).toBe(1);
    // The other holder's key is untouched by our release.
    expect([...client.keys.values()].map((e) => e.value)).toEqual(['someone-else']);
  });

  it('refuses (fails closed) and warns when Redis fails: the lock never becomes per process', async () => {
    const client: RedisLockClient = {
      set: vi.fn(() => Promise.reject(new Error('Connection is closed.'))),
      eval: vi.fn(() => Promise.resolve(0)),
    };
    const lock = new RedisKeyedLock({ client, namespace: 'test', logger, waitMs: 200 });
    const body = vi.fn(() => Promise.resolve('done'));

    const outcome = await lock.run('k', body);

    expect(outcome).toEqual({ acquired: false });
    expect(body).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith('mcp.proposal_lock.redis_unavailable', {
      reason: 'Connection is closed.',
    });
  });

  it('frees a key whose SET succeeded server-side but timed out client-side', async () => {
    const client = fakeRedis();
    const realSet = client.set;
    // El SET llega a Redis (la clave queda puesta) pero el cliente ve un timeout.
    client.set = vi.fn(async (...args: Parameters<RedisLockClient['set']>) => {
      await realSet(...args);
      throw new Error('Command timed out');
    });
    const lock = new RedisKeyedLock({ client, namespace: 'test', logger, waitMs: 200 });

    const outcome = await lock.run('k', () => Promise.resolve('never'));

    expect(outcome).toEqual({ acquired: false });
    // La clave no se queda retenida el TTL entero: se libera con el mismo token.
    expect(client.keys.size).toBe(0);
    client.set = realSet;
    expect(await lock.run('k', () => Promise.resolve('next'))).toEqual({
      acquired: true,
      value: 'next',
    });
  });
});
