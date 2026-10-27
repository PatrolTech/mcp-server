import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { AgentSessionExchanger } from './infrastructure/auth/AgentSessionExchanger.js';
import { JwksAccessTokenVerifier } from './infrastructure/auth/JwksAccessTokenVerifier.js';
import { startHeartbeat } from './infrastructure/logging/heartbeat.js';
import { createReadinessCheck, jwksReachable } from './infrastructure/http/readiness.js';
import { createLogger } from './infrastructure/logging/logger.js';
import { createSharedStores } from './infrastructure/redis/createSharedStores.js';
import { createMcpService } from './mcpService.js';

const READINESS_TIMEOUT_MS = 3000;
/**
 * Espera máxima a que terminen las peticiones en curso al parar (`server.close` deja de aceptar y
 * espera a las activas): una confirmación de 10 cambios, con hasta 10 s por llamada al backend,
 * cabe; cortarla dejaría un cambio `executing` y el lote bloqueado unos minutos. El gestor de
 * procesos debe esperar algo más antes de matar el proceso.
 */
const SHUTDOWN_GRACE_MS = 55_000;

const config = loadConfig();
const logger = createLogger({
  service: config.serviceName,
  env: config.environment,
  version: config.version,
  level: config.logLevel,
});

const verifier = new JwksAccessTokenVerifier({
  jwksUrl: config.jwksUrl,
  issuer: config.oauthIssuer,
  audience: config.publicUrl,
  logger,
});

const exchanger = new AgentSessionExchanger({ apiBaseUrl: config.apiBaseUrl });
const shared = createSharedStores({
  redisUrl: config.redisUrl,
  namespace: config.redisNamespace,
  logger,
});
// Lista solo si el JWKS responde y, con REDIS_URL, también Redis (sin él se niegan las escrituras).
const checkReady = createReadinessCheck(
  {
    jwks: jwksReachable(config.jwksUrl, READINESS_TIMEOUT_MS),
    ...(shared.ping ? { redis: shared.ping } : {}),
  },
  logger
);

const mcp = createMcpService({
  config,
  logger,
  sessions: exchanger,
  rateLimiter: shared.rateLimiter,
  proposalLock: shared.proposalLock,
});

const app = createApp({
  config,
  logger,
  checkReady,
  verifier,
  exchanger,
  mcpHandler: mcp.mcpHandler,
});

// HOST (127.0.0.1 por defecto): el proxy inverso del despliegue le pasa las peticiones.
const server = app.listen(config.port, config.host, () => {
  logger.info('mcp.started', {
    host: config.host,
    port: config.port,
    publicUrl: config.publicUrl,
    environment: config.environment,
  });
});

const stopHeartbeat = startHeartbeat(logger);

function shutdown(signal: string): void {
  stopHeartbeat();
  logger.info('mcp.stopping', { signal });
  const forceExit = setTimeout(() => {
    logger.error('mcp.shutdown_timeout', { signal });
    process.exit(1);
  }, SHUTDOWN_GRACE_MS);
  forceExit.unref();
  server.close((err) => {
    if (err) {
      logger.error('mcp.shutdown_failed', { err });
      process.exit(1);
    }
    void Promise.allSettled([mcp.close(), shared.close()]).then(() => process.exit(0));
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
