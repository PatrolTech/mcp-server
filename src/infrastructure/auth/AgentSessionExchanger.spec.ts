import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  AgentSessionRateLimitedError,
  AgentSessionRejectedError,
  AgentSessionUnavailableError,
} from '../../domain/auth/errors.js';
import { AgentSessionExchanger } from './AgentSessionExchanger.js';

const ACCESS_TOKEN = 'access-token-secret-value';
const NOW_SEC = 1_800_000_000;
const ROLES = {
  organizationRoles: { 'org-a': 'ADMIN' },
  orgWideRoles: { 'org-a': 'ADMIN' },
  locationRoles: {},
};
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
/** JWT de sesión de agente con claims de rol (el exchanger los lee una vez, al canjear). */
const AGENT_JWT = `${part({ alg: 'HS256' })}.${part({ id: 'user-1', preferredTimezone: 'Europe/Lisbon', roles: ROLES })}.sig`;

function sessionBody(overrides: Record<string, unknown> = {}) {
  return {
    token: AGENT_JWT,
    expires_at: NOW_SEC + 900,
    scope: 'read write',
    user_id: 'user-1',
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createExchanger(
  fetchImpl: typeof fetch,
  extra: { maxEntries?: number; timeoutMs?: number } = {}
) {
  let nowSec = NOW_SEC;
  const clock = {
    advance: (sec: number) => {
      nowSec += sec;
    },
  };
  const exchanger = new AgentSessionExchanger({
    apiBaseUrl: 'https://api.example.test',
    fetchImpl,
    now: () => nowSec * 1000,
    maxEntries: extra.maxEntries,
    timeoutMs: extra.timeoutMs,
  });
  return { exchanger, clock };
}

describe('AgentSessionExchanger', () => {
  it('exchanges the access token for an agent session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger } = createExchanger(fetchImpl);

    const session = await exchanger.exchange(ACCESS_TOKEN);

    expect(session).toEqual({
      token: AGENT_JWT,
      expiresAt: NOW_SEC + 900,
      scopes: ['read', 'write'],
      userId: 'user-1',
      roles: ROLES,
      preferredTimezone: 'Europe/Lisbon',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.example.test/oauth/agent-session');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('serves repeated exchanges from the cache while now < expiresAt - 60', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger, clock } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);
    clock.advance(839); // now = expiresAt - 61
    await exchanger.exchange(ACCESS_TOKEN);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('exchanges again once the 60 s safety margin is reached', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger, clock } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);
    clock.advance(840); // now = expiresAt - 60 (ya no es estrictamente anterior)
    await exchanger.exchange(ACCESS_TOKEN);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never caches a session that is already inside the safety margin', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(200, sessionBody({ expires_at: NOW_SEC + 30 })))
    );
    const { exchanger } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);
    await exchanger.exchange(ACCESS_TOKEN);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('caches per access token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger } = createExchanger(fetchImpl);

    await exchanger.exchange('token-a');
    await exchanger.exchange('token-b');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('de-duplicates concurrent exchanges of the same token into one backend call', async () => {
    let release: (response: Response) => void = () => undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const { exchanger } = createExchanger(fetchImpl);

    const first = exchanger.exchange(ACCESS_TOKEN);
    const second = exchanger.exchange(ACCESS_TOKEN);
    release(jsonResponse(200, sessionBody()));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache failures: the next exchange calls the backend again', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'x' }))
      .mockResolvedValueOnce(jsonResponse(200, sessionBody()));
    const { exchanger } = createExchanger(fetchImpl);

    await expect(exchanger.exchange(ACCESS_TOKEN)).rejects.toBeInstanceOf(
      AgentSessionUnavailableError
    );
    await expect(exchanger.exchange(ACCESS_TOKEN)).resolves.toMatchObject({ userId: 'user-1' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache with LRU eviction', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger } = createExchanger(fetchImpl, { maxEntries: 2 });

    await exchanger.exchange('t1');
    await exchanger.exchange('t2');
    await exchanger.exchange('t1'); // hit: t1 pasa a ser el más reciente
    await exchanger.exchange('t3'); // expulsa t2, el menos reciente
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    await exchanger.exchange('t1'); // sigue en caché
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await exchanger.exchange('t2'); // expulsado: vuelve al backend
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await exchanger.exchange('t1'); // t2 expulsó a t3 (el menos reciente); t1 sigue
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await exchanger.exchange('t3');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('keeps each token apart and never sends the access token anywhere but the exchange', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);
    await exchanger.exchange(ACCESS_TOKEN);
    await exchanger.exchange(`${ACCESS_TOKEN}-other`);

    // Same token: one exchange; another token: its own exchange.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [url] of fetchImpl.mock.calls) {
      const target = (url as string | URL).toString();
      expect(target).toBe('https://api.example.test/oauth/agent-session');
      expect(target).not.toContain(ACCESS_TOKEN);
    }
  });

  it('keys its cache by sha256(token) and never holds the raw access token', async () => {
    // A plain function, not a mock: a mock would itself remember the Authorization header.
    const fetchImpl: typeof fetch = () => Promise.resolve(jsonResponse(200, sessionBody()));
    const { exchanger } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);

    // Everything the instance holds (cache and in-flight maps included), as Node would dump it.
    const state = inspect(exchanger, { depth: 6, showHidden: true });
    expect(state).toContain(createHash('sha256').update(ACCESS_TOKEN).digest('hex'));
    expect(state).not.toContain(ACCESS_TOKEN);
  });

  it('maps a backend 429 to AgentSessionRateLimitedError with its Retry-After', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'Retry-After': '42' },
        })
      )
    );
    const { exchanger } = createExchanger(fetchImpl);

    const failure = await exchanger.exchange(ACCESS_TOKEN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentSessionRateLimitedError);
    expect((failure as AgentSessionRateLimitedError).retryAfterSec).toBe(42);
  });

  it('defaults the Retry-After of a 429 without a usable header', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(429, { error: 'temporarily_unavailable' }))
    );
    const { exchanger } = createExchanger(fetchImpl);

    const failure = await exchanger.exchange(ACCESS_TOKEN).catch((error: unknown) => error);

    expect((failure as AgentSessionRateLimitedError).retryAfterSec).toBe(5);
  });

  it('maps a backend 401 to AgentSessionRejectedError', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(jsonResponse(401, { error: 'invalid_token' }))
    );
    const { exchanger } = createExchanger(fetchImpl);

    await expect(exchanger.exchange(ACCESS_TOKEN)).rejects.toBeInstanceOf(
      AgentSessionRejectedError
    );
  });

  it.each([
    ['503', () => Promise.resolve(jsonResponse(503, {}))],
    ['500', () => Promise.resolve(jsonResponse(500, {}))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
    ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['non-JSON body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
    ['body missing fields', () => Promise.resolve(jsonResponse(200, { token: 'x' }))],
    [
      'non-numeric expires_at',
      () => Promise.resolve(jsonResponse(200, sessionBody({ expires_at: 'soon' }))),
    ],
    ['empty token', () => Promise.resolve(jsonResponse(200, sessionBody({ token: '' })))],
    [
      'token without role claims',
      () => Promise.resolve(jsonResponse(200, sessionBody({ token: 'not-a-jwt' }))),
    ],
    ['empty scope', () => Promise.resolve(jsonResponse(200, sessionBody({ scope: '' })))],
    ['unexpected 403', () => Promise.resolve(jsonResponse(403, {}))],
  ])('maps %s to AgentSessionUnavailableError', async (_name, respond) => {
    const { exchanger } = createExchanger(vi.fn<typeof fetch>(respond));

    await expect(exchanger.exchange(ACCESS_TOKEN)).rejects.toBeInstanceOf(
      AgentSessionUnavailableError
    );
  });

  it('aborts the request after the configured timeout', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'));
          });
        })
    );
    const { exchanger } = createExchanger(fetchImpl, { timeoutMs: 20 });

    await expect(exchanger.exchange(ACCESS_TOKEN)).rejects.toBeInstanceOf(
      AgentSessionUnavailableError
    );
  });

  it('never follows redirects with the bearer token and never uses HTTP caches', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(Response.redirect('https://elsewhere.example/oauth/agent-session', 302))
    );
    const { exchanger } = createExchanger(fetchImpl);

    await expect(exchanger.exchange(ACCESS_TOKEN)).rejects.toBeInstanceOf(
      AgentSessionUnavailableError
    );
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe('error');
    expect(fetchImpl.mock.calls[0][1]?.cache).toBe('no-store');
  });

  it('forgets a cached session so that the next exchange calls the backend again', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(200, sessionBody())));
    const { exchanger } = createExchanger(fetchImpl);

    await exchanger.exchange(ACCESS_TOKEN);
    exchanger.forget(ACCESS_TOKEN);
    await exchanger.exchange(ACCESS_TOKEN);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('keeps the raw token out of error messages', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError(`fetch failed for ${ACCESS_TOKEN}`))
    );
    const { exchanger } = createExchanger(fetchImpl);

    const error = await exchanger.exchange(ACCESS_TOKEN).catch((err: unknown) => err);

    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
  });
});
