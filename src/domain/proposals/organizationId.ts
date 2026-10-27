/**
 * Clave de comparación de un id de organización: en minúsculas (el backend guarda los UUID así;
 * la sesión los trae como los emitió el token).
 */
export function organizationKey(orgId: string | null): string {
  return (orgId ?? '').toLowerCase();
}

/** ¿Son la misma organización? Sin distinguir mayúsculas. */
export function sameOrganizationId(a: string | null, b: string | null): boolean {
  return organizationKey(a) === organizationKey(b);
}
