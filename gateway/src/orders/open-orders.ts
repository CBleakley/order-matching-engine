// The resting orders of human traders, as far as order entry needs them: who
// owns each one and how much of it is left. Built from the engine snapshot and
// kept current from live events, so it needs no state of its own across a
// reconnect. Simulated traders (IDs below MIN_HUMAN_TRADER_ID) are ignored.
//
// Order entry uses it for the open-order cap and to reject cancels of orders
// that are not the session's own before they reach the engine. P1-11's
// per-trader views hold the full order state.
import type { EngineSnapshot, LiveEvent } from '../engine/engine-client.js';
import { MIN_HUMAN_TRADER_ID } from '../session/trader-ids.js';

interface RestingOrder {
  readonly traderId: number;
  remainingQty: bigint;
}

export class OpenOrderRegistry {
  readonly #orders = new Map<bigint, RestingOrder>();
  // Order IDs per trader, in the order they rested.
  readonly #byTrader = new Map<number, Set<bigint>>();

  applySnapshot(snapshot: EngineSnapshot): void {
    this.#orders.clear();
    this.#byTrader.clear();
    for (const order of snapshot.restingOrders) {
      this.#add(order.orderId, order.traderId, order.remainingQty);
    }
  }

  applyEvent(event: LiveEvent): void {
    switch (event.type) {
      case 'orderRested':
        this.#add(event.orderId, event.traderId, event.remainingQty);
        return;
      case 'trade': {
        // Only the maker was resting; a taker's remainder rests afterwards.
        const order = this.#orders.get(event.makerOrderId);
        if (order === undefined) return;
        order.remainingQty -= event.qty;
        if (order.remainingQty <= 0n) this.#remove(event.makerOrderId);
        return;
      }
      case 'orderCancelled':
        this.#remove(event.orderId);
        return;
      case 'orderAccepted':
      case 'orderRejected':
        return;
    }
  }

  isRestingFor(traderId: number, orderId: bigint): boolean {
    return this.#orders.get(orderId)?.traderId === traderId;
  }

  // The trader's resting order IDs, oldest first.
  ordersOf(traderId: number): bigint[] {
    return [...(this.#byTrader.get(traderId) ?? [])];
  }

  countOf(traderId: number): number {
    return this.#byTrader.get(traderId)?.size ?? 0;
  }

  #add(orderId: bigint, traderId: number, remainingQty: bigint): void {
    if (traderId < MIN_HUMAN_TRADER_ID || remainingQty <= 0n) return;
    this.#orders.set(orderId, { traderId, remainingQty });
    const ids = this.#byTrader.get(traderId);
    if (ids === undefined) this.#byTrader.set(traderId, new Set([orderId]));
    else ids.add(orderId);
  }

  #remove(orderId: bigint): void {
    const order = this.#orders.get(orderId);
    if (order === undefined) return;
    this.#orders.delete(orderId);
    const ids = this.#byTrader.get(order.traderId);
    ids?.delete(orderId);
    if (ids?.size === 0) this.#byTrader.delete(order.traderId);
  }
}
