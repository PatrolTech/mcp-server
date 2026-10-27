import { PatrolTechApiError } from '@patroltech/agent-capabilities';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProposalParamsTooLargeError,
  ProposalQuotaExceededError,
  ProposalsRateLimitedError,
} from '../../application/ports/proposalStoreErrors.js';
import { FakeAgentProposals } from '../../testing/fakeAgentProposals.js';
import { HttpPendingActionStore } from './HttpPendingActionStore.js';

const API = 'https://api.example.test';
const KEY = 'mcp:user-1:abc';

let backend: FakeAgentProposals;
let requests: { method: string; url: URL; body: unknown; headers: Headers }[];

/** `fetch` hacia el backend falso de propuestas, con el dueño fijo del token. */
function fetchFor(owner = { userId: 'user-1', clientId: 'client-1' }): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    const body: unknown = text ? JSON.parse(text) : undefined;
    const url = new URL(request.url);
    requests.push({ method: request.method, url, body, headers: request.headers });
    return backend.handle(request.method, url, body, owner);
  };
}

function storeFor(fetchImpl = fetchFor(), onExpectedStatus?: (status: number) => void) {
  return new HttpPendingActionStore({
    baseUrl: API,
    fetchImpl,
    timeoutMs: 1000,
    token: 'agent-jwt',
    defaultHeaders: () => ({ 'X-Request-Id': 'req-1' }),
    ...(onExpectedStatus ? { onExpectedStatus } : {}),
  });
}

/** Un `fetch` que responde siempre `status` con el sobre de error de `/api` y ese `errorCode`. */
const rejecting = (status: number, errorCode?: string): typeof fetch =>
  vi.fn(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          success: false,
          message: 'rejected',
          data: null,
          ...(errorCode ? { meta: { errorCode } } : {}),
        }),
        { status, headers: { 'content-type': 'application/json' } }
      )
    )
  );

const item = (n: number) => ({
  action: 'edit_location',
  params: { n },
  organizationId: 'org-a',
  idempotencyKey: `key-${String(n)}`,
});

beforeEach(() => {
  backend = new FakeAgentProposals();
  requests = [];
});

