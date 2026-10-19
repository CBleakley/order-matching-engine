// The browser's view of the market and the viewer's session, built from the
// gateway's messages (shared/PROTOCOL.md). Everything here is pure: the
// GatewayClient dispatches actions and `reduce` computes the next state.
import type {
  CandleBar,
  Fill,
  InstrumentConfig,
  Interval,
  OrderView,
  Position,
  RejectReason,
  ServerMessage,
  Stats,
} from '@ome/shared';

export type ConnectionStatus =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting' }
  | { readonly kind: 'live' }
  | { readonly kind: 'reconnecting'; readonly attempt: number }
  | { readonly kind: 'offline' };

// Replies to the viewer's own order requests, shown briefly by the order
// ticket. `id` increases with every new piece of feedback, so the UI can tell
// two identical rejects apart.
export type OrderFeedback =
  | {
      readonly id: number;
      readonly kind: 'ack';
      readonly clientOrderId: string;
      readonly orderId: number;
    }
  | {
      readonly id: number;
      readonly kind: 'reject';
      // Exactly one is set: clientOrderId for a placeOrder, orderId for a cancel.
      readonly clientOrderId: string | null;
      readonly orderId: number | null;
      readonly reason: RejectReason;
      readonly message: string;
    }
  | { readonly id: number; readonly kind: 'rateLimited'; readonly message: string };

export interface Me {
  readonly traderId: number;
  readonly name: string;
}

export interface AppState {
  readonly connection: ConnectionStatus;
  // Set when the gateway rejected the session token; the join screen (P1-16) takes over.
  readonly sessionExpired: boolean;
  readonly me: Me | null;
  readonly instrument: InstrumentConfig | null;
  readonly interval: Interval | null;
  // Oldest first, unique by `start`.
  readonly candles: readonly CandleBar[];
  readonly stats: Stats | null;
  // The viewer's resting orders, in the order the gateway reported them.
  readonly openOrders: readonly OrderView[];
  // Newest first.
  readonly fills: readonly Fill[];
  readonly position: Position | null;
  readonly orderFeedback: OrderFeedback | null;
  // The id of the last OrderFeedback; survives `reset` so ids never repeat.
  readonly lastFeedbackId: number;
}

// Snapshots carry the gateway's recent fills; live fills are prepended. This
// bounds memory on a page left open for days.
export const MAX_FILLS = 500;

export const initialState: AppState = {
  connection: { kind: 'idle' },
  sessionExpired: false,
  me: null,
  instrument: null,
  interval: null,
  candles: [],
  stats: null,
  openOrders: [],
  fills: [],
  position: null,
  orderFeedback: null,
  lastFeedbackId: 0,
};

export type AppAction =
  | { readonly type: 'server'; readonly message: ServerMessage }
  | { readonly type: 'connecting' }
  | { readonly type: 'reconnecting'; readonly attempt: number }
  | { readonly type: 'offline' }
  | { readonly type: 'sessionExpired' }
  // Discards everything learned from the gateway, ahead of a fresh snapshot.
  | { readonly type: 'reset' }
  | { readonly type: 'dismissOrderFeedback' };

export function reduce(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'server':
      return applyServerMessage(state, action.message);
    case 'connecting':
      return { ...state, connection: { kind: 'connecting' }, sessionExpired: false };
    case 'reconnecting':
      return { ...state, connection: { kind: 'reconnecting', attempt: action.attempt } };
    case 'offline':
      return state.connection.kind === 'offline'
        ? state
        : { ...state, connection: { kind: 'offline' } };
    case 'sessionExpired':
      return { ...state, sessionExpired: true };
    case 'reset':
      return {
        ...initialState,
        connection: state.connection,
        sessionExpired: state.sessionExpired,
        lastFeedbackId: state.lastFeedbackId,
      };
    case 'dismissOrderFeedback':
      return state.orderFeedback === null ? state : { ...state, orderFeedback: null };
  }
}

