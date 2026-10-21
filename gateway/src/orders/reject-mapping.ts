// Translation of engine reject reasons and request failures into the public
// `orderReject.reason` codes (see the reject reasons table in shared/PROTOCOL.md).
import { REJECT_REASON_TEXT, type RejectReason } from '@ome/shared';

import {
  EngineDisconnectedError,
  EngineTimeoutError,
  EngineUnavailableError,
} from '../engine/engine-client.js';
import type { RejectReason as EngineRejectReason } from '../internal/protocol.js';

const ENGINE_REASONS: Readonly<Record<EngineRejectReason, RejectReason>> = {
  invalidPrice: 'priceOutOfRange',
  priceOutOfRange: 'priceOutOfRange',
  invalidQuantity: 'qtyOutOfRange',
  qtyOutOfRange: 'qtyOutOfRange',
  unknownOrderId: 'unknownOrder',
  notOwner: 'notOwner',
  // The engine service assigns order IDs, so this means a bug, not bad input.
  duplicateOrderId: 'internal',
};

export interface MappedReject {
  readonly reason: RejectReason;
  readonly message: string;
}

export function rejectFromEngine(reason: EngineRejectReason): MappedReject {
  const mapped = ENGINE_REASONS[reason];
  return { reason: mapped, message: REJECT_REASON_TEXT[mapped] };
}

// A request that got no reply. The order may still have reached the engine
// (EngineDisconnectedError, EngineTimeoutError); its outcome shows in the next
// snapshot or a later event.
export function rejectFromError(error: unknown): MappedReject {
  if (error instanceof EngineUnavailableError || error instanceof EngineDisconnectedError) {
    return { reason: 'engineUnavailable', message: REJECT_REASON_TEXT.engineUnavailable };
  }
  if (error instanceof EngineTimeoutError) {
    return {
      reason: 'engineUnavailable',
      message: 'The engine did not respond in time; check your open orders before retrying',
    };
  }
  return { reason: 'internal', message: REJECT_REASON_TEXT.internal };
}
