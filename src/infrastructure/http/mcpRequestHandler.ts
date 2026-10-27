import { toNodeHandler, type FetchLikeMcpHandler } from '@modelcontextprotocol/node';
import type { Logger } from '@patroltech/agent-capabilities';
import type express from 'express';
import { withCallIdentity } from '../../interface/mcp/mcpRequest.js';
import { requestIdOf } from './requestId.js';

/**
 * Handler Express de `/mcp` tras la autenticación: pasa al handler MCP del SDK (sin estado) la
 * petición con su identidad en `authInfo.extra` (sesión de agente e id de petición) y el cuerpo
 * ya parseado. Sin lógica de negocio: solo adapta.
 */
export function createMcpRequestHandler(
  handler: FetchLikeMcpHandler,
  logger: Logger
): express.RequestHandler {
  const node = toNodeHandler(handler, {
    onerror: (error: Error) => {
      logger.error('mcp.handler_failed', { errorName: error.name, errorMessage: error.message });
    },
  });

  return (req, res, next) => {
    const { auth, agentSession } = req;
    if (!auth || !agentSession) {
      // La puerta de `/mcp` las pone siempre: si faltan, es un error de montaje.
      next(new Error('MCP handler mounted without the authentication gate'));
      return;
    }
    req.auth = withCallIdentity(auth, { agentSession, requestId: requestIdOf(res) });
    node(req, res, req.body).catch(next);
  };
}
