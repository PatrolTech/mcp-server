import { describe, expect, it } from 'vitest';
import { organizationsFromRoles } from './organizations.js';

describe('organizationsFromRoles', () => {
  const names = new Map([
    ['org-a', 'Acme Seguridad'],
    ['org-b', 'Beta Vigilancia'],
  ]);

  it('takes the genuine org-wide role and scope `organization` (it wins over a location role)', () => {
    const orgs = organizationsFromRoles(
      {
        organizationRoles: { 'org-a': 'ADMIN' },
        orgWideRoles: { 'org-a': 'VIEWER' },
        locationRoles: { 'loc-1': 'ADMIN' },
      },
      names
    );
    expect(orgs).toEqual([
      { orgId: 'org-a', name: 'Acme Seguridad', roleType: 'VIEWER', scope: 'organization' },
    ]);
  });

  it('marks an organization reached only through location roles with scope `location` and the promoted (highest) role', () => {
    const orgs = organizationsFromRoles(
      {
        organizationRoles: { 'org-b': 'ADMIN' },
        orgWideRoles: {},
        locationRoles: { 'loc-9': 'VIEWER', 'loc-10': 'ADMIN' },
      },
      names
    );
    expect(orgs).toEqual([
      { orgId: 'org-b', name: 'Beta Vigilancia', roleType: 'ADMIN', scope: 'location' },
    ]);
  });

  it('keeps an organization the name list does not know, named by its id, and sorts by name', () => {
    const orgs = organizationsFromRoles(
      {
        organizationRoles: { 'org-z': 'VIEWER', 'org-b': 'ADMIN', 'org-a': 'ADMIN' },
        orgWideRoles: { 'org-z': 'VIEWER', 'org-b': 'ADMIN', 'org-a': 'ADMIN' },
        locationRoles: {},
      },
      names
    );
    expect(orgs.map((o) => o.name)).toEqual(['Acme Seguridad', 'Beta Vigilancia', 'org-z']);
  });

  it('never adds an organization that is only in the name list (roles are the source of truth)', () => {
    const orgs = organizationsFromRoles(
      { organizationRoles: {}, orgWideRoles: {}, locationRoles: {} },
      names
    );
    expect(orgs).toEqual([]);
  });
});
