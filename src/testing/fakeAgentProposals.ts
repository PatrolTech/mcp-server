import { randomUUID } from 'node:crypto';

/**
 * `/api/agent-proposals` en memoria, con la semántica del backend: todo acotado por
 * el dueño (usuario + cliente OAuth del token) y la `contextKey`, un único lote vivo por clave
 * (proponer retira el anterior), reclamo atómico `proposed → executing` y caducidad con el reloj
 * del backend (`clockOffsetMs` lo adelanta en los tests).
 */

export type FakeProposalStatus =
  'proposed' | 'executing' | 'executed' | 'failed' | 'cancelled' | 'expired';

export interface FakeProposal {
  id: string;
  userId: string;
  clientId: string | null;
  contextKey: string;
  batchId: string;
  position: number;
  action: string;
  params: Record<string, unknown>;
  organizationId: string | null;
  status: FakeProposalStatus;
  idempotencyKey: string | null;
  result: unknown;
  error: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProposalOwner {
  userId: string;
  clientId: string | null;
}

const BASE = '/api/agent-proposals';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function respond(status: number, body?: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const success = (data: unknown, status = 200) =>
  respond(status, { success: true, message: 'Operation successful', data, meta: {} });

const failure = (status: number, message: string, errorCode: string, data: unknown = null) =>
  respond(status, { success: false, message, data, meta: { errorCode } });

const isContextKey = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 1 && value.length <= 300 && /\S$/.test(value);

export class FakeAgentProposals {
  readonly rows: FakeProposal[] = [];
  /** Adelanta el reloj del backend (caducidades). */
  clockOffsetMs = 0;
  /** Filas nuevas por usuario cada 24 h (`MAX_PROPOSALS_PER_USER_PER_WINDOW` del backend). */
  quotaMaxRows = 300;
  /** Responde 401 (sesión rechazada) al cerrar una acción como hecha. */
  rejectSessionOnExecuted = false;

  now(): number {
    return Date.now() + this.clockOffsetMs;
  }

  /** Las filas de un lote, en orden (para que los tests miren el estado sin pasar por el MCP). */
  batch(batchId: string): FakeProposal[] {
    return this.rows.filter((r) => r.batchId === batchId).sort((a, b) => a.position - b.position);
  }

  handles(pathname: string): boolean {
    return pathname === BASE || pathname.startsWith(`${BASE}/`);
  }

  handle(method: string, url: URL, body: unknown, owner: ProposalOwner): Response {
    const rest = url.pathname.slice(BASE.length);
    const contextKey = url.searchParams.get('contextKey');
    const input = (body ?? {}) as Record<string, unknown>;

    if (method === 'POST' && rest === '/batches') return this.propose(owner, input);
    if (method === 'GET' && rest.startsWith('/batches/')) {
      if (!isContextKey(contextKey))
        return failure(400, 'contextKey is required', 'INVALID_REQUEST');
      const batchId = rest.slice('/batches/'.length).toLowerCase();
      return success(UUID.test(batchId) ? this.ownBatch(owner, contextKey, batchId).map(dto) : []);
    }
    if (method === 'GET' && rest === '/live') {
      if (!isContextKey(contextKey))
        return failure(400, 'contextKey is required', 'INVALID_REQUEST');
      const live = this.live(owner, contextKey).at(0);
      return live ? success(dto(live)) : failure(404, 'No live agent proposal', 'NO_LIVE_PROPOSAL');
    }
    if (method === 'GET' && rest === '/executed-recently') {
      const withinMin = Number(url.searchParams.get('withinMin'));
      const since = this.now() - withinMin * 60_000;
      const executed = this.rows.some(
        (r) =>
          this.owns(owner, r) &&
          r.contextKey === contextKey &&
          r.status === 'executed' &&
          r.updatedAt >= since
      );
      return success({ executed });
    }
    if (method === 'POST' && rest === '/reopen') return this.reopen(owner, input);
    if (method === 'POST' && rest === '/cancel') return this.cancel(owner, input);

    const match = /^\/([^/]+)(\/claim|\/executed|\/failed)?$/.exec(rest);
    const id = match?.[1]?.toLowerCase();
    const row =
      id && UUID.test(id) ? this.rows.find((r) => r.id === id && this.owns(owner, r)) : undefined;
    if (method === 'GET' && match && !match[2]) {
      return row
        ? success(dto(row))
        : failure(404, 'Agent proposal not found', 'PROPOSAL_NOT_FOUND');
    }
    if (method === 'POST' && match?.[2] === '/claim') return this.claim(row, input.contextKey);
    if (method === 'POST' && match?.[2] === '/executed' && this.rejectSessionOnExecuted) {
      return failure(401, 'TOKEN_EXPIRED', 'TOKEN_EXPIRED');
    }
    if (method === 'POST' && match?.[2] === '/executed') {
      if (row?.status !== 'executing')
        return failure(409, 'Not executing', 'PROPOSAL_NOT_EXECUTING');
      this.set(row, { status: 'executed', result: input.result ?? null });
      return respond(204);
    }
    if (method === 'POST' && match?.[2] === '/failed') {
      if (row?.status !== 'executing')
        return failure(409, 'Not executing', 'PROPOSAL_NOT_EXECUTING');
      this.set(row, {
        status: 'failed',
        error: typeof input.error === 'string' && input.error ? input.error : 'unknown error',
      });
      return respond(204);
    }
    return failure(404, 'Not found', 'NOT_FOUND');
  }

  private owns(owner: ProposalOwner, row: FakeProposal): boolean {
    return row.userId === owner.userId && row.clientId === owner.clientId;
  }

  private ownBatch(owner: ProposalOwner, contextKey: string, batchId: string): FakeProposal[] {
    return this.batch(batchId).filter((r) => this.owns(owner, r) && r.contextKey === contextKey);
  }

  /** Las `proposed` del último lote que aún tiene alguna, en orden. */
  private live(owner: ProposalOwner, contextKey: string): FakeProposal[] {
    const proposed = this.rows.filter(
      (r) => this.owns(owner, r) && r.contextKey === contextKey && r.status === 'proposed'
    );
    const latest = proposed.reduce<FakeProposal | undefined>(
      (best, r) => (!best || r.createdAt > best.createdAt ? r : best),
      undefined
    );
    return latest
      ? proposed.filter((r) => r.batchId === latest.batchId).sort((a, b) => a.position - b.position)
      : [];
  }

  private set(row: FakeProposal, changes: Partial<FakeProposal>): void {
    Object.assign(row, changes, { updatedAt: this.now() });
  }

  private retire(rows: FakeProposal[]): void {
    for (const row of rows) {
      this.set(row, { status: row.expiresAt <= this.now() ? 'expired' : 'cancelled' });
    }
  }

  private propose(owner: ProposalOwner, input: Record<string, unknown>): Response {
    const { contextKey, ttlMin, items } = input;
    const validTtl =
      typeof ttlMin === 'number' && Number.isInteger(ttlMin) && ttlMin >= 1 && ttlMin <= 60;
    if (
      !isContextKey(contextKey) ||
      !validTtl ||
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 10
    ) {
      return failure(400, 'Invalid agent proposals batch', 'INVALID_REQUEST');
    }
    for (const item of items as Record<string, unknown>[]) {
      const params = item.params;
      const key = item.idempotencyKey;
      // Como el contrato del backend: `idempotencyKey` es opcional pero nunca null.
      const validKey =
        key === undefined || (typeof key === 'string' && key.length >= 1 && key.length <= 120);
      if (
        typeof item.action !== 'string' ||
        typeof params !== 'object' ||
        params === null ||
        Array.isArray(params) ||
        !validKey
      ) {
        return failure(400, 'Invalid agent proposals batch', 'INVALID_REQUEST');
      }
      if (JSON.stringify(params).length > 16_384) {
        return failure(400, 'The params are too large', 'PARAMS_TOO_LARGE');
      }
    }
    const now = this.now();
    const live = this.rows.filter(
      (r) => this.owns(owner, r) && r.contextKey === contextKey && r.status === 'proposed'
    );
    // Como el backend: las vivas que el lote repite tal cual se arrastran (su copia las sustituye)
    // y no cuentan dos veces en la cuota; las demás se retiran.
    const carried = carriedOver(
      live.filter((r) => r.expiresAt > now),
      items as Record<string, unknown>[]
    );
    const windowStart = now - 24 * 60 * 60_000;
    const used = this.rows.filter((r) => r.userId === owner.userId && r.createdAt >= windowStart);
    if (used.length - carried.size + items.length > this.quotaMaxRows) {
      return failure(
        429,
        'Too many agent proposals in the last 24 hours',
        'PROPOSAL_QUOTA_EXCEEDED'
      );
    }
    for (let n = this.rows.length - 1; n >= 0; n--) {
      if (carried.has(this.rows[n].id)) this.rows.splice(n, 1);
    }
    this.retire(live.filter((r) => !carried.has(r.id)));
    const batchId = randomUUID();
    const created = (items as Record<string, unknown>[]).map((item, position): FakeProposal => ({
      id: randomUUID(),
      ...owner,
      contextKey,
      batchId,
      position,
      action: item.action as string,
      params: item.params as Record<string, unknown>,
      // El backend guarda el UUID de la organización en minúsculas.
      organizationId:
        typeof item.organizationId === 'string' ? item.organizationId.toLowerCase() : null,
      status: 'proposed',
      idempotencyKey: (item.idempotencyKey as string | undefined) ?? null,
      result: null,
      error: null,
      expiresAt: now + ttlMin * 60_000,
      // Lotes posteriores, siempre más recientes aunque caigan en el mismo milisegundo.
      createdAt: now + this.rows.length,
      updatedAt: now,
    }));
    this.rows.push(...created);
    return success(created.map(dto), 201);
  }

  private claim(row: FakeProposal | undefined, contextKey: unknown): Response {
    if (!isContextKey(contextKey)) return failure(400, 'contextKey is required', 'INVALID_REQUEST');
    if (row?.contextKey !== contextKey) {
      return failure(404, 'Agent proposal not found', 'PROPOSAL_NOT_FOUND');
    }
    if (row.status === 'proposed' && row.expiresAt > this.now()) {
      this.set(row, { status: 'executing' });
      return success(dto(row));
    }
    if (row.status === 'proposed') this.set(row, { status: 'expired' });
    return failure(409, 'The proposal cannot be claimed', 'PROPOSAL_NOT_CLAIMABLE', {
      status: row.status,
    });
  }

  private reopen(owner: ProposalOwner, input: Record<string, unknown>): Response {
    const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
    const ttlMin = Number(input.ttlMin);
    // Como el backend: solo las del último lote de su clave (uno más viejo ya no resucita).
    const latestBatchOf = (contextKey: string) =>
      this.rows
        .filter((r) => this.owns(owner, r) && r.contextKey === contextKey)
        .reduce<FakeProposal | undefined>(
          (best, r) => (!best || r.createdAt > best.createdAt ? r : best),
          undefined
        )?.batchId;
    for (const row of this.rows) {
      if (
        this.owns(owner, row) &&
        ids.includes(row.id) &&
        ['proposed', 'executing'].includes(row.status) &&
        row.batchId === latestBatchOf(row.contextKey)
      ) {
        this.set(row, { status: 'proposed', expiresAt: this.now() + ttlMin * 60_000 });
      }
    }
    return respond(204);
  }

  private cancel(owner: ProposalOwner, input: Record<string, unknown>): Response {
    if (!isContextKey(input.contextKey))
      return failure(400, 'contextKey is required', 'INVALID_REQUEST');
    const live = this.live(owner, input.contextKey);
    if (live.length === 0) return failure(404, 'No live agent proposal', 'NO_LIVE_PROPOSAL');
    this.retire(live);
    return success(dto(live[0]));
  }
}

/** Las vivas que el lote nuevo repite tal cual (acción, params, organización, clave), una a una. */
function carriedOver(live: FakeProposal[], items: Record<string, unknown>[]): Set<string> {
  const key = (action: unknown, params: unknown, org: unknown, idempotencyKey: unknown) =>
    JSON.stringify([
      action,
      JSON.stringify(params),
      typeof org === 'string' ? org.toLowerCase() : '',
      idempotencyKey ?? '',
    ]);
  const pending = new Map<string, string[]>();
  for (const row of live) {
    const k = key(row.action, row.params, row.organizationId, row.idempotencyKey);
    pending.set(k, [...(pending.get(k) ?? []), row.id]);
  }
  const carried = new Set<string>();
  for (const item of items) {
    const id = pending
      .get(key(item.action, item.params, item.organizationId, item.idempotencyKey))
      ?.shift();
    if (id) carried.add(id);
  }
  return carried;
}

function dto(row: FakeProposal) {
  return {
    id: row.id,
    contextKey: row.contextKey,
    batchId: row.batchId,
    action: row.action,
    params: row.params,
    organizationId: row.organizationId,
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    result: row.result,
    error: row.error,
    expiresAt: new Date(row.expiresAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    clientId: row.clientId,
  };
}
