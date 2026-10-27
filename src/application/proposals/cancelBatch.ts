import { ok } from '@patroltech/agent-capabilities';
import { batchStateOf } from '../../domain/proposals/batchState.js';
import { readStoredProposal } from '../../domain/proposals/storedProposal.js';
import { refuse, type ToolOutcome } from '../ToolOutcome.js';
import type { ProposalDeps } from './ProposalDeps.js';
import { notPendingRefusal } from './confirmBatch.js';
import { BUSY, batchNotFound } from './proposalMessages.js';

/**
 * Retira el lote `batchId` si sigue pendiente (ninguno de sus cambios se hace). El backend retira
 * el lote vivo de la clave, que solo puede ser este: un lote con algo `proposed` es el vivo, y en
 * exclusiva por clave nadie lo sustituye entre la lectura y la retirada.
 */
export async function cancelBatch(deps: ProposalDeps, batchId: string): Promise<ToolOutcome> {
  const locked = await deps.lock.run(deps.contextKey, async (): Promise<ToolOutcome> => {
    const { store, contextKey } = deps;
    const batch = await store.findBatch(contextKey, batchId);
    if (batch.length === 0) {
      return refuse(
        'proposal_not_found',
        batchNotFound(batchId, await store.findProposed(contextKey))
      );
    }
    if (batchStateOf(batch.map((p) => p.status)) !== 'pending') {
      return notPendingRefusal(deps, batchId, batch);
    }
    const retired = await store.cancelProposed(contextKey);
    if (!retired) return refuse('proposal_not_found', batchNotFound(batchId, undefined));
    const pending = batch.filter((p) => p.status === 'proposed');
    return ok({
      batchId,
      status: retired.status === 'expired' ? 'expired' : 'cancelled',
      cancelled: pending.map((p) => ({
        action: deps.actions.get(p.action)?.toolName ?? p.action,
        summary: readStoredProposal(p.params)?.summary ?? '',
      })),
    });
  });
  return locked.acquired ? locked.value : refuse('busy', BUSY);
}
