import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  SdkPatrolTechGateway,
  buildCatalog,
  type PatrolTechUrls,
} from '@patroltech/agent-capabilities';
import type express from 'express';
import { createMcpServerFactory } from './interface/mcp/mcpServerFactory.js';
import type { KeyedLock } from './application/ports/KeyedLock.js';
import { PROPOSAL_TTL_MIN } from './application/proposals/ProposalDeps.js';
import type { ToolRuntime } from './interface/mcp/registerCapabilityTool.js';
import type { WriteToolDeps } from './interface/mcp/tools/writeTools.js';
import type { McpServerConfig } from './config.js';
import type { AgentSessionProvider } from './application/ports/AgentSessionProvider.js';
import type { RateLimiter } from './application/ports/RateLimiter.js';
import { LoggerAuditTrail } from './infrastructure/audit/LoggerAuditTrail.js';
import type { ServiceLogger } from './infrastructure/logging/logger.js';
import { createMcpRequestHandler } from './infrastructure/http/mcpRequestHandler.js';
import { AsyncLocalBackendCallTracker } from './infrastructure/patroltech/AsyncLocalBackendCallTracker.js';
import { SdkQrSheetLinks } from './infrastructure/patroltech/SdkQrSheetLinks.js';
import { CachingSessionDirectory } from './infrastructure/patroltech/CachingSessionDirectory.js';
import { SdkSessionDirectory } from './infrastructure/patroltech/SdkSessionDirectory.js';
import { HttpPendingActionStore } from './infrastructure/proposals/HttpPendingActionStore.js';

/** Timeout de cada llamada a `/api` (el de `SdkPatrolTechGateway` por defecto). */
const DEFAULT_BACKEND_TIMEOUT_MS = 10_000;

export interface McpServiceOptions {
  config: McpServerConfig;
  /** Con el canal `always`: la auditoría se escribe sea cual sea LOG_LEVEL. */
  logger: ServiceLogger;
  /** El mismo proveedor que usa la puerta de `/mcp`: se le pide olvidar sesiones rechazadas. */
  sessions: AgentSessionProvider;
  rateLimiter: RateLimiter;
  /**
   * Exclusión por usuario y cliente de las propuestas: la de `createSharedStores` (Redis compartido,
   * o memoria solo sin `REDIS_URL`), que es quien decide el respaldo.
   */
  proposalLock: KeyedLock;
  /** `fetch` hacia la API (tests: un backend falso). Por defecto, el global. */
  fetchImpl?: typeof fetch;
  backendTimeoutMs?: number;
}

export interface McpService {
  /** El `mcpHandler` de `createApp`. */
  mcpHandler: express.RequestHandler;
  close(): Promise<void>;
}

/**
 * Composición del servidor MCP: UNA instancia por proceso del gateway del catálogo, del
 * directorio de sesión y del rastreador de llamadas (lo de cada usuario viaja por llamada en
 * `AsyncLocalStorage`), el catálogo del canal `mcp` sin lecturas de ficheros, las dependencias de
 * las herramientas de escritura (propuestas sobre `/api/agent-proposals`, hoja de QR) y el handler
 * MCP sin estado del SDK.
 */
export function createMcpService(options: McpServiceOptions): McpService {
  const { config, logger, sessions, rateLimiter } = options;
  const timeoutMs = options.backendTimeoutMs ?? DEFAULT_BACKEND_TIMEOUT_MS;
  const tracker = new AsyncLocalBackendCallTracker({ apiBaseUrl: config.apiBaseUrl });
  const fetchImpl = tracker.fetch(options.fetchImpl ?? fetch);
  const urls: Partial<PatrolTechUrls> = { app: config.appBaseUrl, dashboard: config.dashboardUrl };

  const gateway = new SdkPatrolTechGateway({
    baseUrl: config.apiBaseUrl,
    fetchImpl,
    timeoutMs,
    logger,
    defaultHeaders: tracker.headers,
  });
  const sdkOptions = {
    baseUrl: config.apiBaseUrl,
    fetchImpl,
    timeoutMs,
    defaultHeaders: tracker.headers,
  };
  // Nombres de organizaciones y preferencias: una vez por sesión y minuto, no en cada llamada.
  const directory = new CachingSessionDirectory(new SdkSessionDirectory(sdkOptions));
  const writes: WriteToolDeps = {
    stores: (token) =>
      new HttpPendingActionStore({ ...sdkOptions, token, onExpectedStatus: tracker.acknowledge }),
    lock: options.proposalLock,
    qrSheets: new SdkQrSheetLinks(sdkOptions),
    ttlMin: PROPOSAL_TTL_MIN,
  };
  const catalog = buildCatalog({ gateway, logger, urls, offerFiles: false }, { channel: 'mcp' });

  const runtime: ToolRuntime = {
    rateLimiter,
    audit: new LoggerAuditTrail(logger),
    tracker,
    sessions,
    directory,
    urls,
    logger,
  };
  const handler = createMcpHandler(
    createMcpServerFactory({ runtime, catalog, gateway, writes, version: config.version }),
    {
      onerror: (error) => {
        logger.warn('mcp.protocol_error', { errorName: error.name, errorMessage: error.message });
      },
    }
  );

  return {
    mcpHandler: createMcpRequestHandler(handler, logger),
    close: () => handler.close(),
  };
}
