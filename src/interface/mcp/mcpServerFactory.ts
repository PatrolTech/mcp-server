import { McpServer, type McpRequestContext } from '@modelcontextprotocol/server';
import type { Catalog, PatrolTechGateway } from '@patroltech/agent-capabilities';
import { callIdentityOf } from './mcpRequest.js';
import { createSessionContextLoader } from '../../application/session/sessionContext.js';
import { registerAccountContextTool } from './tools/accountContextTool.js';
import { registerConfirmTools } from './tools/confirmTools.js';
import { registerProposeTools } from './tools/proposeTools.js';
import { registerQrSheetTool } from './tools/qrSheetTool.js';
import { registerReadTools } from './tools/readTools.js';
import type { ToolBinding, ToolRuntime } from './registerCapabilityTool.js';
import { proposableActions, type WriteToolDeps } from './tools/writeTools.js';

export interface McpServerFactoryDeps {
  runtime: ToolRuntime;
  /** El catálogo del canal `mcp` (`buildCatalog(..., { channel: 'mcp' })`). */
  catalog: Catalog;
  gateway: PatrolTechGateway;
  /** Almacén de propuestas, exclusión por clave y hoja de QR de las herramientas con scope `write`. */
  writes: WriteToolDeps;
  version: string;
}

const UNAUTHENTICATED = () => Promise.reject(new Error('Unauthenticated MCP request'));

/**
 * Factoría de `createMcpHandler`: un `McpServer` nuevo por petición HTTP (servidor sin estado),
 * con la identidad de esa petición (`authInfo.extra`). Registrar las herramientas no llama al
 * backend: el contexto de sesión se construye en la primera llamada a una herramienta.
 */
export function createMcpServerFactory(deps: McpServerFactoryDeps) {
  const proposable = proposableActions(deps.catalog.actions);
  return ({ authInfo }: McpRequestContext): McpServer => {
    const identity = callIdentityOf(authInfo);
    const binding: ToolBinding = {
      runtime: deps.runtime,
      identity,
      loadSession: identity
        ? createSessionContextLoader(identity.agentSession, deps.runtime.directory)
        : UNAUTHENTICATED,
    };
    const server = new McpServer({
      name: 'patroltech',
      title: 'PatrolTech',
      version: deps.version,
    });
    registerAccountContextTool(server, binding, deps.gateway);
    registerReadTools(server, binding, deps.catalog.reads);
    registerProposeTools(server, binding, deps.catalog.actions, proposable, deps.writes);
    registerConfirmTools(server, binding, proposable, deps.writes);
    registerQrSheetTool(server, binding, deps.writes);
    return server;
  };
}
