import { describe, expect, it } from 'vitest';
import { organizationKey, sameOrganizationId } from './organizationId.js';

describe('organization ids', () => {
  it('compare without case, as the backend stores them in lower case', () => {
    expect(sameOrganizationId('ORG-A', 'org-a')).toBe(true);
    expect(sameOrganizationId('org-a', 'org-b')).toBe(false);
    expect(organizationKey('AbC')).toBe('abc');
  });

  it('treat a missing id as the empty key', () => {
    expect(organizationKey(null)).toBe('');
    expect(sameOrganizationId(null, '')).toBe(true);
    expect(sameOrganizationId(null, 'org-a')).toBe(false);
  });
});
