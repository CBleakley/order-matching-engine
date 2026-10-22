import type { ServerMessage } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import { type AppAction, type AppState, initialState, reduce } from '../src/state/app-state.js';
import type { SubmittedOrder } from '../src/state/order-submission.js';
import { fill, order, snapshot, welcome } from './messages.js';

function applyAll(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(reduce, state);
}

function server(message: ServerMessage): AppAction {
  return { type: 'server', message };
}

const ORDER: SubmittedOrder = { clientOrderId: 'c-1', side: 'buy', qty: 100, priceTicks: 14250 };

// Connected, with nothing open, and the ticket's order just sent.
const SENT = applyAll(
  initialState,
  server(welcome()),
  server(snapshot(2, { openOrders: [], fills: [] })),
  { type: 'orderSubmitted', order: ORDER },
);

let seq = 3;
function next(): number {
  return seq++;
}

const ack = (orderId = 7, clientOrderId = 'c-1'): AppAction =>
  server({ type: 'orderAck', seq: next(), clientOrderId, orderId });

const takerFill = (orderId: number, qty: number, priceTicks: number): AppAction =>
  server({ type: 'fill', seq: next(), ...fill(orderId, { qty, priceTicks, liquidity: 'taker' }) });

const rested = (orderId: number, filledQty: number): AppAction =>
  server({
    type: 'orderUpdate',
    seq: next(),
    ...order(orderId, {
      priceTicks: 14250,
      originalQty: 100,
      filledQty,
      remainingQty: 100 - filledQty,
      status: 'resting',
    }),
  });

const filledUpdate = (orderId: number): AppAction =>
  server({
    type: 'orderUpdate',
    seq: next(),
    ...order(orderId, { originalQty: 100, filledQty: 100, remainingQty: 0, status: 'filled' }),
  });

describe('order submission', () => {
  it('starts as sending', () => {
    expect(SENT.orderSubmission).toEqual({ ...ORDER, orderId: null, outcome: { kind: 'sending' } });
  });

  it('is accepted on its ack, then resting when the order rests', () => {
    const acked = applyAll(SENT, ack());
    expect(acked.orderSubmission?.orderId).toBe(7);
    expect(acked.orderSubmission?.outcome).toEqual({ kind: 'accepted' });

    const state = applyAll(acked, rested(7, 0));
    expect(state.orderSubmission?.outcome).toEqual({
      kind: 'resting',
      fills: { qty: 0, notionalTicks: 0, multiplePrices: false },
      restingQty: 100,
    });
  });

  it('works out a partial fill whichever comes first, the ack or the fills', () => {
    const ackFirst = applyAll(SENT, ack(), takerFill(7, 40, 14251), rested(7, 40));
    const ackLast = applyAll(SENT, takerFill(7, 40, 14251), rested(7, 40), ack());
    const expected = {
      kind: 'resting',
      fills: { qty: 40, notionalTicks: 40 * 14251, multiplePrices: false },
      restingQty: 60,
    };
    expect(ackFirst.orderSubmission?.outcome).toEqual(expected);
    expect(ackLast.orderSubmission?.outcome).toEqual(expected);
  });

  it('is filled once taker fills cover the quantity, across several prices', () => {
    const state = applyAll(
      SENT,
      ack(),
      takerFill(7, 60, 14250),
      takerFill(7, 40, 14252),
      filledUpdate(7),
    );
    expect(state.orderSubmission?.outcome).toEqual({
      kind: 'filled',
      fills: { qty: 100, notionalTicks: 60 * 14250 + 40 * 14252, multiplePrices: true },
    });
  });

  it('stays accepted while only part of a sweep has arrived', () => {
    const state = applyAll(SENT, ack(), takerFill(7, 40, 14251));
    expect(state.orderSubmission?.outcome).toEqual({ kind: 'accepted' });
  });

  it('ignores fills and replies for other orders', () => {
    const state = applyAll(
      SENT,
      takerFill(6, 100, 14250),
      ack(8, 'other'),
      server({
        type: 'orderReject',
        seq: next(),
        clientOrderId: 'other',
        reason: 'priceBand',
        message: 'x',
      }),
    );
    expect(state.orderSubmission?.outcome).toEqual({ kind: 'sending' });
  });

  it('keeps a settled outcome when the resting order trades later', () => {
    const settled = applyAll(SENT, ack(), rested(7, 0));
    const later = applyAll(
      settled,
      server({ type: 'fill', seq: next(), ...fill(7, { qty: 100, liquidity: 'maker' }) }),
      filledUpdate(7),
    );
    expect(later.orderSubmission).toBe(settled.orderSubmission);
  });

  it('counts a maker fill as having rested, if the ack comes after it', () => {
    const state = applyAll(
      SENT,
      rested(7, 0),
      server({ type: 'fill', seq: next(), ...fill(7, { qty: 100, liquidity: 'maker' }) }),
      filledUpdate(7),
      ack(),
    );
    expect(state.orderSubmission?.outcome).toMatchObject({ kind: 'resting', restingQty: 100 });
  });

  it('is rejected by a matching orderReject, with the gateway message', () => {
    const state = applyAll(
      SENT,
      server({
        type: 'orderReject',
        seq: next(),
        clientOrderId: 'c-1',
        reason: 'tooManyOpenOrders',
        message: 'Too many open orders (limit 50)',
      }),
    );
    expect(state.orderSubmission?.outcome).toEqual({
      kind: 'rejected',
      reason: 'tooManyOpenOrders',
      message: 'Too many open orders (limit 50)',
    });
  });

  it('falls back to the shared reject text when the message is empty', () => {
    const state = applyAll(
      SENT,
      server({
        type: 'orderReject',
        seq: next(),
        clientOrderId: 'c-1',
        reason: 'engineUnavailable',
        message: '',
      }),
    );
    expect(state.orderSubmission?.outcome).toMatchObject({
      message: 'Trading is temporarily unavailable — try again shortly',
    });
  });

  it('is rejected when the gateway rate-limits the connection while sending', () => {
    const state = applyAll(
      SENT,
      server({ type: 'error', seq: next(), code: 'rateLimited', message: 'Slow down' }),
    );
    expect(state.orderSubmission?.outcome).toEqual({
      kind: 'rejected',
      reason: 'rateLimited',
      message: 'Slow down',
    });
    // A late ack still applies.
    expect(applyAll(state, ack()).orderSubmission?.outcome).toEqual({ kind: 'accepted' });
  });

  it('is lost when the connection resets before the outcome is known', () => {
    expect(applyAll(SENT, { type: 'reset' }).orderSubmission?.outcome).toEqual({ kind: 'lost' });
    expect(applyAll(SENT, ack(), { type: 'reset' }).orderSubmission?.outcome).toEqual({
      kind: 'lost',
    });
    // A reply can no longer arrive for it.
    const lost = applyAll(SENT, { type: 'reset' });
    expect(applyAll(lost, ack()).orderSubmission?.outcome).toEqual({ kind: 'lost' });
  });

  it('keeps a settled outcome across a reset', () => {
    const settled = applyAll(SENT, ack(), rested(7, 0));
    expect(applyAll(settled, { type: 'reset' }).orderSubmission).toBe(settled.orderSubmission);
  });

  it('a new submission replaces the last one', () => {
    const settled = applyAll(SENT, ack(), rested(7, 0));
    const order2 = { ...ORDER, clientOrderId: 'c-2' };
    const state = reduce(settled, { type: 'orderSubmitted', order: order2 });
    expect(state.orderSubmission).toEqual({
      ...order2,
      orderId: null,
      outcome: { kind: 'sending' },
    });
  });
});
