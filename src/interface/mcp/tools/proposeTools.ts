import type { McpServer } from '@modelcontextprotocol/server';
import {
  MAX_POR_LOTE,
  argsFromEnglish,
  englishInputSchema,
  internalParamNames,
  type CapabilityMeta,
  type CatalogAction,
} from '@patroltech/agent-capabilities';
import type { z } from 'zod';
import type { ProposableAction } from '../../../application/proposals/ProposalDeps.js';
import { CONFIRM_TOOL } from '../../../application/proposals/proposalMessages.js';
import { proposeAction } from '../../../application/proposals/proposeAction.js';
import {
  WRITE_RATE_LIMIT,
  registerCapabilityTool,
  type ToolBinding,
} from '../registerCapabilityTool.js';
import { organizationInput } from './toolDescriptions.js';
import { isRefusal } from '../../../application/ToolOutcome.js';
import {
  PROPOSE_ANNOTATIONS,
  actingUser,
  proposalDepsFor,
  type WriteToolDeps,
} from './writeTools.js';

/** La línea que dice qué hace de verdad una herramienta `propose_*` (el «Use when» ya lo da el catálogo). */
export const PROPOSE_GUIDANCE =
  `It only adds a proposal to the pending batch of this connection (up to ${String(MAX_POR_LOTE)} changes); nothing changes in the account yet. ` +
  `Show the returned summaries to the user and call ${CONFIRM_TOOL} only after they agree.`;

/**
 * Los parámetros que ve el modelo: los de la acción sin los internos (los rellena `preparar`, que
 * los sobrescribe igualmente; el esquema de entrada descarta los que lleguen).
 */
export function modelParams(params: z.ZodRawShape): z.ZodRawShape {
  const internal = new Set(internalParamNames(params));
  return Object.fromEntries(Object.entries(params).filter(([name]) => !internal.has(name)));
}

/** Descripción MCP de una acción: SOLO el resumen en inglés del catálogo más la línea de propuesta. */
export function describeProposal(meta: CapabilityMeta): string {
  return `${meta.summary.en} ${PROPOSE_GUIDANCE}`;
}

/**
 * Una herramienta `patroltech_<area>_propose_<verb>` por acción del catálogo `mcp`: sus parámetros
 * (en inglés; a la acción le llegan en español) más `organization` (salvo las del propio usuario,
 * `scope: 'user'`), solo si el rol del usuario en esa organización la permite, y siempre a un lote
 * pendiente (nunca cambia nada; eso lo hace `patroltech_proposals_confirm`).
 */
export function registerProposeTools(
  server: McpServer,
  binding: ToolBinding,
  actions: readonly CatalogAction[],
  catalog: ReadonlyMap<string, ProposableAction>,
  writes: WriteToolDeps
): void {
  for (const { meta, action: definition } of actions) {
    const action: ProposableAction | undefined = catalog.get(definition.nombre);
    if (!action)
      throw new Error(`Action missing from the proposable catalog: ${definition.nombre}`);
    // Lo que solo afecta al usuario (sus avisos) no le hace elegir organización.
    const userLevel = meta.scope === 'user';
    const params = modelParams(action.definition.params);
    registerCapabilityTool(
      server,
      binding,
      {
        name: action.toolName,
        title: meta.title.en,
        description: describeProposal(meta),
        inputSchema: userLevel
          ? englishInputSchema(meta.id, params)
          : { ...englishInputSchema(meta.id, params), organization: organizationInput },
        annotations: PROPOSE_ANNOTATIONS,
        operation: 'write',
        requiredScope: 'write',
        rateLimit: WRITE_RATE_LIMIT,
      },
      async (args, call) => {
        const { organization, ...actionParams } = args;
        const context = userLevel
          ? await call.userCapabilityContext()
          : await call.capabilityContext(
              typeof organization === 'string' ? organization : undefined
            );
        if (isRefusal(context)) return context;
        const deps = proposalDepsFor(binding, writes, catalog, call.identity, context.token);
        return proposeAction(deps, {
          action,
          context,
          user: actingUser(call.identity),
          params: argsFromEnglish(params, actionParams),
        });
      }
    );
  }
}
