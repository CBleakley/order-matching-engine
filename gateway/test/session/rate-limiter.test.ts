import { describe, expect, it } from 'vitest';

import { SlidingWindowRateLimiter } from '../../src/session/rate-limiter.js';

function limiter(
  limit = 10,
  windowMs = 60_000,
): {
  rateLimiter: SlidingWindowRateLimiter;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const rateLimiter = new SlidingWindowRateLimiter({ limit, windowMs, now: () => now });
  return {
    rateLimiter,
    advance: (ms) => {
      now += ms;
    },
  };
}

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the limit and then denies with a retry delay', () => {
    const { rateLimiter, advance } = limiter();
    for (let i = 0; i < 10; ++i) {
      expect(rateLimiter.hit('a')).toEqual({ allowed: true });
      advance(1000);
    }
    // The first hit was 10 s ago, so it leaves the window in 50 s.
    expect(rateLimiter.hit('a')).toEqual({ allowed: false, retryAfterMs: 50_000 });
  });

  it('slides: each hit frees up when it leaves the window', () => {
    const { rateLimiter, advance } = limiter(2, 1000);
    expect(rateLimiter.hit('a').allowed).toBe(true); // t=0
    advance(600);
    expect(rateLimiter.hit('a').allowed).toBe(true); // t=600
    expect(rateLimiter.hit('a')).toEqual({ allowed: false, retryAfterMs: 400 });
    advance(399);
    expect(rateLimiter.hit('a').allowed).toBe(false); // t=999
    advance(1);
    expect(rateLimiter.hit('a').allowed).toBe(true); // t=1000: the t=0 hit has left
    expect(rateLimiter.hit('a').allowed).toBe(false);
  });

  it('does not count denied hits', () => {
    const { rateLimiter, advance } = limiter(1, 1000);
    expect(rateLimiter.hit('a').allowed).toBe(true);
    for (let i = 0; i < 5; ++i) {
      advance(100);
      expect(rateLimiter.hit('a').allowed).toBe(false);
    }
    advance(500);
    expect(rateLimiter.hit('a').allowed).toBe(true);
  });

  it('counts keys independently', () => {
    const { rateLimiter } = limiter(1);
    expect(rateLimiter.hit('a').allowed).toBe(true);
    expect(rateLimiter.hit('a').allowed).toBe(false);
    expect(rateLimiter.hit('b').allowed).toBe(true);
  });

  it('forgets idle keys', () => {
    const { rateLimiter, advance } = limiter(5, 1000);
    for (let i = 0; i < 100; ++i) {
      rateLimiter.hit(`key-${String(i)}`);
    }
    expect(rateLimiter.size).toBe(100);
    advance(1000);
    rateLimiter.hit('fresh');
    expect(rateLimiter.size).toBe(1);
  });
});