describe('HttpPendingActionStore', () => {
  it('proposes a batch with the agent token and returns it in order with dates', async () => {
    const store = storeFor();

    const withoutKey = { ...item(2), idempotencyKey: null };
    const saved = await store.proposeActions({
      contextKey: KEY,
      ttlMin: 30,
      items: [item(1), withoutKey],
    });

    expect(saved.map((p) => p.params)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(saved[1].idempotencyKey).toBeNull();
    expect(saved[0]).toMatchObject({
      contextKey: KEY,
      action: 'edit_location',
      organizationId: 'org-a',
      status: 'proposed',
      idempotencyKey: 'key-1',
    });
    expect(saved[0].batchId).toBe(saved[1].batchId);
    expect(saved[0].expiresAt).toBeInstanceOf(Date);
    expect(saved[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * 60_000);
    const [post] = requests;
    expect(post.method).toBe('POST');
    expect(post.url.href).toBe(`${API}/api/agent-proposals/batches`);
    // The backend accepts no null `idempotencyKey`: an item without one omits the field.
    const { idempotencyKey: _omitted, ...secondItem } = withoutKey;
    expect(post.body).toEqual({ contextKey: KEY, ttlMin: 30, items: [item(1), secondItem] });
    expect(post.headers.get('authorization')).toBe('Bearer agent-jwt');
    expect(post.headers.get('x-request-id')).toBe('req-1');
  });

  it('finds the live proposal and its batch; undefined / [] when there is none', async () => {
    const store = storeFor();
    expect(await store.findProposed(KEY)).toBeUndefined();
    expect(await store.findBatch(KEY, crypto.randomUUID())).toEqual([]);
    expect(await store.findBatch(KEY, 'not-a-uuid')).toEqual([]);

    const [first] = await store.proposeActions({
      contextKey: KEY,
      ttlMin: 30,
      items: [item(1), item(2)],
    });

    const live = await store.findProposed(KEY);
    expect(live?.id).toBe(first.id);
    expect((await store.findBatch(KEY, first.batchId ?? '')).map((p) => p.params)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    expect(requests.at(-1)?.url.searchParams.get('contextKey')).toBe(KEY);
    expect((await store.findById(first.id))?.id).toBe(first.id);
    expect(await store.findById(crypto.randomUUID())).toBeUndefined();
  });

  it('claims atomically: the second claim of the same proposal gets undefined', async () => {
    const store = storeFor();
    const [p] = await store.proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(1)] });

    const [a, b] = await Promise.all([
      store.claimForExecution(p.id, KEY),
      store.claimForExecution(p.id, KEY),
    ]);

    expect([a?.status, b?.status].sort()).toEqual(['executing', undefined].sort());
    expect(await store.claimForExecution(p.id, 'mcp:user-1:other')).toBeUndefined();
  });

  it('closes a claimed proposal as executed or failed', async () => {
    const store = storeFor();
    const [ok, ko] = await store.proposeActions({
      contextKey: KEY,
      ttlMin: 30,
      items: [item(1), item(2)],
    });
    await store.claimForExecution(ok.id, KEY);
    await store.claimForExecution(ko.id, KEY);

    await store.markExecuted(ok.id, { text: 'done' });
    await store.markFailed(ko.id, 'refused');

    expect(await store.findById(ok.id)).toMatchObject({
      status: 'executed',
      result: { text: 'done' },
    });
    expect(await store.findById(ko.id)).toMatchObject({ status: 'failed', error: 'refused' });
    expect(await store.executedRecently(KEY, 5)).toBe(true);
  });

  it('reopens the actions not done yet and cancels the live batch', async () => {
    const store = storeFor();
    const [p, q] = await store.proposeActions({
      contextKey: KEY,
      ttlMin: 30,
      items: [item(1), item(2)],
    });
    await store.claimForExecution(p.id, KEY);

    await store.reopenProposed([p.id, q.id], 30);
    expect((await store.findById(p.id))?.status).toBe('proposed');

    const retired = await store.cancelProposed(KEY);
    expect(retired?.status).toBe('cancelled');
    expect(await store.cancelProposed(KEY)).toBeUndefined();
    expect((await store.findBatch(KEY, p.batchId ?? '')).map((x) => x.status)).toEqual([
      'cancelled',
      'cancelled',
    ]);
  });

  it('reopens only actions of the latest batch of their key, as the backend does', async () => {
    const store = storeFor();
    const [old] = await store.proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(1)] });
    await store.claimForExecution(old.id, KEY);
    await store.proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(2)] });

    await store.reopenProposed([old.id], 30);

    expect((await store.findById(old.id))?.status).toBe('executing');
  });

  it('never sees the proposals of another user or OAuth client', async () => {
    const [mine] = await storeFor().proposeActions({
      contextKey: KEY,
      ttlMin: 30,
      items: [item(1)],
    });
    const otherClient = storeFor(fetchFor({ userId: 'user-1', clientId: 'client-2' }));

    expect(await otherClient.findById(mine.id)).toBeUndefined();
    expect(await otherClient.findBatch(KEY, mine.batchId ?? '')).toEqual([]);
    expect(await otherClient.claimForExecution(mine.id, KEY)).toBeUndefined();
  });

  it('turns any other backend rejection into a PatrolTechApiError', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ success: false, message: 'Internal error' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    const store = storeFor(fetchImpl);

    const failure = await store
      .proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(1)] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PatrolTechApiError);
    expect((failure as PatrolTechApiError).status).toBe(500);
  });

  it.each([
    [429, 'PROPOSAL_QUOTA_EXCEEDED', ProposalQuotaExceededError],
    [429, 'RATE_LIMITED', ProposalsRateLimitedError],
    [400, 'PARAMS_TOO_LARGE', ProposalParamsTooLargeError],
  ] as const)(
    'turns a %i %s on propose into its typed error (no HTTP status above the store)',
    async (status, code, type) => {
      const store = storeFor(rejecting(status, code));

      const failure = await store
        .proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(1)] })
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(type);
    }
  );

  it('tells the call tracker which rejections were expected answers (404 / 409)', async () => {
    const expected: number[] = [];
    const store = storeFor(fetchFor(), (status) => expected.push(status));
    const [saved] = await store.proposeActions({ contextKey: KEY, ttlMin: 30, items: [item(1)] });
    await store.cancelProposed(KEY);

    expect(await store.findProposed(KEY)).toBeUndefined();
    expect(await store.findById('missing')).toBeUndefined();
    expect(await store.claimForExecution(saved.id, KEY)).toBeUndefined();

    expect(expected).toEqual([404, 404, 409]);
  });
});
