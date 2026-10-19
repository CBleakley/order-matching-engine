import { INSTRUMENT, type ServerMessage } from '@ome/shared';
import { describe, expect, it } from 'vitest';

import {
  type AppAction,
  type AppState,
  applyServerMessage,
  connectionLabel,
  initialState,
  MAX_FILLS,
  mergeBars,
  reduce,
} from '../src/state/app-state.js';
import { bar, fill, order, POSITION, snapshot, STATS, welcome } from './messages.js';

function applyAll(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(reduce, state);
}

function server(message: ServerMessage): AppAction {
  return { type: 'server', message };
}

// A connected state: welcome and the default snapshot applied.
const LIVE = applyAll(initialState, server(welcome()), server(snapshot()));

describe('applyServerMessage', () => {
  it('welcome records the viewer and the instrument', () => {
    const state = applyServerMessage(initialState, welcome());
    expect(state.me).toEqual({ traderId: 1_000_001, name: 'Ada' });
    expect(state.instrument).toEqual(INSTRUMENT);
  });

  it('snapshot replaces all market and order state and goes live', () => {
    const stale: AppState = {
      ...LIVE,
      candles: [bar(0), bar(5_000), bar(10_000)],
      openOrders: [order(7), order(8)],
      fills: [fill(7), fill(8)],
      stats: { last: null, open: null, high: null, low: null, change: null },
      connection: { kind: 'reconnecting', attempt: 2 },
    };
    const next = snapshot(2, {
      interval: '1m',
      candles: [bar(60_000)],
      openOrders: [],
      fills: [fill(9)],
    });
    const state = applyServerMessage(stale, next);
    expect(state.connection).toEqual({ kind: 'live' });
    expect(state.interval).toBe('1m');
    expect(state.candles).toEqual([bar(60_000)]);
    expect(state.openOrders).toEqual([]);
    expect(state.fills).toEqual([fill(9)]);
    expect(state.stats).toEqual(STATS);
    expect(state.position).toEqual(POSITION);
  });

  it('snapshot keeps at most MAX_FILLS fills', () => {
    const fills = Array.from({ length: MAX_FILLS + 5 }, (_, i) => fill(i + 1));
    const state = applyServerMessage(initialState, snapshot(2, { fills }));
    expect(state.fills).toHaveLength(MAX_FILLS);
    expect(state.fills[0]).toEqual(fill(1));
  });

  it('candles merges bars for the current interval', () => {
    const updated = bar(30_000, 14300, { volume: 20, trades: 2 });
    const state = applyServerMessage(LIVE, {
      type: 'candles',
      seq: 3,
      interval: '15s',
      bars: [updated, bar(45_000)],
    });
    expect(state.candles).toEqual([bar(15_000), updated, bar(45_000)]);
  });

  it('candles for another interval are ignored', () => {
    const state = applyServerMessage(LIVE, {
      type: 'candles',
      seq: 3,
      interval: '1m',
      bars: [bar(60_000)],
    });
    expect(state).toBe(LIVE);
  });

  it('stats and position replace the previous values without type or seq', () => {
    const stats = { last: 14400, open: 14000, high: 14400, low: 13900, change: 400 };
    const position = { ...POSITION, netQty: -3, fillCount: 4 };
    const state = applyAll(
      LIVE,
      server({ type: 'stats', seq: 3, ...stats }),
      server({ type: 'position', seq: 4, ...position }),
    );
    expect(state.stats).toEqual(stats);
    expect(state.position).toEqual(position);
  });

  it('orderUpdate adds and replaces resting orders', () => {
    const added = applyServerMessage(LIVE, { type: 'orderUpdate', seq: 3, ...order(2) });
    expect(added.openOrders).toEqual([order(1), order(2)]);

    const partial = order(1, { filledQty: 4, remainingQty: 6 });
    const replaced = applyServerMessage(added, { type: 'orderUpdate', seq: 4, ...partial });
    expect(replaced.openOrders).toEqual([partial, order(2)]);
  });

  it.each(['filled', 'cancelled'] as const)('orderUpdate %s removes the order', (status) => {
    const state = applyServerMessage(LIVE, {
      type: 'orderUpdate',
      seq: 3,
      ...order(1, { status }),
    });
    expect(state.openOrders).toEqual([]);
  });

  it('orderUpdate for an order filled on arrival leaves the list unchanged', () => {
    const state = applyServerMessage(LIVE, {
      type: 'orderUpdate',
      seq: 3,
      ...order(5, { status: 'filled', filledQty: 10, remainingQty: 0 }),
    });
    expect(state.openOrders).toBe(LIVE.openOrders);
  });

  it('fill is prepended and the list stays bounded', () => {
    const state = applyServerMessage(LIVE, { type: 'fill', seq: 3, ...fill(2) });
    expect(state.fills).toEqual([fill(2), fill(1)]);

    const full = { ...LIVE, fills: Array.from({ length: MAX_FILLS }, (_, i) => fill(i + 1)) };
    const capped = applyServerMessage(full, { type: 'fill', seq: 3, ...fill(999) });
    expect(capped.fills).toHaveLength(MAX_FILLS);
    expect(capped.fills[0]).toEqual(fill(999));
    expect(capped.fills.at(-1)).toEqual(fill(MAX_FILLS - 1));
  });

  it('orderAck and orderReject set feedback with increasing ids', () => {
    const acked = applyServerMessage(LIVE, {
      type: 'orderAck',
      seq: 3,
      clientOrderId: 'c-1',
      orderId: 10,
    });
    expect(acked.orderFeedback).toEqual({ id: 1, kind: 'ack', clientOrderId: 'c-1', orderId: 10 });

    const rejected = applyServerMessage(acked, {
      type: 'orderReject',
      seq: 4,
      orderId: 10,
      reason: 'unknownOrder',
      message: 'Unknown order',
    });
    expect(rejected.orderFeedback).toEqual({
      id: 2,
      kind: 'reject',
      clientOrderId: null,
      orderId: 10,
      reason: 'unknownOrder',
      message: 'Unknown order',
    });

    const placeRejected = applyServerMessage(rejected, {
      type: 'orderReject',
      seq: 5,
      clientOrderId: 'c-2',
      reason: 'priceBand',
      message: 'Too far',
    });
    expect(placeRejected.orderFeedback).toMatchObject({
      id: 3,
      clientOrderId: 'c-2',
      orderId: null,
    });
  });

  it('error rateLimited sets feedback; other errors change nothing', () => {
    const limited = applyServerMessage(LIVE, {
      type: 'error',
      seq: 3,
      code: 'rateLimited',
      message: 'Slow down',
    });
    expect(limited.orderFeedback).toEqual({ id: 1, kind: 'rateLimited', message: 'Slow down' });

    for (const code of ['badMessage', 'authRequired', 'sessionExpired'] as const) {
      expect(applyServerMessage(LIVE, { type: 'error', seq: 3, code, message: 'x' })).toBe(LIVE);
    }
  });

  it('pong changes nothing', () => {
    expect(applyServerMessage(LIVE, { type: 'pong', seq: 3 })).toBe(LIVE);
  });
});

