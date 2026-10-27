import {
  getGetUserPreferencesUrl,
  getListOrganizationsUrl,
  getUserPreferences,
  listOrganizations,
} from './sdk.js';
import type {
  SessionDirectory,
  UserPreferences,
} from '../../application/ports/SessionDirectory.js';
import { callSdk, type SdkCallConfig } from '@patroltech/agent-capabilities';

export type SdkSessionDirectoryOptions = SdkCallConfig;

/**
 * `SessionDirectory` sobre el SDK oficial, con la configuración de cada petición (base, token,
 * `fetch`): nada global, una instancia sirve a todos los usuarios. Los rechazos del backend salen
 * como `PatrolTechApiError`, igual que los del gateway del catálogo.
 */
export class SdkSessionDirectory implements SessionDirectory {
  constructor(private readonly options: SdkSessionDirectoryOptions) {}

  async organizationNames(token: string): Promise<ReadonlyMap<string, string>> {
    const response = await callSdk(this.options, token, getListOrganizationsUrl(), (init) =>
      listOrganizations(init)
    );
    // `data` es un objeto indexado por id de organización.
    return new Map(Object.values(response.data).map((org) => [org.id, org.name]));
  }

  async preferences(token: string): Promise<UserPreferences> {
    const response = await callSdk(this.options, token, getGetUserPreferencesUrl(), (init) =>
      getUserPreferences(init)
    );
    return {
      language: response.data.preferredLanguage,
      timezone: response.data.preferredTimezone,
    };
  }
}
