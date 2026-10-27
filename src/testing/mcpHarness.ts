import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Logger } from '@patroltech/agent-capabilities';
import { vi, type Mock } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig, type McpServerConfig } from '../config.js';
import type { KeyedLock } from '../application/ports/KeyedLock.js';
import type { RateLimiter } from '../application/ports/RateLimiter.js';
import { AgentSessionExchanger } from '../infrastructure/auth/AgentSessionExchanger.js';
import { JwksAccessTokenVerifier } from '../infrastructure/auth/JwksAccessTokenVerifier.js';
import type { ServiceLogger } from '../infrastructure/logging/logger.js';
import { MemoryKeyedLock } from '../infrastructure/locks/MemoryKeyedLock.js';
import { MemoryRateLimiter } from '../infrastructure/rate-limit/MemoryRateLimiter.js';
import { createMcpService } from '../mcpService.js';
import { FakeAgentProposals, type ProposalOwner } from './fakeAgentProposals.js';
import { TEST_AUDIENCE, TEST_ISSUER, type TestIssuer } from './oauthFixtures.js';

export const API_BASE = 'https://api.example.test';

/** Configuración de pruebas, con las variables extra que pida cada test. */
export function testConfigWith(extra: NodeJS.ProcessEnv = {}): McpServerConfig {
  return loadConfig({
    PORT: '3110',
    MCP_PUBLIC_URL: TEST_AUDIENCE,
    API_BASE_URL: API_BASE,
    OAUTH_ISSUER: TEST_ISSUER,
    DASHBOARD_URL: 'https://dashboard.example.test',
    APP_BASE_URL: 'https://app.example.test',
    APP_ENVIRONMENT: 'test',
    ...extra,
  });
}

export const testConfig: McpServerConfig = testConfigWith();

export interface RoleSet {
  organizationRoles: Record<string, string>;
  orgWideRoles: Record<string, string>;
  locationRoles: Record<string, string>;
}

export const ONE_ORG: RoleSet = {
  organizationRoles: { 'org-a': 'ADMIN' },
  orgWideRoles: { 'org-a': 'ADMIN' },
  locationRoles: {},
};

export const TWO_ORGS: RoleSet = {
  organizationRoles: { 'org-a': 'ADMIN', 'org-b': 'EDITOR' },
  orgWideRoles: { 'org-a': 'ADMIN' },
  locationRoles: { 'loc-b1': 'EDITOR' },
};

/** Solo `org-c`, de otro usuario: nada en común con `ONE_ORG` ni con `TWO_ORGS`. */
export const OTHER_USER_ORG: RoleSet = {
  organizationRoles: { 'org-c': 'VIEWER' },
  orgWideRoles: { 'org-c': 'VIEWER' },
  locationRoles: {},
};

const ORG_NAMES: Record<string, string> = {
  'org-a': 'Acme Seguridad',
  'org-b': 'Beta Vigilancia',
  'org-c': 'Cobalto Proteccion',
};

const jwtPart = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** JWT de sesión de agente (sin firma válida: el MCP solo lee sus claims). */
export function agentSessionJwt(roles: RoleSet, userId = 'user-1', clientId = 'client-1'): string {
  return `${jwtPart({ alg: 'HS256', typ: 'JWT' })}.${jwtPart({ id: userId, via: 'mcp', clientId, roles })}.agent-signature`;
}

/** `sub`, `client_id` y `scope` del access token (sin verificar: ya lo verificó la puerta de `/mcp`). */
function accessTokenSubject(authorization: string | null): {
  sub: string;
  clientId: string;
  scope: string;
} {
  const payload = (authorization ?? '').replace(/^Bearer /, '').split('.')[1] ?? '';
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: string;
      client_id?: string;
      scope?: string;
    };
    return {
      sub: claims.sub ?? 'user-1',
      clientId: claims.client_id ?? 'client-1',
      scope: claims.scope ?? 'read write',
    };
  } catch {
    return { sub: 'user-1', clientId: 'client-1', scope: 'read write' };
  }
}

export interface BackendCall {
  method: string;
  url: URL;
  headers: Headers;
}

export interface FakeLocation {
  id: string;
  name: string;
  address: string;
}

/** Dueño de una llamada a `/api` según el JWT de sesión de agente (`id` + `clientId`). */
function agentOwner(authorization: string | null): ProposalOwner {
  const payload = (authorization ?? '').replace(/^Bearer /, '').split('.')[1] ?? '';
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id?: string;
      clientId?: string;
    };
    return { userId: claims.id ?? 'anonymous', clientId: claims.clientId ?? null };
  } catch {
    return { userId: 'anonymous', clientId: null };
  }
}

type Respond = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const envelope = (data: unknown) => ({ success: true, data });

export interface IncidentFixture {
  id: string;
  title: string;
}

