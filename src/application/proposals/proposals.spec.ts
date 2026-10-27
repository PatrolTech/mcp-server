import { randomUUID } from 'node:crypto';
import {
  AccionRechazada,
  ORGANIZATION_NOT_RECOGNISED,
  PatrolTechApiError,
  defineBotAction,
  noopLogger,
  turnoDe,
  withOrganizationGuard,
  type ActionDefinition,
  type CapabilityContext,
} from '@patroltech/agent-capabilities';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { HttpPendingActionStore } from '../../infrastructure/proposals/HttpPendingActionStore.js';
import { FakeAgentProposals } from '../../testing/fakeAgentProposals.js';
import type { UserSessionContext } from '../session/sessionContext.js';
import type { ToolOutcome } from '../ToolOutcome.js';
import type { KeyedLock } from '../ports/KeyedLock.js';
import type { ProposableAction, ProposalDeps } from './ProposalDeps.js';
import { confirmBatch } from './confirmBatch.js';
import { proposeAction } from './proposeAction.js';
import { roleNotAllowed } from './proposalMessages.js';

const ORG = { orgId: 'org-a', name: 'Acme', roleType: 'ADMIN', scope: 'organization' as const };
const SESSION: UserSessionContext = {
  organizations: [ORG],
  token: 'agent-jwt',
  tz: 'Europe/Madrid',
  country: null,
  language: 'en',
};
const CONTEXT: CapabilityContext = { ...SESSION, org: ORG };
const USER = { id: 'user-1', name: 'Ana' };

let backend: FakeAgentProposals;
let executed: string[];

/** Una acción de prueba: clave idempotente nueva en cada `preparar` y lo que ve del lote. */
function testAction(
  ejecutar: (name: string) => Promise<void> = () => Promise.resolve()
): ActionDefinition {
  return withOrganizationGuard(
    defineBotAction({
      nombre: 'create_route',
      tool: 'proponer_crear_ruta',
      descripcion: 'test',
      params: { name: z.string(), route: z.string().optional() },
      rolMinimo: 'EDITOR',
      huella: (p) => p.name,
      preparar(ctx, p) {
        const before = p.route ? turnoDe(ctx).cambiosEnRuta(p.route).length : 0;
        return Promise.resolve({
          params: { ...p, before },
          idempotencyKey: randomUUID(),
          ...(p.route
            ? { cambiosEnRutas: [{ rutaId: p.route, checkpointId: p.name, op: 'añadir' as const }] }
            : {}),
        });
      },
      resumen: (p) => `Create ${p.name}`,
      async ejecutar(_ctx, p) {
        await ejecutar(p.name);
        executed.push(p.name);
        return { texto: `Created ${p.name}` };
      },
    })
  );
}

const passThroughLock: KeyedLock = {
  run: async (_key, body) => ({ acquired: true, value: await body() }),
};

function depsWith(action: ActionDefinition, lock: KeyedLock = passThroughLock): ProposalDeps {
  const fetchImpl: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const text = await req.text();
    // Una latencia aleatoria entrelaza las llamadas concurrentes.
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));
    return backend.handle(req.method, new URL(req.url), text ? JSON.parse(text) : undefined, {
      userId: 'user-1',
      clientId: 'client-1',
    });
  };
  const proposable: ProposableAction = {
    toolName: 'patroltech_routes_propose_create',
    definition: action,
  };
  return {
    store: new HttpPendingActionStore({
      baseUrl: 'https://api.example.test',
      fetchImpl,
      timeoutMs: 1000,
      token: 'agent-jwt',
    }),
    lock,
    contextKey: 'mcp:user-1:abc',
    actions: new Map([[action.nombre, proposable]]),
    ttlMin: 30,
    urls: {},
    logger: noopLogger,
  };
}

async function propose(
  deps: ProposalDeps,
  params: Record<string, unknown>,
  context: CapabilityContext = CONTEXT
): Promise<ToolOutcome> {
  const action = deps.actions.get('create_route');
  if (!action) throw new Error('missing action');
  return proposeAction(deps, { action, context, user: USER, params });
}

const batchIdOf = (outcome: ToolOutcome): string =>
  (outcome as { data: { batchId: string } }).data.batchId;

beforeEach(() => {
  backend = new FakeAgentProposals();
  executed = [];
});

