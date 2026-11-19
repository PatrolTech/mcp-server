import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { AgentSessionExchanger } from './infrastructure/auth/AgentSessionExchanger.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { MemoryKeyedLock } from './infrastructure/locks/MemoryKeyedLock.js';
import { MemoryRateLimiter } from './infrastructure/rate-limit/MemoryRateLimiter.js';
import { createMcpService } from './mcpService.js';

/**
 * Entrada stdio para que los directorios que inspeccionan servidores por stdio (Glama, con
 * `mcp-proxy`) puedan arrancarlo y leer sus herramientas, prompts y recursos.
 *
 * ponytail: sin OAuth no hay identidad, así que toda llamada a una herramienta se rechaza; el uso
 * real es el endpoint HTTP remoto (`server.js`). Si algún día hace falta stdio de verdad, habrá que
 * aceptar aquí un token de acceso.
 */
// ponytail: valores por defecto = endpoints públicos de PatrolTech, para que los directorios lo
// arranquen sin configurar nada (solo listan). Las variables no vacías del entorno mandan.
const PUBLIC_DEFAULTS = {
  MCP_PUBLIC_URL: 'https://mcp.patroltech.online/mcp',
  API_BASE_URL: 'https://api.patroltech.online',
  OAUTH_ISSUER: 'https://api.patroltech.online',
  DASHBOARD_URL: 'https://dashboard.patroltech.online',
  APP_BASE_URL: 'https://app.patroltech.online',
  APP_ENVIRONMENT: 'development',
};
const setVars = Object.entries(process.env).filter(([, value]) => value);
const config = loadConfig({ ...PUBLIC_DEFAULTS, ...Object.fromEntries(setVars) });
const logger = createLogger({
  service: config.serviceName,
  env: config.environment,
  version: config.version,
  level: config.logLevel,
  stderrOnly: true,
});
const mcp = createMcpService({
  config,
  logger,
  sessions: new AgentSessionExchanger({ apiBaseUrl: config.apiBaseUrl }),
  // Sin Redis: ninguna llamada pasa la comprobación de identidad, así que nunca se usan.
  rateLimiter: new MemoryRateLimiter(),
  proposalLock: new MemoryKeyedLock(),
});

serveStdio(mcp.serverFactory, {
  onerror: (error) => {
    logger.warn('mcp.stdio_error', { errorName: error.name, errorMessage: error.message });
  },
});
