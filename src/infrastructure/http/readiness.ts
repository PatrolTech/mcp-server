import type { Logger } from '@patroltech/agent-capabilities';

/** Una dependencia de la que depende atender peticiones: `true` si responde. */
export type ReadinessProbe = () => Promise<boolean>;

/**
 * La sonda de `/health/ready`: lista solo si TODAS las dependencias responden (el JWKS de la API
 * siempre; Redis cuando está configurado, porque sin él las escrituras se niegan). Una que falla o
 * lanza cuenta como caída, y el log dice cuál.
 */
export function createReadinessCheck(
  probes: Readonly<Record<string, ReadinessProbe>>,
  logger: Logger
): () => Promise<boolean> {
  return async () => {
    const results = await Promise.all(
      Object.entries(probes).map(async ([name, probe]) => ({
        name,
        ok: await probe().catch(() => false),
      }))
    );
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    if (failed.length > 0) logger.warn('mcp.not_ready', { failed });
    return failed.length === 0;
  };
}

/** El JWKS de la API responde (2xx) dentro del límite. No lee el cuerpo. */
export function jwksReachable(
  jwksUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): ReadinessProbe {
  return async () => {
    const response = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(timeoutMs) });
    // Libera la conexión: no necesitamos el cuerpo del JWKS.
    await response.body?.cancel();
    return response.ok;
  };
}
