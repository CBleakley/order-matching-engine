// In-memory token-bucket rate limiter: each key's bucket holds up to `burst`
// tokens and refills at `ratePerSecond`. Used for per-session order entry, so
// a session can send a short burst but not sustain more than the rate.
export interface TokenBucketOptions {
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly now?: () => number;
}

export type TokenBucketResult =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

// Tokens are counted in thousandths, so a refill of ratePerSecond thousandths
// per millisecond is exact integer arithmetic for integer rates and clocks.
const UNIT = 1000;

interface Bucket {
  milliTokens: number;
  updatedAt: number;
}

// Full buckets are pruned at most this often.
const PRUNE_INTERVAL_MS = 60_000;

export class TokenBucketLimiter<K = number> {
  readonly #ratePerSecond: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #buckets = new Map<K, Bucket>();
  #lastPrune: number;

  constructor(options: TokenBucketOptions) {
    this.#ratePerSecond = options.ratePerSecond;
    this.#capacity = options.burst * UNIT;
    this.#now = options.now ?? Date.now;
    this.#lastPrune = this.#now();
  }

  // The number of keys currently tracked.
  get size(): number {
    return this.#buckets.size;
  }

  // Takes one token for `key` if it has one. A denied take costs nothing.
  take(key: K): TokenBucketResult {
    const now = this.#now();
    this.#pruneAll(now);

    const bucket = this.#buckets.get(key) ?? { milliTokens: this.#capacity, updatedAt: now };
    this.#refill(bucket, now);
    if (bucket.milliTokens < UNIT) {
      this.#buckets.set(key, bucket);
      return {
        allowed: false,
        retryAfterMs: Math.ceil((UNIT - bucket.milliTokens) / this.#ratePerSecond),
      };
    }
    bucket.milliTokens -= UNIT;
    this.#buckets.set(key, bucket);
    return { allowed: true };
  }

  #refill(bucket: Bucket, now: number): void {
    // max(0, ...): a clock that steps back neither adds nor removes tokens.
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.milliTokens = Math.min(
      this.#capacity,
      bucket.milliTokens + elapsed * this.#ratePerSecond,
    );
    bucket.updatedAt = now;
  }

  // A full bucket is the same as no bucket, so it can be dropped. Memory is
  // bounded by the keys active within the refill time of a burst.
  #pruneAll(now: number): void {
    if (now - this.#lastPrune < PRUNE_INTERVAL_MS) return;
    this.#lastPrune = now;
    for (const [key, bucket] of this.#buckets) {
      this.#refill(bucket, now);
      if (bucket.milliTokens >= this.#capacity) this.#buckets.delete(key);
    }
  }
}
