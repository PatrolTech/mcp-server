/** El backend rechazó el access token al canjearlo (401): el cliente debe responder 401. */
export class AgentSessionRejectedError extends Error {
  constructor() {
    super('The backend rejected the access token');
    this.name = 'AgentSessionRejectedError';
  }
}

/** El canje no se pudo completar (5xx, timeout, red o cuerpo inválido): fallo transitorio. */
export class AgentSessionUnavailableError extends Error {
  constructor(reason: string) {
    super(`Agent session exchange unavailable: ${reason}`);
    this.name = 'AgentSessionUnavailableError';
  }
}

/** El backend limita los canjes de esta concesión (429): hay que esperar `retryAfterSec`. */
export class AgentSessionRateLimitedError extends Error {
  constructor(readonly retryAfterSec: number) {
    super(`Agent session exchange rate limited; retry after ${String(retryAfterSec)} s`);
    this.name = 'AgentSessionRateLimitedError';
  }
}
