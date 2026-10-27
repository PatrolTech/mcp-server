import type { OrganizationRef } from '@patroltech/agent-capabilities';
import type { RoleClaims } from '../auth/AgentSession.js';

/**
 * Las organizaciones del usuario con su rol y ámbito, a partir de los claims de rol de su sesión:
 * - con un rol genuino de organización (`orgWideRoles`), ese rol y `scope: 'organization'`
 *   (gana siempre);
 * - a la que solo llega por roles de ubicación, `scope: 'location'` con el rol ascendido del JWT
 *   (`organizationRoles`), que es el MÁS ALTO de sus ubicaciones. Aquí se aparta a propósito del
 *   asistente de chat de PatrolTech, que toma el primero que encuentra: es determinista y coincide con la vista de
 *   organización del propio backend. `scope: 'location'` sigue cerrando las comprobaciones de
 *   organización, y `/api` decide por ubicación en cada llamada.
 *
 * Los roles son la fuente de verdad: los nombres solo los rotulan (sin nombre conocido, el id).
 * Ordenadas por nombre.
 */
export function organizationsFromRoles(
  roles: RoleClaims,
  names: ReadonlyMap<string, string>
): OrganizationRef[] {
  const orgIds = new Set([
    ...Object.keys(roles.orgWideRoles),
    ...Object.keys(roles.organizationRoles),
  ]);
  const organizations = [...orgIds].map((orgId): OrganizationRef => {
    const genuine = Object.hasOwn(roles.orgWideRoles, orgId);
    const knownName = names.get(orgId)?.trim() ?? '';
    return {
      orgId,
      name: knownName.length > 0 ? knownName : orgId,
      roleType: genuine ? roles.orgWideRoles[orgId] : roles.organizationRoles[orgId],
      scope: genuine ? 'organization' : 'location',
    };
  });
  return organizations.sort(
    (a, b) => a.name.localeCompare(b.name, 'es') || a.orgId.localeCompare(b.orgId)
  );
}
