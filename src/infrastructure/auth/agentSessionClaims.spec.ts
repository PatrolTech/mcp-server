import { describe, expect, it } from 'vitest';
import { InvalidAgentSessionError, readAgentSessionClaims } from './agentSessionClaims.js';

const jwtWith = (payload: object): string =>
  `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;

describe('readAgentSessionClaims', () => {
  it('reads the three role maps and the preferred timezone of the agent-session JWT', () => {
    const claims = readAgentSessionClaims(
      jwtWith({
        id: 'user-1',
        preferredTimezone: 'America/Mexico_City',
        roles: {
          organizationRoles: { 'org-a': 'ADMIN' },
          locationRoles: { 'loc-1': 'EDITOR' },
          orgWideRoles: { 'org-a': 'ADMIN' },
        },
      })
    );
    expect(claims).toEqual({
      roles: {
        organizationRoles: { 'org-a': 'ADMIN' },
        locationRoles: { 'loc-1': 'EDITOR' },
        orgWideRoles: { 'org-a': 'ADMIN' },
      },
      preferredTimezone: 'America/Mexico_City',
    });
  });

  it('reads the user name (or the email when there is no name) for the actions that cite the user', () => {
    const roles = { organizationRoles: {}, locationRoles: {} };
    expect(readAgentSessionClaims(jwtWith({ name: 'Ana Ruiz', email: 'a@x.test', roles }))).toEqual(
      expect.objectContaining({ userName: 'Ana Ruiz' })
    );
    expect(readAgentSessionClaims(jwtWith({ name: ' ', email: 'a@x.test', roles }))).toEqual(
      expect.objectContaining({ userName: 'a@x.test' })
    );
    expect(readAgentSessionClaims(jwtWith({ roles }))).not.toHaveProperty('userName');
  });

  it('fails closed without `orgWideRoles`: no organization counts as org-wide', () => {
    const claims = readAgentSessionClaims(
      jwtWith({ roles: { organizationRoles: { 'org-a': 'VIEWER' }, locationRoles: {} } })
    );
    expect(claims.roles.orgWideRoles).toEqual({});
    expect(claims).not.toHaveProperty('preferredTimezone');
  });

  it.each([
    ['not a JWT', 'abc'],
    ['payload that is not JSON', 'a.bm90LWpzb24.c'],
    ['no roles claim', jwtWith({ id: 'u' })],
    ['roles with a non-string value', jwtWith({ roles: { organizationRoles: { o: 1 } } })],
  ])('rejects %s', (_case, token) => {
    expect(() => readAgentSessionClaims(token)).toThrow(InvalidAgentSessionError);
  });
});
