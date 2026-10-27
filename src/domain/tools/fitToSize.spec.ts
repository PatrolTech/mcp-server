import { describe, expect, it } from 'vitest';
import { fitToSize } from './fitToSize.js';

const measure = (value: unknown): number => JSON.stringify(value).length;

describe('fitToSize', () => {
  it('returns the value untouched when it already fits', () => {
    const data = { items: [1, 2, 3] };
    expect(fitToSize(data, { maxSize: 1000, measure })).toEqual({ value: data, truncated: false });
  });

  it('trims the largest array from its end until the value fits', () => {
    const data = {
      small: ['a', 'b'],
      big: Array.from({ length: 200 }, (_, n) => ({ n, text: 'x'.repeat(100) })),
    };
    const { value, truncated } = fitToSize(data, { maxSize: 5000, measure });
    expect(truncated).toBe(true);
    expect(value).not.toBeNull();
    expect(measure(value)).toBeLessThanOrEqual(5000);
    expect(value?.small).toEqual(['a', 'b']);
    // Keeps the first items (lists come sorted by relevance) and as many as fit.
    expect(value?.big[0]).toEqual(data.big[0]);
    expect(value?.big.length).toBeGreaterThan(30);
    // Does not mutate the input.
    expect(data.big).toHaveLength(200);
  });

  it('trims a root-level array, measuring with the caller’s own overhead', () => {
    const data = Array.from({ length: 50 }, () => 'y'.repeat(200));
    const withOverhead = (v: unknown) => measure({ data: v, note: 'n'.repeat(100) });
    const { value, truncated } = fitToSize(data, { maxSize: 2000, measure: withOverhead });
    expect(truncated).toBe(true);
    expect(withOverhead(value)).toBeLessThanOrEqual(2000);
  });

  it('gives up with null when nothing left to trim still does not fit', () => {
    const data = { text: 'z'.repeat(5000) };
    expect(fitToSize(data, { maxSize: 100, measure })).toEqual({ value: null, truncated: true });
  });
});
