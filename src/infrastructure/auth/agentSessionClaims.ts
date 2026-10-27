import { decodeJwt } from 'jose';
import { z } from 'zod';
import type { RoleClaims } from '../../domain/auth/AgentSession.js';

/** El JWT de sesión de agente no trae los claims que esperamos: es un fallo nuestro o del backend. */
export class InvalidAgentSessionError extends Error {
  constructor(reason: string) {
    super(`Invalid agent session token: ${reason}`);
    this.name = 'InvalidAgentSessionError';
  }
}

const roleMap = z.record(z.string(), z.string());

const sessionPayload = z.object({
  preferredTimezone: z.string().min(1).optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  roles: z.object({
    organizationRoles: roleMap,
    locationRoles: roleMap.default({}),
    orgWideRoles: roleMap.optional(),
  }),
});

export interface AgentSessionClaims {
  roles: RoleClaims;
  preferredTimezone?: string;
  userName?: string;
}

/**
 * Lee (sin verificar la firma) los claims de rol del JWT de sesión de agente. No hace falta
 * verificarlo: lo acaba de emitir nuestro backend por TLS a cambio del access token, y el
 * backend lo verifica en cada llamada a `/api`, que es donde se decide el acceso. Aquí solo
 * sirven para saber qué organizaciones ofrecer y con qué rol.
 *
 * Sin `orgWideRoles` (tokens anteriores al claim; los de agente lo traen siempre) se cierra en
 * vez de abrir: ninguna organización cuenta como de toda la organización.
 */
export function readAgentSessionClaims(token: string): AgentSessionClaims {
  let payload: unknown;
  try {
    payload = decodeJwt(token);
  } catch {
    throw new InvalidAgentSessionError('not a JWT with a JSON payload');
  }
  const parsed = sessionPayload.safeParse(payload);
  if (!parsed.success) {
    throw new InvalidAgentSessionError('missing or malformed role claims');
  }
  const { roles, preferredTimezone, name, email } = parsed.data;
  // Lo citan las acciones que hablan del propio usuario («asignada a …»).
  // El primero no vacío: un nombre en blanco cae al email.
  const userName = [name, email].map((value) => value?.trim()).find(Boolean);
  return {
    roles: {
      organizationRoles: roles.organizationRoles,
      orgWideRoles: roles.orgWideRoles ?? {},
      locationRoles: roles.locationRoles,
    },
    ...(preferredTimezone ? { preferredTimezone } : {}),
    ...(userName ? { userName } : {}),
  };
}
