// The order ticket's status line for its latest submission.
import { formatQty, ticksToDecimalString } from '@ome/shared';

import type { ArrivalFills, OrderSubmission } from '../state/order-submission.js';

export interface SubmissionText {
  readonly tone: 'info' | 'error';
  readonly text: string;
}

export function submissionText(submission: OrderSubmission, decimals: number): SubmissionText {
  const price = (ticks: number) => ticksToDecimalString(ticks, { priceDecimals: decimals });
  // "at 142.51", or "at avg 142.51" when the fills were at several prices.
  const filledAt = (fills: ArrivalFills) =>
    `at ${fills.multiplePrices ? 'avg ' : ''}${price(Math.round(fills.notionalTicks / fills.qty))}`;
  const name = `Order #${String(submission.orderId ?? '')}`;
  const { outcome } = submission;

  switch (outcome.kind) {
    case 'sending':
      return { tone: 'info', text: 'Sending order…' };
    case 'accepted':
      return { tone: 'info', text: `${name} accepted` };
    case 'resting':
      if (outcome.fills.qty === 0) {
        return {
          tone: 'info',
          text: `${name} resting: ${formatQty(outcome.restingQty)} @ ${price(submission.priceTicks)}`,
        };
      }
      return {
        tone: 'info',
        text:
          `${name}: ${formatQty(outcome.fills.qty)} filled ${filledAt(outcome.fills)}, ` +
          `${formatQty(outcome.restingQty)} resting at ${price(submission.priceTicks)}`,
      };
    case 'filled':
      return {
        tone: 'info',
        text: `${name} filled: ${formatQty(outcome.fills.qty)} ${filledAt(outcome.fills)}`,
      };
    case 'rejected':
      return { tone: 'error', text: outcome.message };
    case 'lost':
      return {
        tone: 'error',
        text: 'Connection lost before the order was confirmed. Check your pending orders once reconnected.',
      };
  }
}
