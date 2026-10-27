import {
  AccionRechazada,
  ORGANIZATION_NOT_RECOGNISED,
  roleAllows,
  translateActionError,
  type ActionContext,
  type ActionResult,
  type OrganizationRef,
  type PendingAction,
  type PendingActionStatus,
} from '@patroltech/agent-capabilities';
import { batchStateOf } from '../../domain/proposals/batchState.js';
import { sameOrganizationId } from '../../domain/proposals/organizationId.js';
import { readStoredProposal } from '../../domain/proposals/storedProposal.js';
import type { UserSessionContext } from '../session/sessionContext.js';
import { refuse, type ToolOutcome } from '../ToolOutcome.js';
import type { ProposalDeps } from './ProposalDeps.js';
import { backendRejectionKind } from './backendRejection.js';
import {
  ACTION_UNAVAILABLE,
  BUSY,
  NOT_REACHED,
  POLICIES_PENDING_NOTICE,
  QR_IMAGE_NOTICE,
  SESSION_ENDED_WHILE_APPLYING,
  batchNotFound,
  notPendingMessage,
  restExpiredNotice,
  roleNotAllowed,
  sessionEndedNotice,
} from './proposalMessages.js';

export interface ConfirmInput {
  batchId: string;
  session: UserSessionContext;
  user: { id: string; name: string };
}

/**
 * Qué pasó con cada cambio del lote: `executed`, `failed`, `not_done` (no se llegó a hacer),
 * `in_progress` (lo está haciendo otra confirmación) o `unknown` (la sesión acabó mientras se
 * aplicaba: puede haberse hecho o no).
 */
export type ChangeOutcome = 'executed' | 'failed' | 'not_done' | 'in_progress' | 'unknown';

export interface ChangeResult {
  action: string;
  summary: string;
  status: ChangeOutcome;
  message?: string;
}

/** Lo que ya estaba resuelto de un cambio antes de esta confirmación. */
function previousOutcome(record: PendingAction): Pick<ChangeResult, 'status' | 'message'> {
  const byStatus: Record<Exclude<PendingActionStatus, 'proposed'>, ChangeOutcome> = {
    executing: 'in_progress',
    executed: 'executed',
    failed: 'failed',
    cancelled: 'not_done',
    expired: 'not_done',
  };
  const status = record.status === 'proposed' ? 'not_done' : byStatus[record.status];
  return { status, ...(record.error ? { message: record.error } : {}) };
}

/** El backend rechazó la sesión de agente: no se puede seguir ni anotar nada más. */
const isSessionRejected = (error: unknown): boolean =>
  backendRejectionKind(error) === 'session_expired';

/**
 * Anotaciones del almacén tras ejecutar: si fallan, se registra y se sigue (el cambio ya se
 * decidió). `session_ended` si fue un 401: la confirmación tiene que parar ahí.
 */
async function bookkeep(
  deps: ProposalDeps,
  step: string,
  write: () => Promise<void>
): Promise<'ok' | 'session_ended'> {
  try {
    await write();
    return 'ok';
  } catch (error) {
    deps.logger.warn('mcp.proposal_bookkeeping_failed', {
      step,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(backendRejectionKind(error) ? { kind: backendRejectionKind(error) } : {}),
    });
    return isSessionRejected(error) ? 'session_ended' : 'ok';
  }
}

/** La organización del cambio en la sesión actual, o `undefined` si ya no es del usuario. */
function organizationOf(
  session: UserSessionContext,
  orgId: string | null
): OrganizationRef | undefined {
  return session.organizations.find((o) => sameOrganizationId(o.orgId, orgId));
}

