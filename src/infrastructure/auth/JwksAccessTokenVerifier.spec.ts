import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  createTestIssuer,
  signHs256Token,
  unsignedToken,
  type TestIssuer,
} from '../../testing/oauthFixtures.js';
import { JwksAccessTokenVerifier } from './JwksAccessTokenVerifier.js';

let issuer: TestIssuer;
let verifier: JwksAccessTokenVerifier;

beforeAll(async () => {
  issuer = await createTestIssuer();
  verifier = new JwksAccessTokenVerifier({
    getKey: issuer.getKey,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
  });
});

async function expectInvalidToken(token: string): Promise<void> {
  const error = await verifier.verifyAccessToken(token).then(
    () => undefined,
    (err: unknown) => err
  );
  expect(error).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
}

describe('JwksAccessTokenVerifier', () => {
  it('maps a valid access token to the SDK AuthInfo', async () => {
    const token = await issuer.sign();

    const info = await verifier.verifyAccessToken(token);

    expect(info.token).toBe(token);
    expect(info.clientId).toBe('client-1');
    expect(info.scopes).toEqual(['read', 'write']);
    expect(info.resource?.href).toBe(TEST_AUDIENCE);
    expect(info.extra).toEqual({ userId: 'user-1', grantId: 'grant-1' });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('accepts a token whose aud is an array containing the resource', async () => {
    const token = await issuer.sign({ claims: { aud: ['https://other.example', TEST_AUDIENCE] } });

    await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({
      clientId: 'client-1',
    });
  });

  it.each([
    ['expired', () => issuer.sign({ expiresInSec: -60 })],
    ['wrong audience', () => issuer.sign({ claims: { aud: 'https://mcp.other.example/mcp' } })],
    ['wrong issuer', () => issuer.sign({ claims: { iss: 'https://evil.example' } })],
    ['unknown kid', () => issuer.sign({ kid: 'rotated-away' })],
    ['signature from a foreign key', () => issuer.signWithForeignKey()],
    ['HS256 token', () => signHs256Token()],
    ['alg none', () => Promise.resolve(unsignedToken())],
    ['not a JWT at all', () => Promise.resolve('not-a-jwt')],
    [
      'nbf in the future',
      () => issuer.sign({ claims: { nbf: Math.floor(Date.now() / 1000) + 600 } }),
    ],
    ['missing exp', () => issuer.sign({ omit: ['exp'] })],
    ['missing sub', () => issuer.sign({ omit: ['sub'] })],
    ['missing scope', () => issuer.sign({ omit: ['scope'] })],
    ['missing client_id (agent-session JWT shape)', () => issuer.sign({ omit: ['client_id'] })],
    ['missing grant_id', () => issuer.sign({ omit: ['grant_id'] })],
    ['missing aud', () => issuer.sign({ omit: ['aud'] })],
    ['empty scope', () => issuer.sign({ claims: { scope: '   ' } })],
    ['non-string scope', () => issuer.sign({ claims: { scope: ['read'] } })],
    ['non-string client_id', () => issuer.sign({ claims: { client_id: 42 } })],
    ['non-string grant_id', () => issuer.sign({ claims: { grant_id: { a: 1 } } })],
    ['non-string sub', () => issuer.sign({ claims: { sub: 7 } })],
  ])('rejects: %s', async (_name, buildToken) => {
    await expectInvalidToken(await buildToken());
  });

  it('does not echo the token in the error message', async () => {
    const token = await issuer.sign({ expiresInSec: -60 });

    const error = await verifier.verifyAccessToken(token).catch((err: unknown) => err);

    expect((error as Error).message).not.toContain(token);
  });

  it('requires either a JWKS URL or a key resolver', () => {
    expect(
      () => new JwksAccessTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE })
    ).toThrow();
  });

  describe('with a remote JWKS', () => {
    let jwksServer: Server;
    let jwksUrl: string;
    let hits = 0;

    beforeAll(async () => {
      jwksServer = createServer((_req, res) => {
        hits += 1;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(issuer.jwks));
      });
      await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
      jwksUrl = `http://127.0.0.1:${String((jwksServer.address() as AddressInfo).port)}/oauth/jwks.json`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => jwksServer.close(() => resolve()));
    });

    it('fetches the JWKS over HTTP and caches it between verifications', async () => {
      const remote = new JwksAccessTokenVerifier({
        jwksUrl,
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
      });

      await remote.verifyAccessToken(await issuer.sign());
      await remote.verifyAccessToken(await issuer.sign());

      expect(hits).toBe(1);
    });

    it('reports an unreachable JWKS as a server error, not as an invalid token', async () => {
      const unreachable = new JwksAccessTokenVerifier({
        jwksUrl: 'http://127.0.0.1:1/oauth/jwks.json',
        issuer: TEST_ISSUER,
        audience: TEST_AUDIENCE,
      });

      const error = await unreachable
        .verifyAccessToken(await issuer.sign())
        .catch((err: unknown) => err);

      expect(error).toBeInstanceOf(OAuthError);
      expect((error as OAuthError).code).toBe(OAuthErrorCode.ServerError);
    });
  });
});
