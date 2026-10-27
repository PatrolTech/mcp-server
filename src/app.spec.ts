import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { APP_VERSION } from './version.js';
import type { Logger } from '@patroltech/agent-capabilities';

const config = loadConfig({
  PORT: '3110',
  MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
  API_BASE_URL: 'https://api.example.test',
  OAUTH_ISSUER: 'https://api.example.test',
  DASHBOARD_URL: 'https://dashboard.example.test',
  APP_BASE_URL: 'https://app.example.test',
  APP_ENVIRONMENT: 'test',
});

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function appWithReadiness(checkReady: () => Promise<boolean>, appConfig = config) {
  return createApp({
    config: appConfig,
    logger,
    checkReady,
    exchanger: { exchange: () => Promise.reject(new Error('not used')), forget: () => undefined },
    verifier: { verifyAccessToken: () => Promise.reject(new Error('not used')) },
    mcpHandler: (_req, res) => {
      res.sendStatus(204);
    },
  });
}

describe('health endpoints', () => {
  it('GET /health reports liveness with the version and no auth', async () => {
    const response = await request(appWithReadiness(() => Promise.resolve(true))).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok', version: APP_VERSION.version });
  });

  it('does not advertise the framework', async () => {
    const response = await request(appWithReadiness(() => Promise.resolve(true))).get('/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('GET /health/ready is 200 when the readiness check passes', async () => {
    const response = await request(appWithReadiness(() => Promise.resolve(true))).get(
      '/health/ready'
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ready' });
  });

  it('GET /health/ready is 503 when the readiness check fails', async () => {
    const response = await request(appWithReadiness(() => Promise.resolve(false))).get(
      '/health/ready'
    );

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
  });

  it('GET /health/ready is 503 (not a crash) when the readiness check throws', async () => {
    const response = await request(
      appWithReadiness(() => Promise.reject(new Error('jwks down')))
    ).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'not_ready' });
  });
});

describe('GET /.well-known/openai-apps-challenge', () => {
  const ready = () => Promise.resolve(true);

  it('serves exactly the configured token as plain text, uncached and without auth', async () => {
    const app = appWithReadiness(ready, { ...config, openAiAppsChallenge: 'abc123-Token_XYZ' });

    const response = await request(app)
      .get('/.well-known/openai-apps-challenge')
      .set('Host', 'crawler.openai.example')
      .set('Origin', 'https://openai.example');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['www-authenticate']).toBeUndefined();
    expect(response.text).toBe('abc123-Token_XYZ');
  });

  it('answers the common JSON 404 when no token is configured', async () => {
    const response = await request(appWithReadiness(ready)).get(
      '/.well-known/openai-apps-challenge'
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'not_found' });
  });
});
