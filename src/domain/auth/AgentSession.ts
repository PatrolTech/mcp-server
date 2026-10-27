/**
 * Claims de rol del JWT de sesión de agente (el mismo constructor de payload que un login,
 * `JwtTokenService.buildUserPayload` del backend):
 * - `organizationRoles`: rol por organización, YA ascendido desde los roles de ubicación (el más
 *   alto de sus ubicaciones);
 * - `orgWideRoles`: solo los roles genuinos de organización (sin ascensos);
 * - `locationRoles`: rol por ubicación.
 */
export interface RoleClaims {
  organizationRoles: Record<string, string>;
  orgWideRoles: Record<string, string>;
  locationRoles: Record<string, string>;
}

export interface AgentSession {
  /** JWT de sesión de agente con el que se llama a `/api`. */
  token: string;
  /** Epoch en segundos. */
  expiresAt: number;
  scopes: string[];
  userId: string;
  /** Claims de rol del token, leídos una vez al canjearlo (no deciden el acceso: lo hace `/api`). */
  roles: RoleClaims;
  /** Zona horaria del perfil del usuario, si el token la trae. */
  preferredTimezone?: string;
  /** Nombre (o email) del usuario, si el token lo trae: lo citan las acciones sobre él mismo. */
  userName?: string;
}
