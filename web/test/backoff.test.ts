import { describe, expect, it } from 'vitest';

import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffDelayMs } from '../src/connection/backoff.js';

describe('backoffDelayMs', () => {
  it('doubles the ceiling per attempt up to the cap', () => {
    const ceiling = (attempt: number) => backoffDelayMs(attempt, () => 1);
    expect(ceiling(1)).toBe(BACKOFF_BASE_MS);
    expect(ceiling(2)).toBe(2 * BACKOFF_BASE_MS);
    expect(ceiling(3)).toBe(4 * BACKOFF_BASE_MS);
    expect(ceiling(20)).toBe(BACKOFF_MAX_MS);
    expect(ceiling(10_000)).toBe(BACKOFF_MAX_MS);
  });

  it('jitters uniformly between zero and the ceiling', () => {
    expect(backoffDelayMs(3, () => 0)).toBe(0);
    expect(backoffDelayMs(3, () => 0.5)).toBe(BACKOFF_BASE_MS * 2);
    for (let i = 0; i < 100; i++) {
      const delay = backoffDelayMs(4);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(8 * BACKOFF_BASE_MS);
    }
  });
});
