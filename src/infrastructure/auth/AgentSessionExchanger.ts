import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentSessionProvider } from '../../application/ports/AgentSessionProvider.js';
import type { AgentSession } from '../../domain/auth/AgentSession.js';
import {
  AgentSessionRateLimitedError,
  AgentSessionRejectedError,
  AgentSessionUnavailableError,
} from '../../domain/auth/errors.js';
import { readAgentSessionClaims, type AgentSessionClaims } from './agentSessionClaims.js';

export interface AgentSessionExchangerOptions {
  apiBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Reloj en milisegundos (inyectable en tests). */
  now?: () => number;
  maxEntries?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ENTRIES = 5000;
/** Una sesión se reutiliza solo mientras falte más de este margen para `expires_at`. */
const SAFETY_MARGIN_SEC = 60;
/** Espera por defecto tras un 429 sin `Retry-After` útil, y su tope. */
const DEFAULT_RETRY_AFTER_SEC = 5;
const MAX_RETRY_AFTER_SEC = 3600;

/** Los segundos de `Retry-After` (solo la forma en segundos), acotados; por defecto, 5. */
function retryAfterSecOf(response: Response): number {
  const seconds = Number(response.headers.get('Retry-After'));
  return Number.isInteger(seconds) && seconds > 0
    ? Math.min(seconds, MAX_RETRY_AFTER_SEC)
    : DEFAULT_RETRY_AFTER_SEC;
}

const hashToken = (accessToken: string): string =>
  createHash('sha256').update(accessToken).digest('hex');

const agentSessionResponse = z.object({
  token: z.string().min(1),
  expires_at: z.number().finite(),
  scope: z.string().trim().min(1),
  user_id: z.string().min(1),
});

/**
 * Canjea el access token OAuth por el JWT de sesión de agente de la API
 * (`POST /oauth/agent-session`). Cachea por hash del token (nunca por el token) hasta
 * 60 s antes de `expires_at`, con un límite LRU, y agrupa los canjes simultáneos.
 */
export class AgentSessionExchanger implements AgentSessionProvider {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;
  /** Map conserva el orden de inserción: la primera clave es la menos reciente. */
  private readonly cache = new Map<string, AgentSession>();
  private readonly inFlight = new Map<string, Promise<AgentSession>>();

  constructor(options: AgentSessionExchangerOptions) {
    this.endpoint = `${options.apiBaseUrl.replace(/\/+$/, '')}/oauth/agent-session`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async exchange(accessToken: string): Promise<AgentSession> {
    const key = hashToken(accessToken);

    const cached = this.cache.get(key);
    if (cached) {
      if (this.isReusable(cached)) {
        // Refresca la recencia: reinsertar la clave la mueve al final.
        this.cache.delete(key);
        this.cache.set(key, cached);
        return cached;
      }
      this.cache.delete(key);
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const request = this.requestSession(accessToken)
      .then((session) => {
        this.remember(key, session);
        return session;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }

  forget(accessToken: string): void {
    this.cache.delete(hashToken(accessToken));
  }

  private isReusable(session: AgentSession): boolean {
    return this.now() / 1000 < session.expiresAt - SAFETY_MARGIN_SEC;
  }

  private remember(key: string, session: AgentSession): void {
    if (!this.isReusable(session)) {
      return;
    }
    this.cache.set(key, session);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) {
        break;
      }
      this.cache.delete(oldest.value);
    }
  }

  private async requestSession(accessToken: string): Promise<AgentSession> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        // El token viaja en la cabecera: nunca se reenvía a otro destino ni se sirve de una caché HTTP.
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // El mensaje original no se propaga: una URL o cabecera con el token no debe escaparse.
      const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
      throw new AgentSessionUnavailableError(timedOut ? 'timeout' : 'network error');
    }

    if (response.status === 401) {
      await response.body?.cancel();
      throw new AgentSessionRejectedError();
    }
    if (response.status === 429) {
      // El límite por concesión del backend: el cliente debe esperar, no reintentar enseguida.
      await response.body?.cancel();
      throw new AgentSessionRateLimitedError(retryAfterSecOf(response));
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new AgentSessionUnavailableError(`backend answered ${String(response.status)}`);
    }

    const body = await response.json().then(
      (json: unknown) => agentSessionResponse.safeParse(json),
      () => undefined
    );
    if (!body?.success) {
      throw new AgentSessionUnavailableError('invalid response body');
    }
    // Los claims se leen una vez aquí (la sesión se cachea), no en cada llamada a una herramienta.
    let claims: AgentSessionClaims;
    try {
      claims = readAgentSessionClaims(body.data.token);
    } catch {
      throw new AgentSessionUnavailableError('agent session token without role claims');
    }
    return {
      token: body.data.token,
      expiresAt: body.data.expires_at,
      scopes: body.data.scope.split(/\s+/).filter(Boolean),
      userId: body.data.user_id,
      ...claims,
    };
  }
}
