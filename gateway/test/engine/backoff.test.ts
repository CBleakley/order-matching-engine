import { describe, expect, it } from 'vitest';

import { backoffDelay } from '../../src/engine/backoff.js';

const OPTIONS = { initialMs: 100, maxMs: 5000 };

describe('backoffDelay', () => {
  it('doubles the ceiling with each attempt', () => {
    const almostOne = () => 0.999_999;
    expect([0, 1, 2, 3, 4].map((n) => backoffDelay(n, OPTIONS, almostOne))).toEqual([
      99, 199, 399, 799, 1599,
    ]);
  });

  it('caps the ceiling at maxMs, even for huge attempt counts', () => {
    expect(backoffDelay(6, OPTIONS, () => 0.999_999)).toBe(4999);
    expect(backoffDelay(10_000, OPTIONS, () => 0.999_999)).toBe(4999);
  });

  it('scales the ceiling by the random value', () => {
    expect(backoffDelay(2, OPTIONS, () => 0)).toBe(0);
    expect(backoffDelay(2, OPTIONS, () => 0.5)).toBe(200);
  });

  it('stays within [0, ceiling) with Math.random', () => {
    for (let i = 0; i < 1000; i++) {
      const delay = backoffDelay(3, OPTIONS);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(800);
    }
  });
});
