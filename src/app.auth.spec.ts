import type express from 'express';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Logger } from '@patroltech/agent-capabilities';
import { createApp } from './app.js';
import { loadConfig, type McpServerConfig } from './config.js';
import { AgentSessionExchanger } from './infrastructure/auth/AgentSessionExchanger.js';
import { JwksAccessTokenVerifier } from './infrastructure/auth/JwksAccessTokenVerifier.js';
import {
  TEST_AUDIENCE,
  TEST_ISSUER,
  createTestIssuer,
  signHs256Token,
  unsignedToken,
  type TestIssuer,
} from './testing/oauthFixtures.js';

function configFor(publicUrl: string): McpServerConfig {
  return loadConfig({
    PORT: '3110',
    MCP_PUBLIC_URL: publicUrl,
    API_BASE_URL: 'https://api.example.test',
    OAUTH_ISSUER: TEST_ISSUER,
    DASHBOARD_URL: 'https://dashboard.example.test',
    APP_BASE_URL: 'https://app.example.test',
    APP_ENVIRONMENT: 'test',
  });
}

const config = configFor(TEST_AUDIENCE);

const PRM_URL = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp';
const EXPECTED_PRM = {
  resource: 'https://mcp.example.test/mcp',
  authorization_servers: ['https://api.example.test'],
  scopes_supported: ['read', 'write'],
  bearer_methods_supported: ['header'],
};

let issuer: TestIssuer;
let logger: Logger;
let mcpHandler: ReturnType<typeof vi.fn<express.RequestHandler>>;
let backend: ReturnType<typeof vi.fn<typeof fetch>>;
let app: express.Express;

beforeAll(async () => {
  issuer = await createTestIssuer();
});

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
const AGENT_JWT = `${part({ alg: 'HS256' })}.${part({ id: 'user-1', roles: { organizationRoles: {}, orgWideRoles: {}, locationRoles: {} } })}.sig`;

function sessionResponse(): Response {
  return new Response(
    JSON.stringify({
      token: AGENT_JWT,
      expires_at: Math.floor(Date.now() / 1000) + 900,
      scope: 'read write',
      user_id: 'user-1',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function jwtVerifier(extra: { jwksUrl?: string } = {}): JwksAccessTokenVerifier {
  return new JwksAccessTokenVerifier({
    ...(extra.jwksUrl ? { jwksUrl: extra.jwksUrl } : { getKey: issuer.getKey }),
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    logger,
  });
}

function buildApp(
  verifier: OAuthTokenVerifier,
  appConfig: McpServerConfig = config
): express.Express {
  return createApp({
    config: appConfig,
    logger,
    checkReady: () => Promise.resolve(true),
    verifier,
    exchanger: new AgentSessionExchanger({
      apiBaseUrl: appConfig.apiBaseUrl,
      fetchImpl: backend,
    }),
    mcpHandler,
  });
}

beforeEach(() => {
  logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  backend = vi.fn<typeof fetch>(() => Promise.resolve(sessionResponse()));
  mcpHandler = vi.fn<express.RequestHandler>((req, res) => {
    res.status(200).json({
      ok: true,
      clientId: req.auth?.clientId,
      session: req.agentSession && {
        userId: req.agentSession.userId,
        scopes: req.agentSession.scopes,
        hasToken: req.agentSession.token === AGENT_JWT,
      },
    });
  });
  app = buildApp(jwtVerifier());
});

function loggedText(): string {
  return JSON.stringify(
    [logger.info, logger.warn, logger.error].map((fn) => vi.mocked(fn).mock.calls)
  );
}

function expectBearerChallenge(response: request.Response): void {
  expect(response.status).toBe(401);
  const challenge = String(response.headers['www-authenticate']);
  expect(challenge).toMatch(/^Bearer error="invalid_token"/);
  expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
  expect(challenge).toContain('scope="read write"');
  expect(mcpHandler).not.toHaveBeenCalled();
}

describe('protected resource metadata', () => {
  it.each(['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource'])(
    'GET %s serves the exact RFC 9728 document',
    async (path) => {
      const response = await request(app).get(path);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(EXPECTED_PRM);
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(response.headers['cache-control']).toBe('public, max-age=300');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    }
  );

  it('answers the CORS preflight, reflecting the requested headers', async () => {
    const response = await request(app)
      .options('/.well-known/oauth-protected-resource/mcp')
      .set('Origin', 'https://claude.ai')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'mcp-protocol-version');

    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('mcp-protocol-version');
    expect(response.headers.vary).toMatch(/Access-Control-Request-Headers/);
  });

  it('rejects non-GET methods', async () => {
    const response = await request(app).post('/.well-known/oauth-protected-resource/mcp');

    expect(response.status).toBe(405);
    expect(response.headers.allow).toMatch(/GET/);
  });

  it('does not answer for unknown sub-paths', async () => {
    const preflight = await request(app).options('/.well-known/oauth-protected-resource/other');
    const post = await request(app).post('/.well-known/oauth-protected-resource/other');

    expect(preflight.status).toBe(404);
    expect(post.status).toBe(404);
  });

  it('is public: no bearer token needed, no backend call', async () => {
    const response = await request(app).get('/.well-known/oauth-protected-resource/mcp');

    expect(response.status).toBe(200);
    expect(mcpHandler).not.toHaveBeenCalled();
    expect(backend).not.toHaveBeenCalled();
  });

  it('serves the URL advertised in the 401 challenge (it is derived from the public URL)', async () => {
    const response = await request(app).post('/mcp');
    const advertised = /resource_metadata="([^"]+)"/.exec(
      String(response.headers['www-authenticate'])
    );

    const metadata = await request(app).get(new URL(advertised?.[1] ?? '').pathname);

    expect(metadata.status).toBe(200);
  });

  it('follows the path of a public URL that is not /mcp', async () => {
    const custom = buildApp(jwtVerifier(), configFor('https://mcp.example.test/connector/mcp'));

    const prm = await request(custom).get('/.well-known/oauth-protected-resource/connector/mcp');
    const unauthenticated = await request(custom).post('/connector/mcp');

    expect(prm.status).toBe(200);
    expect(prm.body.resource).toBe('https://mcp.example.test/connector/mcp');
    expect(unauthenticated.status).toBe(401);
    expect(String(unauthenticated.headers['www-authenticate'])).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/connector/mcp"'
    );
  });
});

