import { ok, type LocationRef, type PatrolTechGateway } from '@patroltech/agent-capabilities';
import type { ToolOutcome } from '../ToolOutcome.js';
import type { UserSessionContext } from '../session/sessionContext.js';

interface OrganizationContext {
  id: string;
  name: string;
  role: string | null;
  /** `location`: el rol solo vale en alguna de sus ubicaciones. */
  access: 'organization' | 'location';
  /** null si no se han podido leer (el aviso lo explica). */
  locations: { id: string; name: string }[] | null;
}

/**
 * Aviso de las organizaciones cuyas ubicaciones no se pudieron leer. Sin sus nombres (los
 * escribieron usuarios y `notices` es texto nuestro): `locations: null` ya dice cuáles en `data`.
 */
export function unreadableLocationsNotice(count: number): string {
  return `The locations of ${String(count)} organization(s) could not be read; they have \`locations: null\` in \`data\`.`;
}

/**
 * El punto de entrada del modelo: las organizaciones del usuario (nombre, rol, acceso) con sus
 * ubicaciones, más el idioma y la zona de la sesión. Una organización cuyas ubicaciones no se
 * pueden leer no tumba el resto.
 */
export async function loadAccountContext(
  session: UserSessionContext,
  gateway: Pick<PatrolTechGateway, 'listLocations'>
): Promise<ToolOutcome> {
  let unreadable = 0;
  const organizations = await Promise.all(
    session.organizations.map(async (org): Promise<OrganizationContext> => {
      const locations = await gateway
        .listLocations(org.orgId, session.token)
        .catch((): LocationRef[] | null => null);
      if (locations === null) unreadable += 1;
      return {
        id: org.orgId,
        name: org.name,
        role: org.roleType ?? null,
        access: org.scope ?? 'organization',
        locations: locations?.map(({ id, name }) => ({ id, name })) ?? null,
      };
    })
  );
  const avisos = unreadable > 0 ? [unreadableLocationsNotice(unreadable)] : [];
  return ok({ organizations, language: session.language, timezone: session.tz }, { avisos });
}