export function applyServerMessage(state: AppState, message: ServerMessage): AppState {
  switch (message.type) {
    case 'welcome':
      return {
        ...state,
        me: { traderId: message.you.traderId, name: message.you.name },
        instrument: Object.freeze({ ...message.instrument }),
      };
    case 'snapshot':
      return {
        ...state,
        connection: { kind: 'live' },
        interval: message.interval,
        candles: message.candles,
        stats: message.stats,
        openOrders: message.openOrders,
        fills: message.fills.slice(0, MAX_FILLS),
        position: message.position,
      };
    case 'candles':
      // Bars for an interval the viewer has just switched away from.
      if (message.interval !== state.interval) return state;
      return { ...state, candles: mergeBars(state.candles, message.bars) };
    case 'stats':
      return {
        ...state,
        stats: {
          last: message.last,
          open: message.open,
          high: message.high,
          low: message.low,
          change: message.change,
        },
      };
    case 'position':
      return {
        ...state,
        position: {
          netQty: message.netQty,
          cashTicks: message.cashTicks,
          pnlAtLastTicks: message.pnlAtLastTicks,
          fillCount: message.fillCount,
          openOrderCount: message.openOrderCount,
        },
      };
    case 'orderUpdate': {
      const order: OrderView = {
        orderId: message.orderId,
        side: message.side,
        priceTicks: message.priceTicks,
        originalQty: message.originalQty,
        filledQty: message.filledQty,
        remainingQty: message.remainingQty,
        status: message.status,
        placedAt: message.placedAt,
      };
      return { ...state, openOrders: upsertOpenOrder(state.openOrders, order) };
    }
    case 'fill': {
      const fill: Fill = {
        orderId: message.orderId,
        side: message.side,
        priceTicks: message.priceTicks,
        qty: message.qty,
        time: message.time,
        liquidity: message.liquidity,
      };
      return { ...state, fills: [fill, ...state.fills.slice(0, MAX_FILLS - 1)] };
    }
    case 'orderAck':
      return withFeedback(state, {
        kind: 'ack',
        clientOrderId: message.clientOrderId,
        orderId: message.orderId,
      });
    case 'orderReject':
      return withFeedback(state, {
        kind: 'reject',
        clientOrderId: message.clientOrderId ?? null,
        orderId: message.orderId ?? null,
        reason: message.reason,
        message: message.message,
      });
    case 'error':
      // sessionExpired and authRequired end the connection; the client handles
      // them. badMessage means this build sent something wrong: nothing to show.
      return message.code === 'rateLimited'
        ? withFeedback(state, { kind: 'rateLimited', message: message.message })
        : state;
    case 'pong':
      return state;
  }
}

// Distributes Omit over the union, so each variant keeps its own fields.
type FeedbackWithoutId = OrderFeedback extends infer F
  ? F extends OrderFeedback
    ? Omit<F, 'id'>
    : never
  : never;

function withFeedback(state: AppState, feedback: FeedbackWithoutId): AppState {
  const id = state.lastFeedbackId + 1;
  return { ...state, orderFeedback: { ...feedback, id }, lastFeedbackId: id };
}

// Merges updated bars into `bars` by `start`: a known start is replaced, a
// newer one appended, and an older unknown one inserted in order.
export function mergeBars(
  bars: readonly CandleBar[],
  updates: readonly CandleBar[],
): readonly CandleBar[] {
  if (updates.length === 0) return bars;
  const merged = bars.slice();
  for (const bar of updates) {
    // Updates almost always touch the newest bar, so search from the end.
    let index = merged.length;
    while (index > 0 && (merged[index - 1]?.start ?? 0) > bar.start) index--;
    if (index > 0 && merged[index - 1]?.start === bar.start) {
      merged[index - 1] = bar;
    } else {
      merged.splice(index, 0, bar);
    }
  }
  return merged;
}

// A resting order is added or replaced; any other status leaves the list.
function upsertOpenOrder(orders: readonly OrderView[], order: OrderView): readonly OrderView[] {
  const index = orders.findIndex((o) => o.orderId === order.orderId);
  if (order.status !== 'resting') {
    return index === -1 ? orders : orders.filter((o) => o.orderId !== order.orderId);
  }
  if (index === -1) return [...orders, order];
  return orders.map((o, i) => (i === index ? order : o));
}

// The header pill's text for a connection status.
export function connectionLabel(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'live':
      return 'LIVE';
    case 'connecting':
      return 'CONNECTING';
    case 'reconnecting':
      return `RECONNECTING (${String(status.attempt)})`;
    case 'idle':
    case 'offline':
      return 'OFFLINE';
  }
}
