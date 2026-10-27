import type { ScopeChallengeHandler } from '@modelcontextprotocol/server';
import type { AuditTrail } from '../../application/ports/AuditTrail.js';
import { callIdentityOf } from './mcpRequest.js';

/** El conjunto completo que se pide al reautorizar: el cliente vuelve con lectura Y escritura. */
const CHALLENGE_SCOPES = ['read', 'write'] as const;

const WRITE_SCOPE = 'write';

/**
 * Reto de scope de una herramienta de escritura. Mira el scope EFECTIVO de la sesión de agente
 * (el backend lo recorta a la concesión al canjear, `AgentSession.scopes`) además del del access
 * token: una concesión reducida a `read` después de emitir el token recibe el reto (403
 * `insufficient_scope`) en vez de un 403 traducido desde dentro. Pide `read write` y deja la línea
 * de auditoría de la llamada rechazada (el SDK responde antes de que corra la herramienta).
 */
export function writeScopeChallenge(audit: AuditTrail, toolName: string): ScopeChallengeHandler {
  return ({ request, authInfo }) => {
    // Sin autenticación lo decide la puerta de `/mcp` (aquí nunca llega una así).
    if (!authInfo) return undefined;
    const identity = callIdentityOf(authInfo);
    const granted = identity?.agentSession.scopes ?? [];
    if (authInfo.scopes.includes(WRITE_SCOPE) && granted.includes(WRITE_SCOPE)) return undefined;

    const params = request.params as { arguments?: unknown } | undefined;
    audit.toolCall({
      userId: identity?.userId ?? 'unknown',
      clientId: authInfo.clientId,
      tool: toolName,
      args: params?.arguments ?? {},
      outcome: 'refused',
      errorKind: 'insufficient_scope',
      durationMs: 0,
      requestId: identity?.requestId ?? 'unknown',
    });
    return {
      scopes: CHALLENGE_SCOPES,
      errorDescription: 'This tool needs the write scope; authorize read and write again.',
    };
  };
}
