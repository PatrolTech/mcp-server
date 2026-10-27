import { MAX_POR_LOTE, type PendingAction } from '@patroltech/agent-capabilities';
import type { BatchState } from '../../domain/proposals/batchState.js';

/**
 * Textos del motor de propuestas que lee el modelo (en inglés, sin nombres de plan ni canales).
 * Los resúmenes y los resultados de cada acción van aparte, en el idioma del usuario y bajo la
 * nota de datos (repiten lo que escribió).
 */

export const CONFIRM_TOOL = 'patroltech_proposals_confirm';
export const CANCEL_TOOL = 'patroltech_proposals_cancel';

export const NEXT_AFTER_PROPOSE =
  'Show these changes to the user and ask for confirmation, then call patroltech_proposals_confirm with batchId.';

export const BUSY =
  'Another change of this connection is still being processed. Retry in a few seconds.';

export function batchBeingConfirmed(batchId: string | null): string {
  return (
    `The pending batch ${batchId ?? ''} of this connection is being confirmed right now (or was just partly applied). ` +
    `Wait a minute and retry, or call ${CONFIRM_TOOL} with that batchId to finish it.`
  );
}

export const QUOTA_EXCEEDED =
  'Too many changes were proposed today on this account, so no more can be stored now. ' +
  `Confirm or cancel the pending batch (${CONFIRM_TOOL} / ${CANCEL_TOOL}), or try again tomorrow.`;

export const PROPOSALS_RATE_LIMITED = 'Too many proposals in the last minute. Retry in a minute.';

export const PARAMS_TOO_LARGE =
  'The text of this change is too long to store. Shorten it (for example the comment or description) and propose it again.';

export function alreadyPendingNotice(count: number): string {
  return (
    `${String(count)} of these changes were already pending from earlier calls on this connection (addedNow: false). ` +
    'Show all of them to the user before confirming.'
  );
}

export function droppedNotice(count: number): string {
  return `${String(count)} earlier pending change(s) could no longer be kept (no longer available) and were dropped from the batch.`;
}

export const ACTION_UNAVAILABLE = 'This change is no longer available; nothing was done.';

export function batchFull(batchId: string | null): string {
  return (
    `The pending batch ${batchId ?? ''} already holds ${String(MAX_POR_LOTE)} changes, the most one confirmation can hold. ` +
    `Ask the user to confirm or cancel it (${CONFIRM_TOOL} / ${CANCEL_TOOL}) and then propose the rest.`
  );
}

export function duplicateChange(batchId: string | null): string {
  return `This change is already in the pending batch ${batchId ?? ''} with the same data; do not propose it again.`;
}

export function roleNotAllowed(minimumRole: string, organizationWide: boolean): string {
  const scope = organizationWide ? ' on the whole organization (not only on some locations)' : '';
  return `The user's role does not allow this change: it needs ${minimumRole} or higher${scope}. Tell the user; someone with that role can make it.`;
}

/** Qué está pendiente ahora en esta conexión, para orientar tras un `batchId` que no vale. */
export function pendingHint(live: PendingAction | undefined): string {
  if (!live?.batchId || live.expiresAt.getTime() <= Date.now()) return 'Nothing is pending now.';
  return `The pending batch now is ${live.batchId}; show its changes to the user before confirming it.`;
}

export function batchNotFound(batchId: string, live: PendingAction | undefined): string {
  return `There is no pending batch ${batchId} for this connection (it never existed here, or a newer batch replaced it). ${pendingHint(live)}`;
}

/** Por qué no se puede confirmar o cancelar un lote que ya no tiene nada pendiente. */
export function notPendingMessage(
  batchId: string,
  state: Exclude<BatchState, 'pending'>,
  counts: { done: number; total: number },
  live: PendingAction | undefined
): { reason: string; message: string } {
  switch (state) {
    case 'in_progress':
      return {
        reason: 'proposal_in_progress',
        message: `Batch ${batchId} is already being applied by another confirmation. Wait a few seconds and read the data to check the result; do not confirm it again.`,
      };
    case 'done': {
      const newer =
        live?.batchId && live.batchId !== batchId && live.expiresAt.getTime() > Date.now();
      const rest = newer
        ? ` Other pending changes of this connection are in a newer batch. ${pendingHint(live)}`
        : '';
      return {
        reason: 'proposal_already_executed',
        message: `Batch ${batchId} was already confirmed and executed (${String(counts.done)} of ${String(counts.total)} changes applied); nothing was done again.${rest}`,
      };
    }
    case 'expired':
      return {
        reason: 'proposal_expired',
        message: `Batch ${batchId} expired before it was confirmed; nothing was changed. Propose the changes again if the user still wants them.`,
      };
    case 'withdrawn':
      return {
        reason: 'proposal_withdrawn',
        message: `Batch ${batchId} was cancelled or replaced by a newer batch; nothing of it was done. ${pendingHint(live)}`,
      };
  }
}

export const POLICIES_PENDING_NOTICE =
  'The remaining changes were not applied and are still pending: once the user has accepted the policies, call patroltech_proposals_confirm again with the same batchId.';

export const SESSION_ENDED_WHILE_APPLYING =
  'Could not be confirmed: the session ended while this change was being applied, so it may or may not have been made. Check it before proposing it again.';

export const NOT_REACHED = 'Not applied: the session ended before this change was reached.';

export function sessionEndedNotice(batchId: string): string {
  return `The PatrolTech session expired during the confirmation: reconnect and call ${CONFIRM_TOOL} again with batchId ${batchId} for the changes not applied.`;
}

export function restExpiredNotice(batchId: string): string {
  return `The changes of batch ${batchId} that were still pending expired before this confirmation; propose them again if the user still wants them.`;
}

export const QR_IMAGE_NOTICE =
  'A QR code was generated for the new checkpoint (the image is not sent here): to print it, call patroltech_locations_get_qr_sheet with its location and, in `checkpointIds`, its `id` from patroltech_checkpoints_list.';
