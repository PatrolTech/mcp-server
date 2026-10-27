import type { PendingActionStatus } from '@patroltech/agent-capabilities';

/**
 * En qué punto está un lote de propuestas, por los estados de sus acciones:
 * - `pending`: le queda alguna `proposed` (se puede confirmar o cancelar);
 * - `in_progress`: otra confirmación lo está ejecutando;
 * - `done`: ya se confirmó (hechas o fallidas);
 * - `expired`: caducó sin confirmarse;
 * - `withdrawn`: se canceló o lo sustituyó un lote más nuevo.
 */
export type BatchState = 'pending' | 'in_progress' | 'done' | 'expired' | 'withdrawn';

export function batchStateOf(statuses: readonly PendingActionStatus[]): BatchState {
  if (statuses.includes('proposed')) return 'pending';
  if (statuses.includes('executing')) return 'in_progress';
  if (statuses.some((s) => s === 'executed' || s === 'failed')) return 'done';
  if (statuses.includes('expired')) return 'expired';
  return 'withdrawn';
}
