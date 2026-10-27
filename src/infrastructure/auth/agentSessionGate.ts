import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import type { Logger } from '@patroltech/agent-capabilities';
import type express from 'express';
import type { AgentSessionProvider } from '../../application/ports/AgentSessionProvider.js';
import type { AgentSession } from '../../domain/auth/AgentSession.js';
import {
  AgentSessionRateLimitedError,
  AgentSessionRejectedError,
  AgentSessionUnavailableError,
} from '../../domain/auth/errors.js';
import {
  bearerTokenOf,
  redactedError,
  sendBearerError,
  sendTemporarilyUnavailable,
} from './bearerAuth.js';

declare module 'express-serve-static-core' {
  interface Request {
    /**
     * Sesión de agente (JWT para `/api`) del usuario autenticado. La puebla `createAgentSessionGate`
     * tras la puerta bearer: en un handler de `/mcp` siempre está presente.
     */
    agentSession?: AgentSession;
  }
}

export interface AgentSessionGateOptions {
  exchanger: AgentSessionProvider;
  publicUrl: string;
  logger: Logger;
}

/**
 * Canjea el access token ya verificado (`req.auth.token`) por la sesión de agente antes de
 * llegar al handler MCP. Una concesión revocada solo se detecta aquí (el JWT se valida en
 * local), así que el rechazo del backend debe salir como el mismo 401 `invalid_token` que un
 * token inválido, con lo que el cliente reautentica; el límite de canjes del backend es 429 con su
 * `Retry-After`, y un fallo transitorio, 503; los dos sin reto.
 */
export function createAgentSessionGate(options: AgentSessionGateOptions): express.RequestHandler {
  const { exchanger, publicUrl, logger } = options;

  return async (req, res, next) => {
    const accessToken = req.auth?.token;
    if (!accessToken) {
      await sendBearerError(
        res,
        new OAuthError(OAuthErrorCode.InvalidToken, 'Missing access token'),
        publicUrl
      );
      return;
    }

    try {
      req.agentSession = await exchanger.exchange(accessToken);
      next();
    } catch (error) {
      if (error instanceof AgentSessionRejectedError) {
        await sendBearerError(
          res,
          new OAuthError(
            OAuthErrorCode.InvalidToken,
            'The access token is invalid, expired or revoked'
          ),
          publicUrl
        );
        return;
      }
      if (error instanceof AgentSessionRateLimitedError) {
        // El límite del backend por concesión: 429 con su espera (no 503, no un reto).
        logger.warn('mcp.auth.session_exchange_rate_limited', {
          retryAfterSec: error.retryAfterSec,
        });
        res.set('Retry-After', String(error.retryAfterSec)).status(429).json({
          error: 'rate_limited',
        });
        return;
      }
      if (error instanceof AgentSessionUnavailableError) {
        logger.warn('mcp.auth.session_exchange_unavailable', { reason: error.message });
        sendTemporarilyUnavailable(res, { error: 'temporarily_unavailable' });
        return;
      }
      logger.error('mcp.auth.session_exchange_failed', redactedError(error, bearerTokenOf(req)));
      res.status(500).json({ error: 'server_error' });
    }
  };
}