describe('reduce', () => {
  it('reset discards gateway data but keeps connection, expiry and feedback ids', () => {
    const withFeedback = applyServerMessage(
      { ...LIVE, connection: { kind: 'reconnecting', attempt: 1 } },
      { type: 'orderAck', seq: 3, clientOrderId: 'c-1', orderId: 10 },
    );
    const state = reduce(withFeedback, { type: 'reset' });
    expect(state).toEqual({
      ...initialState,
      connection: { kind: 'reconnecting', attempt: 1 },
      lastFeedbackId: 1,
    });
  });

  it('a snapshot after reset rebuilds the state', () => {
    const state = applyAll(LIVE, { type: 'reset' }, server(welcome()), server(snapshot()));
    expect(state).toEqual(LIVE);
  });

  it('tracks connection status and session expiry', () => {
    const expired = applyAll(initialState, { type: 'sessionExpired' }, { type: 'offline' });
    expect(expired.sessionExpired).toBe(true);
    expect(expired.connection).toEqual({ kind: 'offline' });

    const rejoined = reduce(expired, { type: 'connecting' });
    expect(rejoined.sessionExpired).toBe(false);
    expect(rejoined.connection).toEqual({ kind: 'connecting' });

    expect(reduce(rejoined, { type: 'reconnecting', attempt: 3 }).connection).toEqual({
      kind: 'reconnecting',
      attempt: 3,
    });
  });

  it('dismissOrderFeedback clears feedback, and is a no-op without any', () => {
    const acked = applyServerMessage(LIVE, {
      type: 'orderAck',
      seq: 3,
      clientOrderId: 'c-1',
      orderId: 10,
    });
    expect(reduce(acked, { type: 'dismissOrderFeedback' }).orderFeedback).toBeNull();
    expect(reduce(LIVE, { type: 'dismissOrderFeedback' })).toBe(LIVE);
  });
});

describe('mergeBars', () => {
  it('replaces, appends and inserts in start order', () => {
    const merged = mergeBars(
      [bar(10_000), bar(30_000)],
      [bar(50_000), bar(30_000, 1), bar(0), bar(20_000)],
    );
    expect(merged).toEqual([bar(0), bar(10_000), bar(20_000), bar(30_000, 1), bar(50_000)]);
  });

  it('returns the same array when there are no updates', () => {
    const bars = [bar(0)];
    expect(mergeBars(bars, [])).toBe(bars);
  });
});

describe('connectionLabel', () => {
  it('names every status', () => {
    expect(connectionLabel({ kind: 'idle' })).toBe('OFFLINE');
    expect(connectionLabel({ kind: 'connecting' })).toBe('CONNECTING');
    expect(connectionLabel({ kind: 'live' })).toBe('LIVE');
    expect(connectionLabel({ kind: 'reconnecting', attempt: 2 })).toBe('RECONNECTING (2)');
    expect(connectionLabel({ kind: 'offline' })).toBe('OFFLINE');
  });
});
