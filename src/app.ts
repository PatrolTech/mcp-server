import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Logger } from '@patroltech/agent-capabilities';
import express from 'express';
import type { McpServerConfig } from './config.js';
import type { AgentSessionProvider } from './application/ports/AgentSessionProvider.js';
import { createAgentSessionGate } from './infrastructure/auth/agentSessionGate.js';
import {
  bearerTokenOf,
  createBearerAuth,
  redactedError,
} from './infrastructure/auth/bearerAuth.js';
import {
  createProtectedResourceMetadataRouter,
  mcpEndpointPath,
} from './infrastructure/auth/protectedResourceMetadata.js';
import { mcpHostValidation } from './infrastructure/http/hostValidation.js';
import { createOpenAiAppsChallengeRouter } from './infrastructure/http/openAiAppsChallenge.js';
import { requestIdMiddleware } from './infrastructure/http/requestId.js';

const BODY_LIMIT = '1mb';

/** Estado 4xx que traen los errores de los parsers de Express (`http-errors`), si lo hay. */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
  const candidate = typeof status === 'number' ? status : statusCode;
  return typeof candidate === 'number' && candidate >= 400 && candidate < 500
    ? candidate
    : undefined;
}

export interface AppDeps {
  config: McpServerConfig;
  logger: Logger;
  /** Readiness: dependencias externas alcanzables (p. ej. el JWKS de la API). */
  checkReady: () => Promise<boolean>;
  /** Verifica los access tokens de `/mcp`. */
  verifier: OAuthTokenVerifier;
  /** Canjea el access token verificado por la sesión de agente (`req.agentSession`). */
  exchanger: AgentSessionProvider;
  /**
   * Atiende el protocolo MCP una vez autenticada la petición: `req.auth` (access token
   * verificado), `req.agentSession` (sesión para `/api`) y `req.body` (JSON ya parseado).
   */
  mcpHandler: express.RequestHandler;
}

/** Construye la app Express sin `listen`, para poder probarla con supertest. */
export function createApp(deps: AppDeps): express.Express {
  const { config, logger, checkReady, verifier, exchanger, mcpHandler } = deps;
  const app = express();

  app.disable('x-powered-by');
  // Detrás de un proxy inverso: un único salto.
  app.set('trust proxy', 1);

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', version: config.version });
  });

  app.get('/health/ready', async (_req, res) => {
    const ready = await checkReady().catch((err: unknown) => {
      logger.warn('mcp.ready_check_failed', { err });
      return false;
    });
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready' });
  });

  app.use(createProtectedResourceMetadataRouter(config));
  app.use(createOpenAiAppsChallengeRouter(config.openAiAppsChallenge));

  // Todos los métodos: el transporte MCP usa POST, GET (flujo SSE) y DELETE.
  // Orden: id de petición → validación del Host y del Origin → parsers de cuerpo → puerta bearer
  // (que rechaza `access_token` fuera de la cabecera) → canje de la sesión de agente → handler MCP.
  // Origin: sin cabecera se pasa (los clientes MCP remotos llaman desde sus servidores); con una,
  // 403 antes de autenticar (sin CORS, un navegador no podría usar `/mcp` de todos modos).
  app.all(
    mcpEndpointPath(config),
    requestIdMiddleware(),
    mcpHostValidation({ publicUrl: config.publicUrl }),
    express.json({ limit: BODY_LIMIT }),
    express.urlencoded({ extended: false, limit: BODY_LIMIT }),
    createBearerAuth({ verifier, publicUrl: config.publicUrl, logger }),
    createAgentSessionGate({ exchanger, publicUrl: config.publicUrl, logger }),
    mcpHandler
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Último middleware (4 argumentos): nunca HTML ni trazas, con o sin NODE_ENV.
  app.use(
    (error: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const status = clientErrorStatus(error);
      if (status !== undefined) {
        res.status(status).json({ error: 'invalid_request' });
        return;
      }
      logger.error('mcp.unhandled_error', redactedError(error, bearerTokenOf(req)));
      res.status(500).json({ error: 'server_error' });
    }
  );

  return app;
}
