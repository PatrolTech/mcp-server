import { describe, expect, it, vi } from 'vitest';
import type { AgentSession } from '../../domain/auth/AgentSession.js';
import { agentSessionJwt, TWO_ORGS } from '../../testing/mcpHarness.js';
import type { SessionDirectory } from '../ports/SessionDirectory.js';
import { createSessionContextLoader } from './sessionContext.js';

const session: AgentSession = {
  token: agentSessionJwt(TWO_ORGS),
  expiresAt: Math.floor(Date.now() / 1000) + 900,
  scopes: ['read'],
  userId: 'user-1',
  // Parsed once at exchange time: the loader never decodes the token again.
  roles: TWO_ORGS,
};

function directory(overrides: Partial<SessionDirectory> = {}): SessionDirectory {
  return {
    organizationNames: vi.fn(() =>
      Promise.resolve(
        new Map([
          ['org-a', 'Acme'],
          ['org-b', 'Beta'],
        ])
      )
    ),
    preferences: vi.fn(() => Promise.resolve({ language: 'fr-FR', timezone: 'America/Lima' })),
    ...overrides,
  };
}

describe('createSessionContextLoader', () => {
  it('builds the context once per request from the JWT roles, the names and the preferences', async () => {
    const dir = directory();
    const load = createSessionContextLoader(session, dir);

    const [first, second] = await Promise.all([load(), load()]);

    expect(first).toBe(second);
    expect(dir.organizationNames).toHaveBeenCalledTimes(1);
    expect(dir.organizationNames).toHaveBeenCalledWith(session.token);
    expect(first).toEqual({
      organizations: [
        { orgId: 'org-a', name: 'Acme', roleType: 'ADMIN', scope: 'organization' },
        { orgId: 'org-b', name: 'Beta', roleType: 'EDITOR', scope: 'location' },
      ],
      token: session.token,
      tz: 'America/Lima',
      country: null,
      language: 'fr',
    });
  });

  it('falls back to Spanish and Madrid when the preferences cannot be read', async () => {
    const load = createSessionContextLoader(
      session,
      directory({ preferences: () => Promise.reject(new Error('boom')) })
    );
    expect(await load()).toMatchObject({ language: 'es', tz: 'Europe/Madrid' });
  });

  it('uses the timezone of the session claims when the preferences have none', async () => {
    const load = createSessionContextLoader(
      { ...session, preferredTimezone: 'Europe/Lisbon' },
      directory({ preferences: () => Promise.resolve({ language: null, timezone: null }) })
    );
    expect(await load()).toMatchObject({ language: 'es', tz: 'Europe/Lisbon' });
  });

  it('builds the organizations from the session roles, not from the token text', async () => {
    const load = createSessionContextLoader({ ...session, token: 'opaque' }, directory());
    expect((await load()).organizations.map((o) => o.orgId)).toEqual(['org-a', 'org-b']);
  });

  it('fails when the organization names cannot be read (no partial context)', async () => {
    const load = createSessionContextLoader(
      session,
      directory({ organizationNames: () => Promise.reject(new Error('down')) })
    );
    await expect(load()).rejects.toThrow('down');
  });
});