export function incidentsResponse(incidents: IncidentFixture[]): Response {
  return json(
    200,
    envelope({
      results: incidents.map((i) => ({
        id: i.id,
        title: i.title,
        status: 'OPEN',
        priority: 'HIGH',
        locationId: null,
        assignedToUserId: null,
        assignedToName: null,
        createdAt: '2026-10-20T10:00:00.000Z',
        redacted: false,
      })),
      total: incidents.length,
    })
  );
}

/** Backend falso: canje de sesión, organizaciones, preferencias y lo que cada test añada. */
export class FakeBackend {
  readonly calls: BackendCall[] = [];
  /** `/api/agent-proposals` en memoria (su estado se puede mirar sin pasar por el MCP). */
  readonly proposals = new FakeAgentProposals();
  /** Ubicaciones por organización (las cambia `PUT /api/locations/:id`). */
  readonly locations = new Map<string, FakeLocation[]>();
  /** Sesión de agente de `user-1` (el usuario por defecto de los access tokens de prueba). */
  agentToken: string;
  /**
   * Scope de la concesión: el backend recorta el del access token a él (`effectiveScope`). Sin
   * valor, el del access token tal cual.
   */
  grantScope: string | undefined;
  preferredLanguage: string | null = 'en';
  /** Latencia de cada respuesta de `/api` (ms), para entrelazar llamadas concurrentes. */
  apiDelayMs: () => number = () => 0;
  private readonly routes = new Map<string, Respond>();
  private readonly patterns: { method: string; pattern: RegExp; respond: Respond }[] = [];
  private readonly rolesByUser = new Map<string, RoleSet>();

  constructor(roles: RoleSet = ONE_ORG) {
    this.rolesByUser.set('user-1', roles);
    this.agentToken = agentSessionJwt(roles);
    this.on('POST', '/oauth/agent-session', (_url, init) => {
      const { sub, clientId, scope } = accessTokenSubject(
        new Headers(init?.headers).get('authorization')
      );
      return json(200, {
        token: this.agentTokenFor(sub, clientId),
        expires_at: Math.floor(Date.now() / 1000) + 900,
        scope: this.grantScope ?? scope,
        user_id: sub,
      });
    });
    this.on('GET', '/api/organizations/list', () =>
      json(
        200,
        envelope(
          Object.fromEntries(
            Object.entries(ORG_NAMES).map(([id, name]) => [
              id,
              { id, name, type: 'security', identifier: id },
            ])
          )
        )
      )
    );
    this.on('GET', '/api/auth/user/preferences', () =>
      json(
        200,
        envelope({
          preferredLanguage: this.preferredLanguage,
          preferredTimezone: 'Europe/Madrid',
          notificationPreferences: null,
        })
      )
    );
    this.on('GET', '/api/features/incident-reporting/incidents', () =>
      incidentsResponse([
        { id: 'inc-1', title: 'Puerta trasera abierta' },
        { id: 'inc-2', title: 'Luz fundida en el parking' },
      ])
    );
    this.on('GET', '/api/locations', (url) =>
      json(200, envelope(this.locationsOf(url.searchParams.get('organizationId') ?? 'x')))
    );
    this.onMatch('PUT', /^\/api\/locations\/[^/]+$/, (url, init) => {
      const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
      const location = [...this.locations.values()].flat().find((l) => l.id === id);
      if (!location) return json(404, { success: false, message: 'Location not found' });
      const changes = JSON.parse(
        typeof init?.body === 'string' ? init.body : '{}'
      ) as Partial<FakeLocation>;
      Object.assign(location, changes);
      return json(200, envelope(location));
    });
    this.onMatch('POST', /^\/api\/locations\/[^/]+\/qr-sheet$/, () =>
      json(
        200,
        envelope({
          url: `${API_BASE}/api/qr-sheets/signed-token`,
          expiresAt: '2026-10-25T13:00:00.000Z',
          checkpointCount: 3,
          pageCount: 1,
        })
      )
    );
  }

  /** Las ubicaciones de la organización (por defecto, una: `<orgId>-loc-1` «Sede central»). */
  locationsOf(orgId: string): FakeLocation[] {
    let list = this.locations.get(orgId);
    if (!list) {
      list = [{ id: `${orgId}-loc-1`, name: 'Sede central', address: 'Calle Mayor 1' }];
      this.locations.set(orgId, list);
    }
    return list;
  }

  /** Da de alta otro usuario con sus roles (su access token lleva `sub: userId`). */
  addUser(userId: string, roles: RoleSet): void {
    this.rolesByUser.set(userId, roles);
  }

  /** La sesión de agente que el backend emite para `userId` con `clientId`. */
  agentTokenFor(userId: string, clientId: string): string {
    return userId === 'user-1'
      ? this.agentToken
      : agentSessionJwt(this.rolesByUser.get(userId) ?? ONE_ORG, userId, clientId);
  }

  /** Sustituye la respuesta de `method path`. */
  on(method: string, path: string, respond: Respond): void {
    this.routes.set(`${method} ${path}`, respond);
  }

