import { describe, expect, it, vi } from 'vitest';
import type { SessionDirectory } from '../../application/ports/SessionDirectory.js';
import { CachingSessionDirectory } from './CachingSessionDirectory.js';

function innerDirectory() {
  const inner = {
    organizationNames: vi.fn<SessionDirectory['organizationNames']>((token) =>
      Promise.resolve(new Map([['org-a', `Acme for ${token}`]]))
    ),
    preferences: vi.fn<SessionDirectory['preferences']>(() =>
      Promise.resolve({ language: 'en', timezone: 'Europe/Madrid' })
    ),
  };
  return inner;
}

describe('CachingSessionDirectory', () => {
  it('reads the organizations and preferences of a token once within the TTL', async () => {
    const inner = innerDirectory();
    let now = 0;
    const directory = new CachingSessionDirectory(inner, { ttlMs: 60_000, now: () => now });

    await directory.organizationNames('t1');
    await directory.preferences('t1');
    now = 59_000;
    expect((await directory.organizationNames('t1')).get('org-a')).toBe('Acme for t1');
    await directory.preferences('t1');

    expect(inner.organizationNames).toHaveBeenCalledTimes(1);
    expect(inner.preferences).toHaveBeenCalledTimes(1);

    now = 60_001;
    await directory.organizationNames('t1');
    expect(inner.organizationNames).toHaveBeenCalledTimes(2);
  });

  it('keeps each token apart (never the context of another session)', async () => {
    const inner = innerDirectory();
    const directory = new CachingSessionDirectory(inner);

    const one = await directory.organizationNames('t1');
    const two = await directory.organizationNames('t2');

    expect(one.get('org-a')).toBe('Acme for t1');
    expect(two.get('org-a')).toBe('Acme for t2');
    expect(inner.organizationNames).toHaveBeenCalledTimes(2);
  });

  it('never caches a failure', async () => {
    const inner = innerDirectory();
    inner.preferences.mockRejectedValueOnce(new Error('timeout'));
    const directory = new CachingSessionDirectory(inner);

    await expect(directory.preferences('t1')).rejects.toThrow('timeout');
    await expect(directory.preferences('t1')).resolves.toEqual({
      language: 'en',
      timezone: 'Europe/Madrid',
    });
    expect(inner.preferences).toHaveBeenCalledTimes(2);
  });

  it('bounds the cache (least recently used out)', async () => {
    const inner = innerDirectory();
    const directory = new CachingSessionDirectory(inner, { maxEntries: 2 });

    await directory.organizationNames('t1');
    await directory.organizationNames('t2');
    await directory.organizationNames('t1');
    await directory.organizationNames('t3'); // evicts t2
    await directory.organizationNames('t1');
    expect(inner.organizationNames).toHaveBeenCalledTimes(3);
    await directory.organizationNames('t2');
    expect(inner.organizationNames).toHaveBeenCalledTimes(4);
  });
});
