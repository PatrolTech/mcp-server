import type { PatrolTechApiError } from '@patroltech/agent-capabilities';

/**
 * El `errorCode` de un rechazo del backend: el sobre de `/api` lo deja en `meta.errorCode`; algunos
 * cuerpos lo llevan en primer nivel (`errorCode` o `code`).
 */
export function backendErrorCode(error: PatrolTechApiError): string | undefined {
  const body = error.body as {
    meta?: { errorCode?: unknown };
    errorCode?: unknown;
    code?: unknown;
  } | null;
  const code = body?.meta?.errorCode ?? body?.errorCode ?? body?.code;
  return typeof code === 'string' ? code : undefined;
}
