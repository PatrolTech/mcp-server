import { describe, expect, it, vi } from 'vitest';
import { createReadinessCheck, jwksReachable } from './readiness.js';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

describe('createReadinessCheck', () => {
  it('is ready only when every dependency answers', async () => {
    const log = logger();
    const ready = createReadinessCheck(
      { jwks: () => Promise.resolve(true), redis: () => Promise.resolve(true) },
      log
    );

    expect(await ready()).toBe(true);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('is not ready when Redis is configured but does not answer, and says which one failed', async () => {
    const log = logger();
    const ready = createReadinessCheck(
      {
        jwks: () => Promise.resolve(true),
        redis: () => Promise.reject(new Error('Connection is closed.')),
      },
      log
    );

    expect(await ready()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('mcp.not_ready', { failed: ['redis'] });
  });

  it('is not ready when the JWKS is down', async () => {
    const log = logger();
    const ready = createReadinessCheck({ jwks: () => Promise.resolve(false) }, log);

    expect(await ready()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('mcp.not_ready', { failed: ['jwks'] });
  });
});

describe('jwksReachable', () => {
  it('is true on a 2xx and false otherwise, without reading the body', async () => {
    const ok = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{}', { status: 200 })));
    const down = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 502 })));

    expect(await jwksReachable('https://api.test/oauth/jwks.json', 1000, ok)()).toBe(true);
    expect(await jwksReachable('https://api.test/oauth/jwks.json', 1000, down)()).toBe(false);
  });
});
