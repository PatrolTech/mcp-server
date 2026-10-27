import {
  PatrolTechApiError,
  translateActionError,
  translateBackendError,
  type FixedTextLanguage,
  type PatrolTechUrls,
} from '@patroltech/agent-capabilities';
import type { BackendCallReport } from '../../application/ports/BackendCallTracker.js';

/** Mensaje neutro cuando falla algo nuestro (sin trazas ni URLs internas). */
const UNEXPECTED_MESSAGE: Record<FixedTextLanguage, string> = {
  es: 'No se ha podido completar la consulta por un error interno. Inténtalo de nuevo en unos minutos.',
  en: 'The request could not be completed because of an internal error. Please try again in a few minutes.',
  fr: "La demande n'a pas pu aboutir à cause d'une erreur interne. Réessayez dans quelques minutes.",
};

/** Un fallo de transporte hacia la API: timeout, abort o `fetch` sin respuesta. */
function isTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

export interface ThrownFailure {
  /** `backend_<status>`, `backend_unreachable` o `internal`. */
  kind: string;
  message: string;
}

/**
 * Qué decirle al modelo de un error lanzado por el cuerpo de una herramienta, clasificado por el
 * PROPIO error (no por cómo fueron las demás llamadas: un 403 ya tratado no convierte un fallo
 * de programación en «el panel no responde»). Las lecturas se traducen sin «No se ha hecho
 * ningún cambio»; las escrituras, con el texto de acción.
 */
export function describeThrownFailure(
  error: unknown,
  report: BackendCallReport,
  options: {
    language: FixedTextLanguage;
    urls: Partial<PatrolTechUrls>;
    operation: 'read' | 'write';
  }
): ThrownFailure {
  const { language, urls, operation } = options;
  const translate = () =>
    operation === 'write'
      ? translateActionError(error, language, urls).mensajeCliente
      : translateBackendError(error, language, { urls, upsell: false, operation: 'read' })
          .mensajeCliente;

  if (error instanceof PatrolTechApiError) {
    return { kind: `backend_${String(error.status)}`, message: translate() };
  }
  if (report.unreachable || isTransportFailure(error)) {
    return { kind: 'backend_unreachable', message: translate() };
  }
  return { kind: 'internal', message: UNEXPECTED_MESSAGE[language] };
}

/** Clasificación de un `{ ok: false }` de la capacidad según cómo respondió `/api`. */
export function reportedFailureKind(report: BackendCallReport): string {
  if (report.unreachable) return 'backend_unreachable';
  if (report.failedStatus !== undefined) return `backend_${String(report.failedStatus)}`;
  return 'tool_error';
}

/** Mensaje y traza de un error para el log, con los tokens de la llamada censurados. */
export function redactedFailure(
  error: unknown,
  secrets: readonly string[]
): { errorName: string; errorMessage: string; stack?: string } {
  const redact = (text: string) =>
    secrets.reduce(
      (current, secret) => (secret ? current.replaceAll(secret, '[redacted]') : current),
      text
    );
  if (!(error instanceof Error)) {
    return { errorName: typeof error, errorMessage: redact(String(error)) };
  }
  return {
    errorName: error.name,
    errorMessage: redact(error.message),
    ...(error.stack ? { stack: redact(error.stack) } : {}),
  };
}
