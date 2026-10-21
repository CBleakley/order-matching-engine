import { describe, expect, it } from 'vitest';

import { TokenBucketLimiter } from '../../src/session/token-bucket.js';

function limiter(ratePerSecond = 10, burst = 20) {
  const clock = { now: 1_000_000 };
  const bucket = new TokenBucketLimiter({ ratePerSecond, burst, now: () => clock.now });
  return { bucket, clock };
}

function takeMany(bucket: TokenBucketLimiter, key: number, n: number): number {
  let allowed = 0;
  for (let i = 0; i < n; ++i) if (bucket.take(key).allowed) allowed += 1;
  return allowed;
}

describe('TokenBucketLimiter', () => {
  it('allows a full burst, then refuses with a retry time', () => {
    const { bucket } = limiter();
    expect(takeMany(bucket, 1, 20)).toBe(20);
    expect(bucket.take(1)).toEqual({ allowed: false, retryAfterMs: 100 });
  });

  it('refills at the configured rate', () => {
    const { bucket, clock } = limiter();
    takeMany(bucket, 1, 20);
    clock.now += 250;
    expect(takeMany(bucket, 1, 10)).toBe(2);
    clock.now += 1000;
    expect(takeMany(bucket, 1, 30)).toBe(10);
  });

  it('never refills beyond the burst', () => {
    const { bucket, clock } = limiter();
    clock.now += 3_600_000;
    expect(takeMany(bucket, 1, 30)).toBe(20);
  });

  it('sustains the rate and no more', () => {
    const { bucket, clock } = limiter(10, 20);
    takeMany(bucket, 1, 20);
    let allowed = 0;
    for (let ms = 0; ms < 10_000; ms += 10) {
      clock.now += 10;
      if (bucket.take(1).allowed) allowed += 1;
    }
    expect(allowed).toBe(100);
  });

  it('keeps keys independent', () => {
    const { bucket } = limiter(1, 2);
    expect(takeMany(bucket, 1, 5)).toBe(2);
    expect(takeMany(bucket, 2, 5)).toBe(2);
  });

  it('prunes full buckets', () => {
    const { bucket, clock } = limiter(10, 20);
    bucket.take(1);
    bucket.take(2);
    expect(bucket.size).toBe(2);
    clock.now += 61_000;
    bucket.take(3);
    expect(bucket.size).toBe(1);
  });

  it('ignores a clock that steps back', () => {
    const { bucket, clock } = limiter(10, 2);
    takeMany(bucket, 1, 2);
    clock.now -= 10_000;
    expect(bucket.take(1).allowed).toBe(false);
  });
});
