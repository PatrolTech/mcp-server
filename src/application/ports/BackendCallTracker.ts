/** Etiquetas que acompañan a cada llamada al backend hecha durante una herramienta. */
export interface BackendCallLabels {
  requestId: string;
  clientId: string;
}

/** Qué pasó con las llamadas a `/api` hechas durante la herramienta. */
export interface BackendCallReport {
  /** Alguna respuesta de `/api` fue 401: la sesión de agente ya no vale. */
  sessionRejected: boolean;
  /**
   * Último status ≥ 400 de `/api` que nadie trató como respuesta prevista (un 404 de «no hay lote
   * vivo», por ejemplo, no cuenta: ver `acknowledge`), si lo hubo.
   */
  failedStatus?: number;
  /** Alguna llamada no llegó a tener respuesta (red, timeout). */
  unreachable: boolean;
}

export interface TrackedCall<T> {
  settled: PromiseSettledResult<T>;
  report: BackendCallReport;
}

/**
 * Puerto: ejecuta el cuerpo de una herramienta de modo que sus llamadas al backend lleven las
 * etiquetas (`X-Request-Id`, `X-Agent-Client`) y quede constancia de cómo respondió `/api`
 * (las capacidades convierten los fallos en `{ ok: false }`: sin esto un 401 no se distinguiría).
 */
export interface BackendCallTracker {
  track<T>(labels: BackendCallLabels, body: () => Promise<T>): Promise<TrackedCall<T>>;
  /**
   * Quien llamó a `/api` dentro de la herramienta trató ese status como una respuesta prevista
   * (404 = no existe, 409 = ya reclamada…): deja de contar como fallo para clasificar un `{ ok:
   * false }` posterior en la auditoría. Fuera de una herramienta no hace nada.
   */
  acknowledge(status: number): void;
}