/** La negativa para un lote que ya no tiene nada `proposed` (compartida con `cancelBatch`). */
export async function notPendingRefusal(
  deps: ProposalDeps,
  batchId: string,
  batch: readonly PendingAction[]
): Promise<ToolOutcome> {
  const state = batchStateOf(batch.map((p) => p.status));
  if (state === 'pending') throw new Error('notPendingRefusal on a pending batch');
  const done = batch.filter((p) => p.status === 'executed').length;
  // Dónde está ahora lo pendiente: lo que no se hizo de este lote pudo pasar a otro más nuevo.
  const live = state === 'in_progress' ? undefined : await deps.store.findProposed(deps.contextKey);
  const { reason, message } = notPendingMessage(
    batchId,
    state,
    { done, total: batch.length },
    live
  );
  return refuse(reason, message);
}

/**
 * Ejecuta el lote ENTERO de `batchId`, en orden, como el asistente de chat de PatrolTech: cada cambio se reclama de forma
 * atómica (de dos confirmaciones a la vez solo una lo recibe), se ejecuta con sus parámetros
 * guardados y su clave idempotente, y se cierra como hecho o fallido. Un rechazo propio de la
 * acción (`AccionRechazada`) o del backend lo deja fallido con su texto y se sigue con el siguiente;
 * un 451 (políticas) devuelve a propuesta lo que falta. Un 401 (sesión caducada) corta: el
 * resultado dice qué se hizo, el cambio en curso queda `unknown` y el resto `not_done`, y lleva
 * `sessionEnded` para que la envoltura lo devuelva (olvidando la sesión) en vez de un mensaje fijo.
 */
export async function confirmBatch(deps: ProposalDeps, input: ConfirmInput): Promise<ToolOutcome> {
  const locked = await deps.lock.run(deps.contextKey, () => runBatch(deps, input));
  return locked.acquired ? locked.value : refuse('busy', BUSY);
}

