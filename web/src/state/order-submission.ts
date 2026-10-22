// The viewer's most recent placeOrder from the order ticket, and what became of
// it on arrival: rejected, filled, resting, or partly filled and resting.
//
// The gateway's orderAck can arrive after the order's own fills and
// orderUpdate (it replies when the engine's OrderAccepted is handled, and the
// trades that follow it in the same read are handled first). So the outcome is
// worked out from the store's fills and open orders whenever enough is known,
// whichever order the messages came in.
import {
  type Fill,
  type OrderView,
  REJECT_REASON_TEXT,
  type RejectReason,
  type ServerMessage,
  type Side,
} from '@ome/shared';

// The part of the order that traded on arrival, as the taker.
export interface ArrivalFills {
  readonly qty: number;
  // Sum of price ticks × quantity.
  readonly notionalTicks: number;
  readonly multiplePrices: boolean;
}

export type SubmissionOutcome =
  // Sent; waiting for orderAck or orderReject.
  | { readonly kind: 'sending' }
  // Acknowledged; what happened on arrival is not known yet.
  | { readonly kind: 'accepted' }
  // Resting in the book, possibly after part of it traded on arrival.
  | { readonly kind: 'resting'; readonly fills: ArrivalFills; readonly restingQty: number }
  | { readonly kind: 'filled'; readonly fills: ArrivalFills }
  | { readonly kind: 'rejected'; readonly reason: RejectReason; readonly message: string }
  // The connection dropped before the outcome was known.
  | { readonly kind: 'lost' };

export interface SubmittedOrder {
  readonly clientOrderId: string;
  readonly side: Side;
  readonly qty: number;
  readonly priceTicks: number;
}

export interface OrderSubmission extends SubmittedOrder {
  // Set by orderAck.
  readonly orderId: number | null;
  readonly outcome: SubmissionOutcome;
}

export function newSubmission(order: SubmittedOrder): OrderSubmission {
  return { ...order, orderId: null, outcome: { kind: 'sending' } };
}

// Applies one server message, given the fills and open orders after it.
export function updateSubmission(
  submission: OrderSubmission,
  message: ServerMessage,
  fills: readonly Fill[],
  openOrders: readonly OrderView[],
): OrderSubmission {
  const awaitingReply = submission.orderId === null && submission.outcome.kind !== 'lost';
  switch (message.type) {
    case 'orderAck':
      if (!awaitingReply || message.clientOrderId !== submission.clientOrderId) return submission;
      return settle(
        { ...submission, orderId: message.orderId, outcome: { kind: 'accepted' } },
        fills,
        openOrders,
      );
    case 'orderReject':
      if (!awaitingReply || message.clientOrderId !== submission.clientOrderId) return submission;
      return rejected(submission, message.reason, message.message);
    case 'error':
      // The gateway drops a rate-limited frame without an orderReject, so the
      // order is assumed lost. A later reply for it still applies.
      if (message.code !== 'rateLimited' || submission.outcome.kind !== 'sending') {
        return submission;
      }
      return rejected(submission, 'rateLimited', message.message);
    case 'fill':
    case 'orderUpdate':
    case 'snapshot':
      return settle(submission, fills, openOrders);
    default:
      return submission;
  }
}

// After a disconnect, an order still waiting for its outcome is reported lost.
export function loseSubmission(submission: OrderSubmission | null): OrderSubmission | null {
  if (submission === null) return null;
  const { kind } = submission.outcome;
  return kind === 'sending' || kind === 'accepted'
    ? { ...submission, outcome: { kind: 'lost' } }
    : submission;
}

function rejected(
  submission: OrderSubmission,
  reason: RejectReason,
  message: string,
): OrderSubmission {
  return {
    ...submission,
    outcome: {
      kind: 'rejected',
      reason,
      message: message === '' ? REJECT_REASON_TEXT[reason] : message,
    },
  };
}

// An acknowledged order is filled once its taker fills cover its quantity, and
// resting once it is in the open orders (OrderRested follows all of its
// arrival trades) or has traded as a maker. Until then it stays `accepted`.
function settle(
  submission: OrderSubmission,
  fills: readonly Fill[],
  openOrders: readonly OrderView[],
): OrderSubmission {
  const { orderId } = submission;
  if (submission.outcome.kind !== 'accepted' || orderId === null) return submission;

  let qty = 0;
  let notionalTicks = 0;
  let firstPrice: number | null = null;
  let multiplePrices = false;
  let tradedAsMaker = false;
  for (const fill of fills) {
    if (fill.orderId !== orderId) continue;
    if (fill.liquidity === 'maker') {
      tradedAsMaker = true;
      continue;
    }
    qty += fill.qty;
    // At most maxPriceTicks × maxOrderQty, which the instrument keeps below 2^53.
    notionalTicks += fill.priceTicks * fill.qty;
    firstPrice ??= fill.priceTicks;
    if (fill.priceTicks !== firstPrice) multiplePrices = true;
  }
  const arrival: ArrivalFills = { qty, notionalTicks, multiplePrices };

  if (qty >= submission.qty) {
    return { ...submission, outcome: { kind: 'filled', fills: arrival } };
  }
  if (tradedAsMaker || openOrders.some((order) => order.orderId === orderId)) {
    return {
      ...submission,
      outcome: { kind: 'resting', fills: arrival, restingQty: submission.qty - qty },
    };
  }
  return submission;
}
