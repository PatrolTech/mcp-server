import {
  OAuthError,
  OAuthErrorCode,
  bearerAuthChallengeResponse,
  verifyBearerToken,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from '@patroltech/agent-capabilities';
import type express from 'express';
import { SUPPORTED_SCOPES, protectedResourceMetadataUrl } from './protectedResourceMetadata.js';

// Declaración propia de `req.auth`: el paquete de Express del SDK la aumenta sobre su copia de los
// tipos de Express, que no tiene por qué ser la de este paquete.
declare module 'express-serve-static-core' {
  interface Request {
    /** Información del access token validado por la puerta de `/mcp`. */
    auth?: AuthInfo;
  }
}

export interface BearerAuthOptions {
  verifier: OAuthTokenVerifier;
  /** URL pública exacta del recurso (audience de los tokens). */
  publicUrl: string;
  logger: Logger;
}

const TOKEN_PARAMETER = 'access_token';
const RETRY_AFTER_SEC = '5';
const SERVER_ERROR_CODE: string = OAuthErrorCode.ServerError;

/** Opciones del reto `WWW-Authenticate`: anuncia los dos scopes sin exigirlos a todos los tokens. */
export function bearerChallengeOptions(publicUrl: string) {
  return {
    requiredScopes: [...SUPPORTED_SCOPES],
    resourceMetadataUrl: protectedResourceMetadataUrl({ publicUrl }),
  };
}

/** Responde con el reto 401/403 del SDK (cabecera `WWW-Authenticate` incluida). */
export async function sendBearerError(
  res: express.Response,
  error: unknown,
  publicUrl: string
): Promise<void> {
  const response = bearerAuthChallengeResponse(error, bearerChallengeOptions(publicUrl));
  const challenge = response.headers.get('WWW-Authenticate');
  if (challenge !== null) {
    res.set('WWW-Authenticate', challenge);
  }
  res.status(response.status).json(await response.json());
}

/** Fallo temporal de una dependencia: el cliente puede reintentar, no debe reautenticarse. */
export function sendTemporarilyUnavailable(res: express.Response, body: object): void {
  res.set('Retry-After', RETRY_AFTER_SEC).status(503).json(body);
}

/** Token de la cabecera `Authorization`, solo para poder censurarlo en mensajes de error. */
export function bearerTokenOf(req: express.Request): string | undefined {
  const token = req.headers.authorization?.split(' ')[1];
  return token === '' ? undefined : token;
}

/** Datos seguros para loguear un error inesperado: nunca el token que pudiera citar el mensaje. */
export function redactedError(error: unknown, token: string | undefined): Record<string, string> {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: token ? message.replaceAll(token, '[redacted]') : message,
  };
}

/**
 * RFC 6750 §2: los tokens solo se aceptan por cabecera. Se rechaza `access_token` como
 * parámetro de la query o como campo de primer nivel del cuerpo (JSON o formulario ya
 * parseado); un `access_token` dentro de los parámetros JSON-RPC es contenido de usuario.
 */
function carriesTokenOutsideHeader(req: express.Request): boolean {
  const body: unknown = req.body;
  const bodyHasToken = typeof body === 'object' && body !== null && TOKEN_PARAMETER in body;
  return TOKEN_PARAMETER in req.query || bodyHasToken;
}

/**
 * Puerta de autenticación de `/mcp`. Compone los bloques del SDK (`verifyBearerToken` +
 * `bearerAuthChallengeResponse`) en lugar de `requireBearerAuth` para que el reto 401
 * anuncie `scope="read write"` sin exigir esos scopes: cada herramienta de escritura
 * comprueba el suyo más adelante. Debe montarse después de los parsers de cuerpo.
 */
export function createBearerAuth(options: BearerAuthOptions): express.RequestHandler {
  const { verifier, publicUrl, logger } = options;
  const verifyOptions = {
    verifier,
    requiredScopes: [],
    resourceMetadataUrl: protectedResourceMetadataUrl({ publicUrl }),
    expectedResource: new URL(publicUrl),
  };

  return async (req, res, next) => {
    try {
      if (carriesTokenOutsideHeader(req)) {
        throw new OAuthError(
          OAuthErrorCode.InvalidToken,
          'Access tokens must be sent only in the Authorization header'
        );
      }
      req.auth = await verifyBearerToken(req.headers.authorization, verifyOptions);
      next();
    } catch (error) {
      if (error instanceof OAuthError && error.code === SERVER_ERROR_CODE) {
        // Dependencia caída (JWKS): 401 haría que el cliente reiniciase OAuth sin necesidad.
        sendTemporarilyUnavailable(res, error.toResponseObject());
        return;
      }
      if (!(error instanceof OAuthError)) {
        logger.error('mcp.auth.unexpected_failure', redactedError(error, bearerTokenOf(req)));
      }
      await sendBearerError(res, error, publicUrl);
    }
  };
}
