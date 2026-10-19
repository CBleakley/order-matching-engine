// Why the gateway rejected an order or cancel (`orderReject.reason`), and the
// text the order ticket shows for each. The gateway's `orderReject.message`
// may add specifics (e.g. the configured limit); this text is the fallback
// that needs no server configuration.
import { z } from 'zod';

export const REJECT_REASONS = [
  'priceOutOfRange',
  'qtyOutOfRange',
  'priceBand',
  'tooManyOpenOrders',
  'rateLimited',
  'duplicateClientOrderId',
  'unknownOrder',
  'notOwner',
  'engineUnavailable',
  'internal',
] as const;

export const rejectReasonSchema = z.enum(REJECT_REASONS);

export type RejectReason = z.infer<typeof rejectReasonSchema>;

export const REJECT_REASON_TEXT: Readonly<Record<RejectReason, string>> = Object.freeze({
  priceOutOfRange: 'Price is outside the allowed range',
  qtyOutOfRange: 'Quantity is outside the allowed range',
  priceBand: 'Price is too far from the last trade',
  tooManyOpenOrders: 'Too many open orders',
  rateLimited: 'Slow down — order rate limit reached',
  duplicateClientOrderId: 'This order was already submitted',
  unknownOrder: 'Order is no longer open',
  notOwner: 'You can only cancel your own orders',
  engineUnavailable: 'Trading is temporarily unavailable — try again shortly',
  internal: 'Order could not be processed',
});
