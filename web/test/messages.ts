// Builders for valid gateway messages, shared by the store and client tests.
import {
  type CandleBar,
  type Fill,
  INSTRUMENT,
  type OrderView,
  type Position,
  type ServerMessageOf,
  type Stats,
} from '@ome/shared';

export function bar(start: number, close = 14250, overrides: Partial<CandleBar> = {}): CandleBar {
  return {
    start,
    open: close,
    high: close,
    low: close,
    close,
    volume: 10,
    trades: 1,
    ...overrides,
  };
}

export function order(orderId: number, overrides: Partial<OrderView> = {}): OrderView {
  return {
    orderId,
    side: 'buy',
    priceTicks: 14200,
    originalQty: 10,
    filledQty: 0,
    remainingQty: 10,
    status: 'resting',
    placedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function fill(orderId: number, overrides: Partial<Fill> = {}): Fill {
  return {
    orderId,
    side: 'buy',
    priceTicks: 14250,
    qty: 5,
    time: 1_700_000_000_000,
    liquidity: 'maker',
    ...overrides,
  };
}

export const STATS: Stats = { last: 14250, open: 14000, high: 14300, low: 13900, change: 250 };

export const POSITION: Position = {
  netQty: 5,
  cashTicks: -71250,
  pnlAtLastTicks: 0,
  fillCount: 1,
  openOrderCount: 1,
};

export function welcome(seq = 1): ServerMessageOf<'welcome'> {
  return {
    type: 'welcome',
    seq,
    you: { traderId: 1_000_001, name: 'Ada' },
    instrument: { ...INSTRUMENT },
    serverTime: 1_700_000_000_000,
  };
}

export function snapshot(
  seq = 2,
  overrides: Partial<ServerMessageOf<'snapshot'>> = {},
): ServerMessageOf<'snapshot'> {
  return {
    type: 'snapshot',
    seq,
    interval: '15s',
    candles: [bar(15_000), bar(30_000)],
    stats: STATS,
    openOrders: [order(1)],
    fills: [fill(1)],
    position: POSITION,
    ...overrides,
  };
}
