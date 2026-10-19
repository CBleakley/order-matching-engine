// In-memory sliding-window rate limiter: at most `limit` hits per key in any
// `windowMs` window. State lives in this process only, which is fine for a
// single gateway.
export interface RateLimiterOptions {
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

export type RateLimitResult =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

export class SlidingWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  // Hit times per key, oldest first. A key's array is never empty.
  readonly #hits = new Map<string, number[]>();
  #lastPrune: number;

  constructor(options: RateLimiterOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
    this.#lastPrune = this.#now();
  }

  // The number of keys currently tracked.
  get size(): number {
    return this.#hits.size;
  }

  // Records a hit for `key` if it is within the limit. Denied hits are not
  // recorded, so a client that keeps retrying is not locked out for longer.
  hit(key: string): RateLimitResult {
    const now = this.#now();
    this.#pruneAll(now);

    const hits = this.#hits.get(key) ?? [];
    const cutoff = now - this.#windowMs;
    while (hits.length > 0 && (hits[0] ?? now) <= cutoff) {
      hits.shift();
    }
    if (hits.length >= this.#limit) {
      const oldest = hits[0] ?? now;
      return { allowed: false, retryAfterMs: oldest + this.#windowMs - now };
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return { allowed: true };
  }

  // Drops keys with no hits inside the window, at most once per window, so
  // memory is bounded by the keys active in the last two windows.
  #pruneAll(now: number): void {
    if (now - this.#lastPrune < this.#windowMs) {
      return;
    }
    this.#lastPrune = now;
    const cutoff = now - this.#windowMs;
    for (const [key, hits] of this.#hits) {
      const newest = hits[hits.length - 1];
      if (newest === undefined || newest <= cutoff) {
        this.#hits.delete(key);
      }
    }
  }
}
