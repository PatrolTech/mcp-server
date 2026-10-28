import type { McpServer } from '@modelcontextprotocol/server';
import { DEFAULT_URLS, type PatrolTechGateway } from '@patroltech/agent-capabilities';
import { loadAccountContext } from '../../../application/account/accountContext.js';
import {
  READ_ONLY_ANNOTATIONS,
  READ_RATE_LIMIT,
  registerCapabilityTool,
  type ToolBinding,
} from '../registerCapabilityTool.js';
import { ACCOUNT_CONTEXT_TOOL } from './toolDescriptions.js';

/**
 * La descripción la ve el modelo siempre (va en `tools/list`), aunque no llame a ninguna
 * herramienta: por eso lleva, solo aquí, dónde revisa el usuario esta conexión (el panel de la
 * configuración del conector), además de en las `instructions`, que no todos los clientes pasan.
 */
export function accountContextDescription(dashboardUrl: string): string {
  return [
    'Lists the organizations this PatrolTech account can access (names and ids), with the role in each, and their locations (names and ids). An organization not listed here is not accessible with this account.',
    'Call it first when unsure which organization or location a question is about; the other tools take the organization name.',
    'Do not use when you already know the organization and need operational data.',
    `The user can review or disconnect this connection in the PatrolTech dashboard (${dashboardUrl}): user menu, Connected apps ("Aplicaciones conectadas" in Spanish). No tool returns tokens or credentials.`,
  ].join(' ');
}

/** `patroltech_account_get_context`: el punto de entrada (organizaciones, roles y ubicaciones). */
export function registerAccountContextTool(
  server: McpServer,
  binding: ToolBinding,
  gateway: Pick<PatrolTechGateway, 'listLocations'>
): void {
  registerCapabilityTool(
    server,
    binding,
    {
      name: ACCOUNT_CONTEXT_TOOL,
      title: 'Account context',
      description: accountContextDescription(
        binding.runtime.urls.dashboard ?? DEFAULT_URLS.dashboard
      ),
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      operation: 'read',
      rateLimit: READ_RATE_LIMIT,
    },
    async (_args, call) => loadAccountContext(await call.session(), gateway)
  );
}
