import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { APP_VERSION } from './version.js';

const validEnv = {
  PORT: '3110',
  MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
  API_BASE_URL: 'https://api.example.test',
  OAUTH_ISSUER: 'https://api.example.test',
  DASHBOARD_URL: 'https://dashboard.example.test',
  APP_BASE_URL: 'https://app.example.test',
  APP_ENVIRONMENT: 'production',
  REDIS_URL: 'redis://127.0.0.1:6379',
} satisfies NodeJS.ProcessEnv;

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig(validEnv);

    expect(config).toMatchObject({
      port: 3110,
      publicUrl: 'https://mcp.example.test/mcp',
      apiBaseUrl: 'https://api.example.test',
      oauthIssuer: 'https://api.example.test',
      jwksUrl: 'https://api.example.test/oauth/jwks.json',
      dashboardUrl: 'https://dashboard.example.test',
      appBaseUrl: 'https://app.example.test',
      environment: 'production',
      logLevel: 'info',
      serviceName: 'mcp-server',
      redisNamespace: 'production',
      version: APP_VERSION.version,
    });
    expect(config.host).toBe('127.0.0.1');
    expect(config).not.toHaveProperty('allowedOrigins');
  });

  it('reads SERVICE_NAME, the service name of every log line', () => {
    expect(loadConfig({ ...validEnv, SERVICE_NAME: 'acme-mcp' }).serviceName).toBe('acme-mcp');
    expect(() => loadConfig({ ...validEnv, SERVICE_NAME: 'two words' })).toThrow(/SERVICE_NAME/);
  });

  it('reads HOST, the local interface to listen on (127.0.0.1 by default)', () => {
    expect(loadConfig({ ...validEnv, HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
    expect(loadConfig({ ...validEnv, HOST: '::1' }).host).toBe('::1');
    expect(() => loadConfig({ ...validEnv, HOST: 'http://localhost' })).toThrow(/HOST/);
  });

  it('requires REDIS_URL in production and staging (proposals need the shared lock)', () => {
    const { REDIS_URL: _omitted, ...withoutRedis } = validEnv;
    for (const environment of ['production', 'staging']) {
      expect(() => loadConfig({ ...withoutRedis, APP_ENVIRONMENT: environment })).toThrow(
        /REDIS_URL: required when APP_ENVIRONMENT is production or staging/
      );
    }
    for (const environment of ['development', 'test']) {
      expect(
        loadConfig({ ...withoutRedis, APP_ENVIRONMENT: environment }).redisUrl
      ).toBeUndefined();
    }
  });

  it('strips trailing slashes from the URLs', () => {
    const config = loadConfig({
      ...validEnv,
      MCP_PUBLIC_URL: 'https://mcp.example.test/mcp/',
      API_BASE_URL: 'https://api.example.test/',
      DASHBOARD_URL: 'https://dashboard.example.test/',
    });

    expect(config.publicUrl).toBe('https://mcp.example.test/mcp');
    expect(config.apiBaseUrl).toBe('https://api.example.test');
    expect(config.jwksUrl).toBe('https://api.example.test/oauth/jwks.json');
    expect(config.dashboardUrl).toBe('https://dashboard.example.test');
  });

  it('honours an explicit OAUTH_JWKS_URL', () => {
    const config = loadConfig({
      ...validEnv,
      OAUTH_JWKS_URL: 'https://keys.example.com/jwks.json',
    });

    expect(config.jwksUrl).toBe('https://keys.example.com/jwks.json');
  });

  it('prefers REDIS_NAMESPACE over APP_ENVIRONMENT for the namespace', () => {
    expect(loadConfig({ ...validEnv, REDIS_NAMESPACE: 'shared' }).redisNamespace).toBe('shared');
    expect(loadConfig({ ...validEnv, APP_ENVIRONMENT: 'staging' }).redisNamespace).toBe('staging');
  });

  it('reads the optional Redis URL and log level', () => {
    const config = loadConfig({
      ...validEnv,
      REDIS_URL: 'redis://127.0.0.1:6379',
      LOG_LEVEL: 'debug',
    });

    expect(config.redisUrl).toBe('redis://127.0.0.1:6379');
    expect(config.logLevel).toBe('debug');
  });

  it('fails listing every missing or invalid variable', () => {
    let message = '';
    try {
      loadConfig({ PORT: 'abc', APP_ENVIRONMENT: 'moon' });
    } catch (error) {
      message = (error as Error).message;
    }

    for (const name of [
      'PORT',
      'MCP_PUBLIC_URL',
      'API_BASE_URL',
      'OAUTH_ISSUER',
      'DASHBOARD_URL',
      'APP_BASE_URL',
      'APP_ENVIRONMENT',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('rejects values that are not absolute URLs', () => {
    expect(() => loadConfig({ ...validEnv, API_BASE_URL: 'api.example.test' })).toThrow(
      /API_BASE_URL/
    );
  });

  it('rejects an OAUTH_ISSUER that is not an absolute URL', () => {
    expect(() => loadConfig({ ...validEnv, OAUTH_ISSUER: 'api.example.test' })).toThrow(
      /OAUTH_ISSUER/
    );
  });

  it('reads the optional OPENAI_APPS_CHALLENGE, trimmed', () => {
    expect(loadConfig(validEnv).openAiAppsChallenge).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, OPENAI_APPS_CHALLENGE: '  abc123-Token_XYZ \n' })
        .openAiAppsChallenge
    ).toBe('abc123-Token_XYZ');
  });

  it('rejects an OPENAI_APPS_CHALLENGE that is blank, too long or not printable ASCII', () => {
    for (const value of ['   ', 'two words', 'tab\tinside', 'ñandú', 'x'.repeat(513)]) {
      expect(() => loadConfig({ ...validEnv, OPENAI_APPS_CHALLENGE: value })).toThrow(
        /OPENAI_APPS_CHALLENGE/
      );
    }
    expect(
      loadConfig({ ...validEnv, OPENAI_APPS_CHALLENGE: 'x'.repeat(512) }).openAiAppsChallenge
    ).toHaveLength(512);
  });

  it('keeps OAUTH_ISSUER byte for byte, trailing slash included', () => {
    const config = loadConfig({ ...validEnv, OAUTH_ISSUER: 'https://api.example.test/' });

    expect(config.oauthIssuer).toBe('https://api.example.test/');
  });
});
