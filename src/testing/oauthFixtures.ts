import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from 'jose';

export const TEST_ISSUER = 'https://api.example.test';
export const TEST_AUDIENCE = 'https://mcp.example.test/mcp';
export const TEST_KID = 'test-key-1';

export interface SignOptions {
  /** Claims que pisan o añaden a los de un access token válido. */
  claims?: Record<string, unknown>;
  /** Claims que se eliminan del token. */
  omit?: string[];
  /** Segundos de vida desde ahora (negativo ⇒ ya caducado). */
  expiresInSec?: number;
  /** Por defecto, la clave de confianza del JWKS de pruebas. */
  keyPair?: { privateKey: CryptoKey };
  kid?: string;
}

export interface TestIssuer {
  /** Resolutor de claves equivalente a un JWKS con la clave pública del emisor de pruebas. */
  getKey: JWTVerifyGetKey;
  jwks: { keys: JWK[] };
  /** Access token ES256 válido (salvo lo que se altere en `options`). */
  sign(options?: SignOptions): Promise<string>;
  /** Firma con una clave ajena al JWKS pero con el mismo `kid`. */
  signWithForeignKey(): Promise<string>;
}

function validPayload(expiresInSec: number): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: TEST_ISSUER,
    sub: 'user-1',
    aud: TEST_AUDIENCE,
    scope: 'read write',
    client_id: 'client-1',
    grant_id: 'grant-1',
    jti: 'jti-1',
    iat: now,
    exp: now + expiresInSec,
  };
}

export async function createTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: TEST_KID,
    alg: 'ES256',
    use: 'sig',
  };
  const jwks = { keys: [publicJwk] };

  async function sign(options: SignOptions = {}): Promise<string> {
    const payload = { ...validPayload(options.expiresInSec ?? 3600), ...options.claims };
    for (const claim of options.omit ?? []) {
      delete payload[claim];
    }
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? TEST_KID })
      .sign((options.keyPair ?? { privateKey }).privateKey);
  }

  return {
    getKey: createLocalJWKSet(jwks),
    jwks,
    sign,
    async signWithForeignKey() {
      const foreign = await generateKeyPair('ES256');
      return sign({ keyPair: foreign });
    },
  };
}

/** Token firmado con HS256 usando un secreto cualquiera. */
export function signHs256Token(claims: Record<string, unknown> = {}): Promise<string> {
  return new SignJWT({ ...validPayload(3600), ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
}

const base64Url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Token `alg: none` (sin firma) con claims válidos. */
export function unsignedToken(claims: Record<string, unknown> = {}): string {
  return `${base64Url({ alg: 'none', typ: 'JWT' })}.${base64Url({ ...validPayload(3600), ...claims })}.`;
}
