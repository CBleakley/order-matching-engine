// Trader IDs known to the gateway, and allocation of fresh human trader IDs.
//
// Tokens are stateless, so the gateway cannot list every ID it has ever
// issued (it may have restarted since). It learns IDs from three sources: the
// ones it issues, the ones the engine reports (snapshot and live events), and
// the ones in tokens that verify. A new ID is re-drawn if it collides with any
// of them. The set is not cleared when the engine restarts; keeping stale IDs
// only makes allocation more conservative.
import { randomInt } from 'node:crypto';

import type { EngineSnapshot, LiveEvent } from '../engine/engine-client.js';

// Human trader IDs are in [1_000_000, 2^31); simulated traders are below 1,000.
export const MIN_HUMAN_TRADER_ID = 1_000_000;
export const MAX_HUMAN_TRADER_ID = 2 ** 31 - 1;

export const MAX_ALLOCATION_ATTEMPTS = 32;

// Returns an integer in [min, max).
export type RandomInt = (min: number, max: number) => number;

export class TraderIdExhaustedError extends Error {
  override readonly name = 'TraderIdExhaustedError';
}

export class TraderIdRegistry {
  readonly #known = new Set<number>();
  readonly #randomInt: RandomInt;

  constructor(randomIntFn: RandomInt = randomInt) {
    this.#randomInt = randomIntFn;
  }

  get size(): number {
    return this.#known.size;
  }

  has(traderId: number): boolean {
    return this.#known.has(traderId);
  }

  add(traderId: number): void {
    this.#known.add(traderId);
  }

  addSnapshot(snapshot: EngineSnapshot): void {
    for (const order of snapshot.restingOrders) {
      this.add(order.traderId);
    }
    for (const trade of snapshot.trades) {
      this.add(trade.buyerTraderId);
      this.add(trade.sellerTraderId);
    }
  }

  addEvent(event: LiveEvent): void {
    if (event.type === 'trade') {
      this.add(event.buyerTraderId);
      this.add(event.sellerTraderId);
    } else {
      this.add(event.traderId);
    }
  }

  // Draws an unused human trader ID and records it as known.
  allocate(): number {
    for (let attempt = 0; attempt < MAX_ALLOCATION_ATTEMPTS; ++attempt) {
      const candidate = this.#randomInt(MIN_HUMAN_TRADER_ID, MAX_HUMAN_TRADER_ID + 1);
      if (!this.#known.has(candidate)) {
        this.#known.add(candidate);
        return candidate;
      }
    }
    throw new TraderIdExhaustedError(
      `no free trader ID after ${String(MAX_ALLOCATION_ATTEMPTS)} attempts`,
    );
  }
}