async function runBatch(deps: ProposalDeps, input: ConfirmInput): Promise<ToolOutcome> {
  const { store, contextKey } = deps;
  const batch = await store.findBatch(contextKey, input.batchId);
  if (batch.length === 0) {
    return refuse(
      'proposal_not_found',
      batchNotFound(input.batchId, await store.findProposed(contextKey))
    );
  }
  if (batchStateOf(batch.map((p) => p.status)) !== 'pending') {
    return notPendingRefusal(deps, input.batchId, batch);
  }

  const results: ChangeResult[] = [];
  const notices = new Set<string>();
  const attempted: PendingActionStatus[] = [];
  // Un objeto (no un `let`): lo cambian también los callbacks de abajo.
  const session = { ended: false };
  const view = (record: PendingAction) => ({
    action: deps.actions.get(record.action)?.toolName ?? record.action,
    summary: readStoredProposal(record.params)?.summary ?? '',
  });
  const endSession = () => {
    session.ended = true;
  };

  for (const [index, record] of batch.entries()) {
    if (record.status !== 'proposed') {
      results.push({ ...view(record), ...previousOutcome(record) });
      continue;
    }
    if (session.ended) {
      results.push({ ...view(record), status: 'not_done', message: NOT_REACHED });
      continue;
    }
    let claimed: PendingAction | undefined;
    try {
      claimed = await store.claimForExecution(record.id, contextKey);
    } catch (error) {
      if (!isSessionRejected(error)) throw error;
      endSession();
      results.push({ ...view(record), status: 'not_done', message: NOT_REACHED });
      continue;
    }
    if (!claimed) {
      const current = await store.findById(record.id).catch((error: unknown) => {
        if (!isSessionRejected(error)) throw error;
        endSession();
        return undefined;
      });
      attempted.push(current?.status ?? 'cancelled');
      results.push({
        ...view(record),
        ...(current ? previousOutcome(current) : { status: 'not_done' as const }),
      });
      continue;
    }
    attempted.push('executing');

    const action = deps.actions.get(claimed.action);
    const stored = readStoredProposal(claimed.params);
    if (!action || !stored) {
      const closed = await bookkeep(deps, 'mark_failed', () =>
        store.markFailed(claimed.id, ACTION_UNAVAILABLE)
      );
      if (closed === 'session_ended') endSession();
      results.push({ ...view(claimed), status: 'failed', message: ACTION_UNAVAILABLE });
      continue;
    }
    const org = organizationOf(input.session, claimed.organizationId);
    // Se vuelven a comprobar los permisos antes de ejecutar (el rol pudo bajar, o la
    // organización dejar de ser suya, desde la propuesta). El backend también lo haría, pero con un
    // 403 genérico. Sin la organización, el mismo texto que el guard anti-fuga del paquete.
    const { definition } = action;
    if (!org || !roleAllows(definition, org)) {
      const refusal = org
        ? roleNotAllowed(definition.rolMinimo, definition.rolDeOrganizacion === true)
        : ORGANIZATION_NOT_RECOGNISED;
      const closed = await bookkeep(deps, 'mark_failed', () =>
        store.markFailed(claimed.id, refusal)
      );
      if (closed === 'session_ended') endSession();
      results.push({ ...view(claimed), status: 'failed', message: refusal });
      continue;
    }
    const context: ActionContext = {
      ...input.session,
      org,
      user: input.user,
      idempotencyKey: claimed.idempotencyKey,
    };
    let result: ActionResult;
    try {
      result = await definition.ejecutar(context, stored.params);
    } catch (error) {
      if (isSessionRejected(error)) {
        // No se sabe si llegó a hacerse (una acción puede hacer varias llamadas).
        endSession();
        results.push({
          ...view(claimed),
          status: 'unknown',
          message: SESSION_ENDED_WHILE_APPLYING,
        });
        continue;
      }
      const message =
        error instanceof AccionRechazada
          ? error.mensajeCliente
          : translateActionError(error, input.session.language, deps.urls).mensajeCliente;
      if (backendRejectionKind(error) === 'policies_pending') {
        // Como en el asistente de chat: lo que falta (este incluido) vuelve a propuesta para confirmarlo después.
        const waiting = batch.slice(index).filter((p) => p.status === 'proposed');
        const reopened = await bookkeep(deps, 'reopen', () =>
          store.reopenProposed(
            waiting.map((p) => p.id),
            deps.ttlMin
          )
        );
        if (reopened === 'session_ended') endSession();
        for (const p of waiting) results.push({ ...view(p), status: 'not_done', message });
        notices.add(POLICIES_PENDING_NOTICE);
        break;
      }
      if (!(error instanceof AccionRechazada) && backendRejectionKind(error) === undefined) {
        deps.logger.warn('mcp.proposal_execution_failed', {
          action: claimed.action,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
      const closed = await bookkeep(deps, 'mark_failed', () =>
        store.markFailed(claimed.id, message)
      );
      if (closed === 'session_ended') endSession();
      results.push({ ...view(claimed), status: 'failed', message });
      continue;
    }
    // Ya está hecho: un fallo al anotarlo no lo convierte en fallido.
    const closed = await bookkeep(deps, 'mark_executed', () =>
      store.markExecuted(claimed.id, { text: result.texto })
    );
    if (closed === 'session_ended') endSession();
    if (result.imagen) notices.add(QR_IMAGE_NOTICE);
    results.push({ ...view(claimed), status: 'executed', message: result.texto });
  }

  const executed = results.filter((r) => r.status === 'executed').length;
  // Todo lo que se intentó había caducado (mismo reloj que el backend).
  if (!session.ended && attempted.length > 0 && attempted.every((s) => s === 'expired')) {
    if (executed === 0) {
      const { reason, message } = notPendingMessage(
        input.batchId,
        'expired',
        { done: 0, total: batch.length },
        undefined
      );
      return refuse(reason, message);
    }
    // Parte del lote ya se había hecho antes (p. ej. antes de un 451): no es «nada cambió».
    notices.add(restExpiredNotice(input.batchId));
  }
  if (session.ended) notices.add(sessionEndedNotice(input.batchId));

  return {
    ok: true,
    data: { batchId: input.batchId, results, executed, total: batch.length },
    ...(notices.size > 0 ? { avisos: [...notices] } : {}),
    ...(session.ended ? { sessionEnded: true } : {}),
  };
}
