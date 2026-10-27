import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { proposalContextKey } from './contextKey.js';

describe('proposalContextKey', () => {
  it('is mcp:<userId>:<first 32 hex of sha256(clientId)>', () => {
    const hash = createHash('sha256').update('client-1').digest('hex').slice(0, 32);
    expect(proposalContextKey('user-1', 'client-1')).toBe(`mcp:user-1:${hash}`);
  });

  it('separates users and OAuth clients', () => {
    const base = proposalContextKey('user-1', 'client-1');
    expect(proposalContextKey('user-2', 'client-1')).not.toBe(base);
    expect(proposalContextKey('user-1', 'client-2')).not.toBe(base);
    expect(proposalContextKey('user-1', 'client-1')).toBe(base);
  });

  it('fits the backend limits (≤ 300 chars, no trailing whitespace) for any client id', () => {
    const key = proposalContextKey('00000000-0000-4000-8000-000000000002', 'x'.repeat(2000) + ' ');
    expect(key.length).toBeLessThanOrEqual(300);
    expect(key).toMatch(/\S$/);
  });
});
