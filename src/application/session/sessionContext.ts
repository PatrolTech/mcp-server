import type { FixedTextLanguage, OrganizationRef } from '@patroltech/agent-capabilities';
import type { AgentSession } from '../../domain/auth/AgentSession.js';
import { organizationsFromRoles } from '../../domain/session/organizations.js';
import { languageFrom, timezoneFrom } from '../../domain/session/preferences.js';
import type { SessionDirectory, UserPreferences } from '../ports/SessionDirectory.js';

/** Lo que comparten todas las herramientas de una petición: el `SessionContext` sin `org`. */
export interface UserSessionContext {
  organizations: OrganizationRef[];
  /** JWT de sesión de agente: el único token que va a `/api`. */
  token: string;
  tz: string;
  /** Ninguna fuente fiable para el MCP (no hay teléfono): null, como prevé el paquete. */
  country: null;
  language: FixedTextLanguage;
}

export type SessionContextLoader = () => Promise<UserSessionContext>;

const NO_PREFERENCES: UserPreferences = { language: null, timezone: null };

/**
 * Construye, la primera vez que una herramienta lo pide y una sola vez por petición, el contexto
 * de sesión del usuario: organizaciones (roles de la sesión, leídos del JWT al canjearlo, + nombres
 * de `listOrganizations`), idioma
 * y zona de sus preferencias (si no se pueden leer: español y la zona del JWT o Madrid).
 * `tools/list` no lo necesita, así que no llama al backend.
 */
export function createSessionContextLoader(
  session: AgentSession,
  directory: SessionDirectory
): SessionContextLoader {
  let pending: Promise<UserSessionContext> | undefined;

  const load = async (): Promise<UserSessionContext> => {
    const [names, preferences] = await Promise.all([
      directory.organizationNames(session.token),
      // Las preferencias solo afinan idioma y zona: si fallan se usan los valores por defecto.
      directory.preferences(session.token).catch(() => NO_PREFERENCES),
    ]);
    return {
      organizations: organizationsFromRoles(session.roles, names),
      token: session.token,
      tz: timezoneFrom(preferences.timezone, session.preferredTimezone),
      country: null,
      language: languageFrom(preferences.language),
    };
  };

  return () => {
    pending ??= load();
    return pending;
  };
}
