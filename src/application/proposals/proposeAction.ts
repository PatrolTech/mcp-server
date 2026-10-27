import {
  aceptarEnLote,
  fail,
  localIsoWithOffset,
  LOTE_VACIO,
  nuevoTurno,
  reservarEnLote,
  roleAllows,
  type ActionPrepareContext,
  type CapabilityContext,
  type EstadoDelLote,
  type PendingAction,
  type ProposedItem,
} from '@patroltech/agent-capabilities';
import { organizationKey } from '../../domain/proposals/organizationId.js';
import {
  asStoredJson,
  readStoredProposal,
  toStoredParams,
} from '../../domain/proposals/storedProposal.js';
import {
  ProposalParamsTooLargeError,
  ProposalQuotaExceededError,
  ProposalsRateLimitedError,
} from '../ports/proposalStoreErrors.js';
import { okWithNext, refuse, type ToolOutcome, type ToolRefusal } from '../ToolOutcome.js';
import type { ProposableAction, ProposalDeps } from './ProposalDeps.js';
import {
  BUSY,
  NEXT_AFTER_PROPOSE,
  PARAMS_TOO_LARGE,
  PROPOSALS_RATE_LIMITED,
  QUOTA_EXCEEDED,
  alreadyPendingNotice,
  batchBeingConfirmed,
  batchFull,
  droppedNotice,
  duplicateChange,
  roleNotAllowed,
} from './proposalMessages.js';

export interface ProposeInput {
  action: ProposableAction;
  /** El contexto de la organización elegida (ya comprobada como del usuario). */
  context: CapabilityContext;
  user: { id: string; name: string };
  params: Record<string, unknown>;
}

/** Un cambio del lote hecho (o en curso) hace menos de esto: el lote se está confirmando. */
export const CONFIRMING_WINDOW_MS = 2 * 60_000;

interface LiveBatch {
  /** Todas las acciones del lote vivo (vacío si no hay o ya caducó). */
  batch: PendingAction[];
  /** Sus `proposed`, en orden. */
  pending: PendingAction[];
}

async function liveBatch(deps: ProposalDeps): Promise<LiveBatch> {
  const live = await deps.store.findProposed(deps.contextKey);
  if (!live?.batchId || live.expiresAt.getTime() <= Date.now()) return { batch: [], pending: [] };
  const batch = await deps.store.findBatch(deps.contextKey, live.batchId);
  return { batch, pending: batch.filter((p) => p.status === 'proposed') };
}

/**
 * ¿Lo está confirmando alguien ahora? Un cambio `executing`, o `executed` hace nada, con otros aún
 * `proposed`. Volver a proponer entonces resucitaría como propuesta nueva un cambio que la
 * confirmación ya ha reclamado (y se haría dos veces). Defensa en profundidad por si la exclusión
 * por clave caducara; uno `executing` de hace más de la ventana es de una confirmación cortada.
 */
function beingConfirmed(batch: readonly PendingAction[]): boolean {
  const now = Date.now();
  return batch.some(
    (p) =>
      (p.status === 'executing' || p.status === 'executed') &&
      now - p.updatedAt.getTime() < CONFIRMING_WINDOW_MS
  );
}

/** Un rechazo del almacén al guardar el lote que el modelo puede resolver (o esperar). */
function storeRefusal(error: unknown): ToolRefusal | undefined {
  if (error instanceof ProposalQuotaExceededError) {
    return refuse('proposal_quota_exceeded', QUOTA_EXCEEDED);
  }
  if (error instanceof ProposalsRateLimitedError) {
    return refuse('proposals_rate_limited', PROPOSALS_RATE_LIMITED);
  }
  if (error instanceof ProposalParamsTooLargeError) {
    return refuse('params_too_large', PARAMS_TOO_LARGE);
  }
  return undefined;
}

/**
 * Añade una propuesta al lote vivo de este usuario y cliente. El backend guarda UN lote vivo por
 * `contextKey` y proponer sustituye al anterior, así que se vuelve a proponer el lote entero: las
 * que ya estaban, intactas (mismos parámetros, clave idempotente y resumen; el backend las
 * arrastra sin gastar cuota), y la nueva al final, pasando por la política de lote del paquete como
 * en el asistente de chat (máximo 10, sin repetidas). Nada cambia en la cuenta hasta `confirmBatch`. En
 * exclusiva por clave: dos propuestas en paralelo no se pisan.
 */
