import type { AuthInfo } from '@modelcontextprotocol/server';
import type { AgentSession } from '../../domain/auth/AgentSession.js';

/**
 * Quién llama en ESTA petición HTTP: lo que la puerta de `/mcp` ya verificó (access token y
 * cliente OAuth), la sesión de agente canjeada para `/api` y el id de la petición. Viaja a la
 * factoría del servidor MCP dentro de `authInfo.extra` (lo único que el SDK le pasa por petición).
 */
export interface McpCallIdentity {
  /** Access token OAuth: solo para olvidar su sesión en caché; nunca va a `/api`. */
  accessToken: string;
  clientId: string;
  userId: string;
  requestId: string;
  agentSession: AgentSession;
}

const EXTRA_KEY = 'patroltech';

interface IdentityExtra {
  agentSession: AgentSession;
  requestId: string;
}

/** `authInfo` con la sesión de agente y el id de la petición, para la factoría MCP. */
export function withCallIdentity(authInfo: AuthInfo, extra: IdentityExtra): AuthInfo {
  return { ...authInfo, extra: { ...authInfo.extra, [EXTRA_KEY]: extra } };
}

function isIdentityExtra(value: unknown): value is IdentityExtra {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<IdentityExtra>;
  return (
    typeof candidate.requestId === 'string' && typeof candidate.agentSession?.token === 'string'
  );
}

/** La identidad de la llamada, o `undefined` si la petición no pasó por la puerta de `/mcp`. */
export function callIdentityOf(authInfo: AuthInfo | undefined): McpCallIdentity | undefined {
  const extra = authInfo?.extra?.[EXTRA_KEY];
  if (!authInfo || !isIdentityExtra(extra)) return undefined;
  return {
    accessToken: authInfo.token,
    clientId: authInfo.clientId,
    userId: extra.agentSession.userId,
    requestId: extra.requestId,
    agentSession: extra.agentSession,
  };
}