describe('/mcp bearer authentication', () => {
  it('lets a valid access token through and exposes AuthInfo to the handler', async () => {
    const token = await issuer.sign();

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.clientId).toBe('client-1');
    expect(mcpHandler).toHaveBeenCalledTimes(1);
  });

  it.each(['get', 'post', 'delete'] as const)('guards %s as well', async (method) => {
    expectBearerChallenge(await request(app)[method]('/mcp'));
  });

  it('answers 401 with the resource_metadata challenge when the token is missing', async () => {
    expectBearerChallenge(await request(app).post('/mcp'));
  });

  it('answers 401 for a non-bearer scheme', async () => {
    expectBearerChallenge(await request(app).post('/mcp').set('Authorization', 'Basic abc'));
  });

  it.each([
    ['expired', () => issuer.sign({ expiresInSec: -60 })],
    ['wrong audience', () => issuer.sign({ claims: { aud: 'https://mcp.other.example/mcp' } })],
    ['wrong issuer', () => issuer.sign({ claims: { iss: 'https://evil.example' } })],
    ['HS256', () => signHs256Token()],
    ['alg none', () => Promise.resolve(unsignedToken())],
    ['foreign signature', () => issuer.signWithForeignKey()],
    [
      'agent-session JWT shape (no aud / client_id)',
      () => issuer.sign({ omit: ['aud', 'client_id', 'grant_id'], claims: { via: 'mcp' } }),
    ],
  ])('answers 401 with the challenge for a %s token', async (_name, buildToken) => {
    const token = await buildToken();

    expectBearerChallenge(await request(app).post('/mcp').set('Authorization', `Bearer ${token}`));
    expect(backend).not.toHaveBeenCalled();
  });

  describe('access_token outside the Authorization header', () => {
    it('is refused in the query string without a header', async () => {
      const token = await issuer.sign();

      expectBearerChallenge(await request(app).post(`/mcp?access_token=${token}`));
    });

    it('is refused in the query string even with a valid header', async () => {
      const token = await issuer.sign();

      const response = await request(app)
        .post(`/mcp?access_token=${token}`)
        .set('Authorization', `Bearer ${token}`);

      expectBearerChallenge(response);
    });

    it('is refused as a top-level JSON body field even with a valid header', async () => {
      const token = await issuer.sign();

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({ access_token: token });

      expectBearerChallenge(response);
    });

    it('is refused as a top-level form body field even with a valid header', async () => {
      const token = await issuer.sign();

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .type('form')
        .send({ access_token: token });

      expectBearerChallenge(response);
    });

    it('is refused in a form body without a header (no header, so 401 regardless)', async () => {
      const token = await issuer.sign();

      const response = await request(app).post('/mcp').type('form').send({ access_token: token });

      expectBearerChallenge(response);
    });

    it('does not trip on an access_token buried inside JSON-RPC tool arguments', async () => {
      const token = await issuer.sign();

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'x', arguments: { access_token: 'user-supplied-text' } },
        });

      expect(response.status).toBe(200);
      expect(mcpHandler).toHaveBeenCalledTimes(1);
    });

    it('lets the handler read the already-parsed JSON-RPC body', async () => {
      const token = await issuer.sign();
      mcpHandler.mockImplementation((req, res) => {
        res.status(200).json({ method: (req.body as { method?: string }).method });
      });

      const response = await request(app)
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

      expect(response.body).toEqual({ method: 'tools/list' });
    });
  });

  it('answers 503 + Retry-After (not 401, not 500) when the JWKS cannot be reached', async () => {
    const token = await issuer.sign();
    const unreachable = buildApp(jwtVerifier({ jwksUrl: 'http://127.0.0.1:1/oauth/jwks.json' }));

    const response = await request(unreachable)
      .post('/mcp')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(token);
    expect(logger.error).toHaveBeenCalledWith('mcp.auth.jwks_unavailable', expect.anything());
    expect(loggedText()).not.toContain(token);
  });

  it('never logs the token when the verifier fails unexpectedly', async () => {
    const token = await issuer.sign();
    const exploding = buildApp({
      verifyAccessToken: (received) => Promise.reject(new Error(`boom ${received}`)),
    });

    const response = await request(exploding).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith('mcp.auth.unexpected_failure', expect.anything());
    expect(loggedText()).not.toContain(token);
    expect(JSON.stringify(response.body)).not.toContain(token);
  });

  it('keeps /health public', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
  });
});

