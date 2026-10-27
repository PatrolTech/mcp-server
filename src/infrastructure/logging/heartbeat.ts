import type { ServiceLogger } from './logger.js';

/** Cada cuánto escribe su latido cada proceso (un monitor de logs puede alertar por su ausencia). */
export const HEARTBEAT_INTERVAL_MS = 5 * 60_000;

/**
 * Latido: una línea `mcp.heartbeat` por intervalo y proceso, por el canal `always` (sea cual sea
 * LOG_LEVEL), para que quien recoja los logs pueda alertar por su ausencia (proceso caído o
 * atascado). `unref`: nunca mantiene vivo el proceso. Devuelve cómo pararlo.
 */
export function startHeartbeat(
  logger: Pick<ServiceLogger, 'always'>,
  intervalMs: number = HEARTBEAT_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    logger.always('mcp.heartbeat', {
      event: 'mcp.heartbeat',
      pid: process.pid,
      // Índice de la instancia si el gestor de procesos lo da (NODE_APP_INSTANCE); si no, null.
      instance: process.env.NODE_APP_INSTANCE ?? null,
      uptimeSec: Math.round(process.uptime()),
    });
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
