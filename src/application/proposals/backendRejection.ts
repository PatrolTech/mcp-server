import {
  PatrolTechApiError,
  translateBackendError,
  type BackendErrorKind,
} from '@patroltech/agent-capabilities';

/**
 * Qué clase de rechazo del backend es un error (`session_expired`, `policies_pending`…), con la
 * clasificación del paquete: la aplicación decide por el significado, no por el status HTTP.
 * `undefined` si no es un rechazo del backend (red, timeout, un fallo nuestro).
 */
export function backendRejectionKind(error: unknown): BackendErrorKind | undefined {
  return error instanceof PatrolTechApiError ? translateBackendError(error).kind : undefined;
}