describe('proposeAction', () => {
  it('keeps the idempotency key of the changes already in the batch', async () => {
    const deps = depsWith(testAction());
    await propose(deps, { name: 'A' });
    const [a] = backend.rows;

    const second = await propose(deps, { name: 'B' });

    const rows = backend.batch(batchIdOf(second));
    expect(rows.map((r) => r.idempotencyKey)).toEqual([a.idempotencyKey, expect.any(String)]);
    expect(rows[1].idempotencyKey).not.toBe(a.idempotencyKey);
    expect(rows[0].params).toEqual(a.params);
  });

  it('lets a later change see the route changes of the earlier ones (stored with them)', async () => {
    const deps = depsWith(testAction());
    await propose(deps, { name: 'A', route: 'r-1' });

    const second = await propose(deps, { name: 'B', route: 'r-1' });

    const rows = backend.batch(batchIdOf(second));
    expect((rows[1].params as { params: { before: number } }).params.before).toBe(1);
  });
});

describe('proposeAction with an unreadable earlier change', () => {
  it('drops it from the batch and says so', async () => {
    const deps = depsWith(testAction());
    await propose(deps, { name: 'A' });
    backend.rows[0].params = { not: 'an MCP proposal' };

    const outcome = await propose(deps, { name: 'B' });

    expect(outcome).toMatchObject({
      ok: true,
      avisos: [expect.stringContaining('could no longer be kept')],
    });
    expect(backend.batch(batchIdOf(outcome))).toHaveLength(1);
  });
});

describe('proposeAction with upper-case organization ids', () => {
  it('detects a repeat although the backend stores the id in lower case', async () => {
    const upper = { ...ORG, orgId: 'ORG-A' };
    const context: CapabilityContext = { ...CONTEXT, org: upper, organizations: [upper] };
    const deps = depsWith(testAction());
    await propose(deps, { name: 'A' }, context);
    expect(backend.rows[0].organizationId).toBe('org-a');

    const again = await propose(deps, { name: 'A' }, context);

    expect(again).toMatchObject({ refused: true, reason: 'duplicate_proposal' });
  });
});

