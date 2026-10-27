import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  BackendCallLabels,
  BackendCallReport,
  BackendCallTracker,
  TrackedCall,
} from '../../application/ports/BackendCallTracker.js';

interface CallScope {
  labels: BackendCallLabels;
  sessionRejected: boolean;
  unreachable: boolean;
  /** Los status ≥ 400 de `/api` aún no reconocidos como previstos, en orden. */
  failedStatuses: number[];
}

function reportOf(scope: CallScope): BackendCallReport {
  const failedStatus = scope.failedStatuses.at(-1);
  return {
    sessionRejected: scope.sessionRejected,
    unreachable: scope.unreachable,
    ...(failedStatus !== undefined ? { failedStatus } : {}),
  };
}

/** Un valor de cabecera seguro: sin caracteres de control y acotado. */
function headerValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, '').slice(0, 256);
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/**
 * `BackendCallTracker` sobre `AsyncLocalStorage`: el gateway del catálogo y el directorio de
 * sesión son instancias únicas del proceso, y lo de cada llamada (id de petición, cliente, qué
 * respondió `/api`) viaja en el contexto asíncrono de la herramienta que se está ejecutando.
 * Úsalo así: `fetchImpl: tracker.fetch(fetch)` y `defaultHeaders: tracker.headers`.
 */
export class AsyncLocalBackendCallTracker implements BackendCallTracker {
  private readonly storage = new AsyncLocalStorage<CallScope>();
  private readonly apiPrefix: string;

  constructor(options: { apiBaseUrl: string }) {
    this.apiPrefix = `${options.apiBaseUrl.replace(/\/+$/, '')}/api/`;
  }

  async track<T>(labels: BackendCallLabels, body: () => Promise<T>): Promise<TrackedCall<T>> {
    const scope: CallScope = {
      labels,
      sessionRejected: false,
      unreachable: false,
      failedStatuses: [],
    };
    const settled = await this.storage.run(scope, async () => {
      try {
        return { status: 'fulfilled', value: await body() } as const;
      } catch (reason) {
        return { status: 'rejected', reason } as const;
      }
    });
    return { settled, report: reportOf(scope) };
  }

  /** El último `status` de la llamada en curso era una respuesta prevista: deja de ser un fallo. */
  readonly acknowledge = (status: number): void => {
    const scope = this.storage.getStore();
    if (!scope) return;
    const index = scope.failedStatuses.lastIndexOf(status);
    if (index !== -1) scope.failedStatuses.splice(index, 1);
  };

  /** Cabeceras de auditoría de la llamada en curso (ninguna fuera de una herramienta). */
  readonly headers = (): Record<string, string> => {
    const scope = this.storage.getStore();
    if (!scope) return {};
    return {
      'X-Request-Id': headerValue(scope.labels.requestId),
      'X-Agent-Client': headerValue(scope.labels.clientId),
    };
  };

  /** `fetch` que anota en la llamada en curso cómo respondió `/api`. */
  fetch(base: typeof fetch): typeof fetch {
    return async (input, init) => {
      const scope = this.storage.getStore();
      const isApi = urlOf(input).startsWith(this.apiPrefix);
      let response: Response;
      try {
        response = await base(input, init);
      } catch (error) {
        if (scope && isApi) scope.unreachable = true;
        throw error;
      }
      if (scope && isApi && response.status >= 400) {
        scope.failedStatuses.push(response.status);
        if (response.status === 401) scope.sessionRejected = true;
      }
      return response;
    };
  }
}
