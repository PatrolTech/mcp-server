import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server';
import type { Logger } from '@patroltech/agent-capabilities';
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface JwksAccessTokenVerifierOptions {
  /** JWKS remoto de la API (`/oauth/jwks.json`). Alternativa a `getKey`. */
  jwksUrl?: string | URL;
  /** Resolutor de claves ya construido (tests). Alternativa a `jwksUrl`. */
  getKey?: JWTVerifyGetKey;
  /** `iss` esperado, tal cual. */
  issuer: string;
  /** Recurso de este servidor (URL pública exacta): debe figurar en `aud`. */
  audience: string;
  /** Para registrar fallos de infraestructura (JWKS inalcanzable). Nunca recibe el token. */
  logger?: Logger;
}

const REQUIRED_CLAIMS = ['exp', 'sub', 'scope', 'client_id', 'grant_id'];

/** Fallos del propio token (frente a fallos de infraestructura como un JWKS inalcanzable). */
const TOKEN_ERRORS = [
  errors.JWTExpired,
  errors.JWTClaimValidationFailed,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

function invalidToken(message: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, message);
}

function requiredString(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidToken(`Invalid ${claim} claim`);
  }
  return value;
}

/**
 * Verifica localmente los access tokens que emite nuestro servidor de autorización
 * (JWT ES256 firmados con la clave publicada en el JWKS de la API).
 */
export class JwksAccessTokenVerifier implements OAuthTokenVerifier {
  private readonly getKey: JWTVerifyGetKey;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly resource: URL;
  private readonly logger?: Logger;

  constructor(options: JwksAccessTokenVerifierOptions) {
    if (!options.getKey && !options.jwksUrl) {
      throw new Error('JwksAccessTokenVerifier needs a jwksUrl or a getKey');
    }
    this.getKey = options.getKey ?? createRemoteJWKSet(new URL(options.jwksUrl!));
    this.issuer = options.issuer;
    this.audience = options.audience;
    this.resource = new URL(options.audience);
    this.logger = options.logger;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const payload = await this.verifySignedClaims(token);

    const scopes = requiredString(payload, 'scope').split(/\s+/).filter(Boolean);
    if (scopes.length === 0) {
      throw invalidToken('Empty scope claim');
    }
    if (typeof payload.exp !== 'number') {
      throw invalidToken('Invalid exp claim');
    }

    return {
      token,
      clientId: requiredString(payload, 'client_id'),
      scopes,
      expiresAt: payload.exp,
      resource: this.resource,
      extra: {
        userId: requiredString(payload, 'sub'),
        grantId: requiredString(payload, 'grant_id'),
      },
    };
  }

  private async verifySignedClaims(token: string): Promise<JWTPayload> {
    try {
      // `audience` de jose es la comprobación RFC 8707 que manda (ver el test "wrong audience");
      // `AuthInfo.resource` solo la refleja para el SDK y los retos de scope.
      const { payload } = await jwtVerify(token, this.getKey, {
        algorithms: ['ES256'],
        issuer: this.issuer,
        audience: this.audience,
        requiredClaims: REQUIRED_CLAIMS,
      });
      return payload;
    } catch (err) {
      if (TOKEN_ERRORS.some((tokenError) => err instanceof tokenError)) {
        // Mensaje fijo: el de jose puede citar claims del token.
        throw invalidToken('The access token is invalid or expired');
      }
      // JWKS inalcanzable o ilegible, etc.: no es culpa del cliente.
      this.logger?.error('mcp.auth.jwks_unavailable', { err });
      throw new OAuthError(OAuthErrorCode.ServerError, 'Unable to verify the access token');
    }
  }
}
