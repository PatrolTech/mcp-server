import type { CambioEnRuta } from '@patroltech/agent-capabilities';
import { z } from 'zod';

/**
 * Lo que el MCP guarda como `params` de cada propuesta: los parámetros ya preparados (los que
 * recibirá `ejecutar`), el resumen que vio el usuario y los cambios que hace en los checkpoints de
 * rutas. Las propuestas de un lote se preparan en llamadas distintas (una petición HTTP cada una):
 * sin guardar esos cambios, la siguiente de la misma ruta no los vería (orden, ruta que se vacía).
 */
export interface StoredProposal {
  params: Record<string, unknown>;
  summary: string;
  routeChanges: CambioEnRuta[];
}

/** Versión del formato: un registro de otro formato no se ejecuta nunca. */
export const STORED_PROPOSAL_FORMAT = 'mcp-proposal/1';

const storedProposalSchema = z.object({
  format: z.literal(STORED_PROPOSAL_FORMAT),
  params: z.record(z.string(), z.unknown()),
  summary: z.string(),
  routeChanges: z.array(
    z.object({
      rutaId: z.string().min(1),
      checkpointId: z.string().min(1),
      op: z.enum(['añadir', 'quitar']),
    })
  ),
});

/**
 * Los parámetros tal como vuelven del almacén (JSON): sin claves `undefined`. Se comparan y se
 * resumen así para que una propuesta recién preparada y la misma ya guardada sean iguales.
 */
export function asStoredJson(params: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
}

export function toStoredParams(proposal: StoredProposal): Record<string, unknown> {
  return {
    format: STORED_PROPOSAL_FORMAT,
    params: proposal.params,
    summary: proposal.summary,
    routeChanges: proposal.routeChanges,
  };
}

/** La propuesta guardada, o `undefined` si no tiene el formato del MCP. */
export function readStoredProposal(raw: unknown): StoredProposal | undefined {
  const parsed = storedProposalSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { params, summary, routeChanges } = parsed.data;
  return { params, summary, routeChanges };
}
