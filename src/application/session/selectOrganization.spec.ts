import type { OrganizationRef } from '@patroltech/agent-capabilities';
import { describe, expect, it } from 'vitest';
import { isRefusal } from '../ToolOutcome.js';
import { anyOrganization, selectOrganization } from './selectOrganization.js';

const ACME: OrganizationRef = {
  orgId: 'org-a',
  name: 'Acme Seguridad Norte',
  roleType: 'ADMIN',
  scope: 'organization',
};
const ACME_SUR: OrganizationRef = {
  orgId: 'org-s',
  name: 'Acme Seguridad Sur',
  roleType: 'VIEWER',
  scope: 'organization',
};
const BETA: OrganizationRef = {
  orgId: 'org-b',
  name: 'Beta Vigilancia',
  roleType: 'EDITOR',
  scope: 'location',
};
const MINE = [ACME, ACME_SUR, BETA];

describe('selectOrganization', () => {
  it('refuses when the account has no organization', () => {
    const result = selectOrganization([], 'Acme');
    expect(isRefusal(result) && result.reason).toBe('no_organization');
  });

  it('with a single organization uses it, also when requested by name or id', () => {
    expect(selectOrganization([BETA], undefined)).toBe(BETA);
    expect(selectOrganization([BETA], '  ')).toBe(BETA);
    expect(selectOrganization([BETA], 'beta')).toBe(BETA);
    expect(selectOrganization([BETA], 'org-b')).toBe(BETA);
  });

  it('with a single organization refuses another one (never its data under the other name)', () => {
    expect(selectOrganization([BETA], '00000000-0000-4000-8000-000000000001')).toMatchObject({
      refused: true,
      reason: 'organization_unknown',
      options: ['Beta Vigilancia'],
    });
  });

  it.each([undefined, '', '   '])(
    'with several organizations and no name (%j) asks for one, listing all',
    (name) => {
      const result = selectOrganization(MINE, name);
      expect(result).toMatchObject({
        refused: true,
        reason: 'organization_required',
        options: ['Acme Seguridad Norte', 'Acme Seguridad Sur', 'Beta Vigilancia'],
      });
    }
  );

  it('resolves an exact name, case- and accent-insensitively', () => {
    expect(selectOrganization(MINE, 'beta vigilancia')).toBe(BETA);
  });

  it('resolves an unambiguous part of a name', () => {
    expect(selectOrganization(MINE, 'Norte')).toBe(ACME);
  });

  it('refuses an ambiguous part, offering only the matches', () => {
    expect(selectOrganization(MINE, 'Acme')).toMatchObject({
      refused: true,
      reason: 'organization_ambiguous',
      options: ['Acme Seguridad Norte', 'Acme Seguridad Sur'],
    });
  });

  it('resolves the id of one of the user’s organizations', () => {
    expect(selectOrganization(MINE, 'org-b')).toBe(BETA);
  });

  it('refuses the id of an organization that is not the user’s (anti-leak)', () => {
    expect(selectOrganization(MINE, 'org-foreign')).toMatchObject({
      refused: true,
      reason: 'organization_unknown',
      options: ['Acme Seguridad Norte', 'Acme Seguridad Sur', 'Beta Vigilancia'],
    });
  });
});

describe('anyOrganization', () => {
  it("takes one of the user's organizations without asking", () => {
    expect(anyOrganization(MINE)).toBe(ACME);
  });

  it('refuses when the account has no organization', () => {
    const result = anyOrganization([]);
    expect(isRefusal(result) && result.reason).toBe('no_organization');
  });
});
