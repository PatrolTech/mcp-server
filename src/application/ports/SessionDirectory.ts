export interface UserPreferences {
  language: string | null;
  timezone: string | null;
}

/**
 * Puerto: lo que el contexto de sesión necesita leer del backend con el JWT de sesión de agente.
 * Un rechazo del backend llega como `PatrolTechApiError` (lo entienden los traductores del
 * paquete); un fallo de red o timeout, tal cual.
 */
export interface SessionDirectory {
  /** Nombre de cada organización accesible, por id. */
  organizationNames(token: string): Promise<ReadonlyMap<string, string>>;
  preferences(token: string): Promise<UserPreferences>;
}