  /** Respuesta de `method` para las rutas que casan con `pattern` (las exactas de `on` mandan). */
  onMatch(method: string, pattern: RegExp, respond: Respond): void {
    this.patterns.unshift({ method, pattern, respond });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    this.calls.push({ method: request.method, url, headers: request.headers });
    const respond = this.routes.get(`${request.method} ${url.pathname}`);
    if (url.pathname.startsWith('/api/')) {
      const delay = this.apiDelayMs();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    }
    if (respond) return respond(url, init);
    if (this.proposals.handles(url.pathname)) {
      const text = await request.text();
      const body: unknown = text ? JSON.parse(text) : undefined;
      return this.proposals.handle(
        request.method,
        url,
        body,
        agentOwner(request.headers.get('authorization'))
      );
    }
    const matched = this.patterns.find(
      (p) => p.method === request.method && p.pattern.test(url.pathname)
    );
    if (matched) return matched.respond(url, init);
    return json(404, { success: false, message: 'Not found' });
  };

  apiCalls(path?: string, method?: string): BackendCall[] {
    return this.calls.filter(
      (c) =>
        c.url.pathname.startsWith('/api/') &&
        (!path || c.url.pathname === path) &&
        (!method || c.method === method)
    );
  }
}

export interface HarnessOptions {
  backend?: FakeBackend;
  rateLimiter?: RateLimiter;
  backendTimeoutMs?: number;
  /**
   * Exclusión de las propuestas. Por defecto, en memoria; un cerrojo que no excluye nada deja que
   * sea el reclamo atómico del backend quien evite las dobles ejecuciones.
   */
  proposalLock?: KeyedLock;
  /** Variables de entorno extra. */
  env?: NodeJS.ProcessEnv;
}

/** Espías del logger de la app, accesibles sin desligar métodos. */
export interface LogSpies {
  info: Mock<Logger['info']>;
  warn: Mock<Logger['warn']>;
  error: Mock<Logger['error']>;
  /** El canal sin filtro de nivel (auditoría y latido). */
  always: Mock<ServiceLogger['always']>;
}

export interface McpHarness {
  url: string;
  backend: FakeBackend;
  logs: LogSpies;
  exchanger: AgentSessionExchanger;
  accessToken: string;
  /** Un access token válido de otro usuario/cliente (por defecto con `read write`). */
  signAccessToken(sub: string, clientId: string, scope?: string): Promise<string>;
  connect(
    era: 'legacy' | 'modern',
    headers?: Record<string, string>,
    accessToken?: string
  ): Promise<Client>;
  close(): Promise<void>;
}

/** La app completa (puerta OAuth incluida) escuchando en un puerto efímero de 127.0.0.1. */
export async function startMcpHarness(
  issuer: TestIssuer,
  options: HarnessOptions = {}
): Promise<McpHarness> {
  const backend = options.backend ?? new FakeBackend();
  const config = testConfigWith(options.env);
  const logs: LogSpies = {
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
    always: vi.fn<ServiceLogger['always']>(),
  };
  const logger: ServiceLogger = logs;
  const exchanger = new AgentSessionExchanger({ apiBaseUrl: API_BASE, fetchImpl: backend.fetch });
  const verifier = new JwksAccessTokenVerifier({
    getKey: issuer.getKey,
    issuer: TEST_ISSUER,
    audience: TEST_AUDIENCE,
    logger,
  });
  const mcp = createMcpService({
    config,
    logger,
    sessions: exchanger,
    rateLimiter: options.rateLimiter ?? new MemoryRateLimiter(),
    proposalLock: options.proposalLock ?? new MemoryKeyedLock(),
    fetchImpl: backend.fetch,
    ...(options.backendTimeoutMs ? { backendTimeoutMs: options.backendTimeoutMs } : {}),
  });
  const app = createApp({
    config,
    logger,
    checkReady: () => Promise.resolve(true),
    verifier,
    exchanger,
    mcpHandler: mcp.mcpHandler,
  });
  const server: Server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${String(port)}/mcp`;
  const accessToken = await issuer.sign();
  const clients: Client[] = [];

  return {
    url,
    backend,
    logs,
    exchanger,
    accessToken,
    signAccessToken: (sub, clientId, scope = 'read write') =>
      issuer.sign({ claims: { sub, client_id: clientId, scope } }),
    async connect(era, headers = {}, token = accessToken) {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, ...headers } },
      });
      const client = new Client(
        { name: 'test-client', version: '1.0.0' },
        era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {}
      );
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await mcp.close();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}

/** Las líneas de auditoría (`mcp.tool_call`) emitidas. */
export function auditLines(logs: LogSpies): Record<string, unknown>[] {
  return logs.always.mock.calls
    .filter(([message]) => message === 'mcp.tool_call')
    .map(([, meta]) => meta ?? {});
}

/** Todo lo que se ha logueado, como texto (para buscar fugas). */
export function loggedText(logs: LogSpies): string {
  return JSON.stringify([
    logs.info.mock.calls,
    logs.warn.mock.calls,
    logs.error.mock.calls,
    logs.always.mock.calls,
  ]);
}