export async function proposeAction(deps: ProposalDeps, input: ProposeInput): Promise<ToolOutcome> {
  const { definition } = input.action;
  if (!roleAllows(definition, input.context.org)) {
    return refuse(
      'role_not_allowed',
      roleNotAllowed(definition.rolMinimo, definition.rolDeOrganizacion === true)
    );
  }
  const locked = await deps.lock.run(deps.contextKey, () => addToBatch(deps, input));
  return locked.acquired ? locked.value : refuse('busy', BUSY);
}

async function addToBatch(deps: ProposalDeps, input: ProposeInput): Promise<ToolOutcome> {
  const { definition } = input.action;
  const pending: PendingAction[] = [];
  const turno = nuevoTurno();
  let estado: EstadoDelLote = LOTE_VACIO;
  let dropped = 0;

  const live = await liveBatch(deps);
  const batchId = live.pending[0]?.batchId ?? null;
  if (beingConfirmed(live.batch)) return refuse('busy', batchBeingConfirmed(batchId));

  for (const record of live.pending) {
    const stored = readStoredProposal(record.params);
    const known = deps.actions.get(record.action);
    // Una propuesta sin el formato del MCP o de una acción retirada no se podría ejecutar.
    if (!stored || !known) {
      dropped += 1;
      continue;
    }
    const reserved = reservarEnLote(estado, record.action);
    if (reserved.ok) estado = reserved.estado;
    const accepted = aceptarEnLote(estado, {
      definition: known.definition,
      orgId: organizationKey(record.organizationId),
      params: stored.params,
    });
    if (accepted.ok) estado = accepted.estado;
    turno.registrar(stored.routeChanges);
    pending.push(record);
  }

  const reserved = reservarEnLote(estado, definition.nombre);
  if (!reserved.ok) return refuse('batch_full', batchFull(batchId));

  const context: ActionPrepareContext = { ...input.context, user: input.user, turno };
  const prepared = definition.preparar
    ? await definition.preparar(context, input.params)
    : { params: input.params };
  if ('error' in prepared) return fail(prepared.error);
  const params = asStoredJson(prepared.params);

  const accepted = aceptarEnLote(reserved.estado, {
    definition,
    orgId: organizationKey(input.context.org.orgId),
    params,
  });
  if (!accepted.ok) return refuse('duplicate_proposal', duplicateChange(batchId));

  const summary = definition.resumen(params, {
    idioma: input.context.language,
    organizacion: input.context.org.name,
  });
  const items: ProposedItem[] = [
    ...pending.map((record) => ({
      action: record.action,
      params: record.params,
      organizationId: record.organizationId,
      idempotencyKey: record.idempotencyKey,
    })),
    {
      action: definition.nombre,
      params: toStoredParams({
        params,
        summary,
        routeChanges: prepared.cambiosEnRutas ?? [],
      }),
      organizationId: input.context.org.orgId,
      idempotencyKey: prepared.idempotencyKey ?? null,
    },
  ];
  let saved: PendingAction[];
  try {
    saved = await deps.store.proposeActions({
      contextKey: deps.contextKey,
      ttlMin: deps.ttlMin,
      items,
    });
  } catch (error) {
    const refusal = storeRefusal(error);
    if (refusal) return refusal;
    throw error;
  }

  const notices = [
    ...(pending.length > 0 ? [alreadyPendingNotice(pending.length)] : []),
    ...(dropped > 0 ? [droppedNotice(dropped)] : []),
  ];
  return okWithNext(
    {
      batchId: saved[0]?.batchId ?? null,
      items: saved.map((record, index) => ({
        action: deps.actions.get(record.action)?.toolName ?? record.action,
        summary: readStoredProposal(record.params)?.summary ?? '',
        // La última es la de esta llamada; las demás venían de llamadas anteriores.
        addedNow: index === saved.length - 1,
      })),
      expiresAt: saved[0]?.expiresAt.toISOString() ?? null,
      // La misma hora en la zona de la cuenta: el modelo pasa mal UTC a local con el cambio de hora.
      expiresAtLocal: saved[0] ? localIsoWithOffset(saved[0].expiresAt, input.context.tz) : null,
      timezone: input.context.tz,
    },
    NEXT_AFTER_PROPOSE,
    notices
  );
}