describe('confirmBatch', () => {
  it('without the lock, two simultaneous confirms still execute each change once (atomic claim)', async () => {
    const deps = depsWith(testAction());
    await propose(deps, { name: 'A' });
    const batchId = batchIdOf(await propose(deps, { name: 'B' }));

    await Promise.all([
      confirmBatch(deps, { batchId, session: SESSION, user: USER }),
      confirmBatch(deps, { batchId, session: SESSION, user: USER }),
      confirmBatch(deps, { batchId, session: SESSION, user: USER }),
    ]);

    expect(executed.sort()).toEqual(['A', 'B']);
    expect(backend.batch(batchId).map((r) => r.status)).toEqual(['executed', 'executed']);
  });

  it('checks the role again before executing: a user demoted since proposing gets a clear refusal', async () => {
    const deps = depsWith(testAction());
    const batchId = batchIdOf(await propose(deps, { name: 'A' }));
    const demoted: UserSessionContext = {
      ...SESSION,
      organizations: [{ ...ORG, roleType: 'VIEWER' }],
    };

    const outcome = await confirmBatch(deps, { batchId, session: demoted, user: USER });

    const message = roleNotAllowed('EDITOR', false);
    expect(outcome).toMatchObject({
      ok: true,
      data: { results: [{ status: 'failed', message }], executed: 0, total: 1 },
    });
    expect(executed).toEqual([]);
    expect(backend.batch(batchId).map((r) => [r.status, r.error])).toEqual([['failed', message]]);
  });

  it('an organization no longer in the session is not recognised (not a role problem)', async () => {
    const deps = depsWith(testAction());
    const batchId = batchIdOf(await propose(deps, { name: 'A' }));
    const elsewhere: UserSessionContext = {
      ...SESSION,
      organizations: [{ orgId: 'org-z', name: 'Zeta', roleType: 'ADMIN', scope: 'organization' }],
    };

    const outcome = await confirmBatch(deps, { batchId, session: elsewhere, user: USER });

    expect(outcome).toMatchObject({
      ok: true,
      data: { results: [{ status: 'failed', message: ORGANIZATION_NOT_RECOGNISED }], executed: 0 },
    });
    expect(executed).toEqual([]);
    expect(backend.batch(batchId).map((r) => [r.status, r.error])).toEqual([
      ['failed', ORGANIZATION_NOT_RECOGNISED],
    ]);
  });

  it('marks a change the action refuses as failed with its text and goes on with the next', async () => {
    const deps = depsWith(
      testAction((name) =>
        name === 'A' ? Promise.reject(new AccionRechazada('Ya no se puede.')) : Promise.resolve()
      )
    );
    await propose(deps, { name: 'A' });
    const batchId = batchIdOf(await propose(deps, { name: 'B' }));

    const outcome = await confirmBatch(deps, { batchId, session: SESSION, user: USER });

    expect(outcome).toMatchObject({
      ok: true,
      data: {
        results: [
          { status: 'failed', message: 'Ya no se puede.' },
          { status: 'executed', message: 'Created B' },
        ],
        executed: 1,
        total: 2,
      },
    });
    expect(backend.batch(batchId).map((r) => [r.status, r.error])).toEqual([
      ['failed', 'Ya no se puede.'],
      ['executed', null],
    ]);
  });

  it('on a 451 (policies) leaves the rest pending to confirm again, like the bot', async () => {
    const ejecutar = vi.fn((name: string) =>
      name === 'B'
        ? Promise.reject(new PatrolTechApiError(451, '/api/x', { message: 'policies' }))
        : Promise.resolve()
    );
    const deps = depsWith(testAction(ejecutar));
    await propose(deps, { name: 'A' });
    await propose(deps, { name: 'B' });
    const batchId = batchIdOf(await propose(deps, { name: 'C' }));

    const outcome = await confirmBatch(deps, { batchId, session: SESSION, user: USER });

    expect(backend.batch(batchId).map((r) => r.status)).toEqual([
      'executed',
      'proposed',
      'proposed',
    ]);
    expect(outcome).toMatchObject({
      ok: true,
      data: { results: [{ status: 'executed' }, { status: 'not_done' }, { status: 'not_done' }] },
      avisos: [expect.stringContaining('accepted the policies')],
    });
    expect(ejecutar).not.toHaveBeenCalledWith('C');
  });

  it('after a partial batch, an expiry of the rest does not claim that nothing changed', async () => {
    const ejecutar = vi.fn((name: string) =>
      name === 'B' && ejecutar.mock.calls.filter(([n]) => n === 'B').length === 1
        ? Promise.reject(new PatrolTechApiError(451, '/api/x', { message: 'policies' }))
        : Promise.resolve()
    );
    const deps = depsWith(testAction(ejecutar));
    await propose(deps, { name: 'A' });
    const batchId = batchIdOf(await propose(deps, { name: 'B' }));
    await confirmBatch(deps, { batchId, session: SESSION, user: USER });
    backend.clockOffsetMs = 31 * 60_000;

    const outcome = await confirmBatch(deps, { batchId, session: SESSION, user: USER });

    expect(outcome).toMatchObject({
      ok: true,
      data: { results: [{ status: 'executed' }, { status: 'not_done' }], executed: 1 },
      avisos: [expect.stringContaining('expired before this confirmation')],
    });
  });

  it('a confirmed batch whose rest moved to a newer batch points to it', async () => {
    const ejecutar = vi.fn((name: string) =>
      name === 'B'
        ? Promise.reject(new PatrolTechApiError(451, '/api/x', { message: 'policies' }))
        : Promise.resolve()
    );
    const deps = depsWith(testAction(ejecutar));
    await propose(deps, { name: 'A' });
    const oldBatch = batchIdOf(await propose(deps, { name: 'B' }));
    await confirmBatch(deps, { batchId: oldBatch, session: SESSION, user: USER });
    // Outside the "being confirmed" window, a new proposal carries B into a newer batch.
    backend.rows.forEach((r) => (r.updatedAt -= 5 * 60_000));
    const newBatch = batchIdOf(await propose(deps, { name: 'C' }));

    const outcome = await confirmBatch(deps, { batchId: oldBatch, session: SESSION, user: USER });

    expect(outcome).toMatchObject({ refused: true, reason: 'proposal_already_executed' });
    expect((outcome as { message: string }).message).toContain(
      `The pending batch now is ${newBatch}`
    );
  });
});