describe('/mcp agent session', () => {
  it('hands the handler the agent session obtained with the access token', async () => {
    const token = await issuer.sign();

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.session).toEqual({
      userId: 'user-1',
      scopes: ['read', 'write'],
      hasToken: true,
    });
    expect(backend).toHaveBeenCalledTimes(1);
    const [url, init] = backend.mock.calls[0];
    expect(url).toBe('https://api.example.test/oauth/agent-session');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
  });

  it('exchanges once for several requests with the same token', async () => {
    const token = await issuer.sign();

    await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);
    await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(backend).toHaveBeenCalledTimes(1);
    expect(mcpHandler).toHaveBeenCalledTimes(2);
  });

  it('answers the invalid_token challenge when the backend rejects the token (revoked grant)', async () => {
    backend.mockResolvedValue(new Response('{"error":"invalid_token"}', { status: 401 }));
    const token = await issuer.sign();

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expectBearerChallenge(response);
    expect(response.body.error).toBe('invalid_token');
  });

  it.each([
    ['503', () => Promise.resolve(new Response('{}', { status: 503 }))],
    ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
    ['network error', () => Promise.reject(new TypeError('fetch failed'))],
  ])('answers 503 + Retry-After when the backend answers %s', async (_name, respond) => {
    backend.mockImplementation(respond);
    const token = await issuer.sign();

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(503);
    expect(response.headers['retry-after']).toBe('5');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.body).toEqual({ error: 'temporarily_unavailable' });
    expect(mcpHandler).not.toHaveBeenCalled();
    expect(loggedText()).not.toContain(token);
  });

  it('answers 429 with the backend Retry-After when the exchange is rate limited', async () => {
    backend.mockResolvedValue(
      new Response('{"error":"temporarily_unavailable"}', {
        status: 429,
        headers: { 'Retry-After': '30' },
      })
    );
    const token = await issuer.sign();

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.body).toEqual({ error: 'rate_limited' });
    expect(mcpHandler).not.toHaveBeenCalled();
  });

  it('answers 500 and never logs the token when the exchanger fails unexpectedly', async () => {
    const token = await issuer.sign();
    const broken = createApp({
      config,
      logger,
      checkReady: () => Promise.resolve(true),
      verifier: jwtVerifier(),
      exchanger: {
        exchange: (received) => Promise.reject(new Error(`unexpected ${received}`)),
        forget: () => undefined,
      },
      mcpHandler,
    });

    const response = await request(broken).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledWith(
      'mcp.auth.session_exchange_failed',
      expect.anything()
    );
    expect(loggedText()).not.toContain(token);
    expect(mcpHandler).not.toHaveBeenCalled();
  });
});

describe('error responses', () => {
  it('answers malformed JSON on /mcp with a JSON 400, not HTML', async () => {
    const response = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc": ');

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'invalid_request' });
    expect(response.text).not.toMatch(/SyntaxError|<html|\sat\s/i);
  });

  it('answers an oversize body with a JSON 413', async () => {
    const response = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ filler: 'x'.repeat(2 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'invalid_request' });
  });

  it('answers an unexpected handler error with a JSON 500 without stack or message', async () => {
    const token = await issuer.sign();
    mcpHandler.mockImplementation(() => {
      throw new Error(`database exploded for ${token}`);
    });

    const response = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'server_error' });
    expect(response.text).not.toMatch(/database exploded|Error:|\sat\s|<html/);
    expect(logger.error).toHaveBeenCalledWith(
      'mcp.unhandled_error',
      expect.objectContaining({ errorName: 'Error' })
    );
    expect(loggedText()).not.toContain(token);
  });

  it('answers an unknown path with a JSON 404', async () => {
    const response = await request(app).get('/nope');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toEqual({ error: 'not_found' });
  });

  it('answers an unknown sub-path of /mcp with a JSON 404 and no auth challenge', async () => {
    const response = await request(app).post('/mcp/other');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });
});
