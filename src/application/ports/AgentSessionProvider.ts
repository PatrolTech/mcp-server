import type { AgentSession } from '../../domain/auth/AgentSession.js';

/** Puerto: obtiene la sesión de agente que corresponde a un access token OAuth ya verificado. */
export interface AgentSessionProvider {
  /**
   * @throws AgentSessionRejectedError si el backend rechaza el access token (revocado, caducado…).
   * @throws AgentSessionRateLimitedError si el backend limita los canjes (429, con su espera).
   * @throws AgentSessionUnavailableError si el canje falla de forma transitoria o el token de
   *   sesión que devuelve no trae los claims esperados.
   */
  exchange(accessToken: string): Promise<AgentSession>;
  /** Descarta la sesión en caché de ese access token (p. ej. si `/api` la rechazó con 401). */
  forget(accessToken: string): void;
}
