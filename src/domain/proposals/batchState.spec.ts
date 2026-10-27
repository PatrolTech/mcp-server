import { describe, expect, it } from 'vitest';
import { batchStateOf } from './batchState.js';

describe('batchStateOf', () => {
  it.each([
    [['proposed', 'proposed'], 'pending'],
    [['executed', 'proposed'], 'pending'],
    [['executed', 'executing', 'cancelled'], 'in_progress'],
    [['executed', 'failed'], 'done'],
    [['executed', 'cancelled'], 'done'],
    [['expired', 'expired'], 'expired'],
    [['cancelled', 'cancelled'], 'withdrawn'],
    [['cancelled', 'expired'], 'expired'],
  ] as const)('%j is %s', (statuses, state) => {
    expect(batchStateOf(statuses)).toBe(state);
  });
});
