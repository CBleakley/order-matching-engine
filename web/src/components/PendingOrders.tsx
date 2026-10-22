import { formatQty, INSTRUMENT, type OrderView, ticksToDecimalString } from '@ome/shared';
import { useMemo } from 'react';

import { formatLocalTime } from '../chart/series-data.js';
import { useGateway } from '../connection/gateway-context.js';
import { formatDistance, formatSide } from '../orders/format.js';
import type { AppState } from '../state/app-state.js';
import { useAppState } from '../state/store.js';
import { Panel } from './Panel.js';

const selectOpenOrders = (state: AppState) => state.openOrders;
const selectLast = (state: AppState) => state.stats?.last ?? null;
const selectInstrument = (state: AppState) => state.instrument;
const selectLive = (state: AppState) => state.connection.kind === 'live';

// The viewer's resting orders, newest first, each with a Cancel button. Rows
// are keyed by order ID, so a partial fill updates its row in place; filled
// and cancelled orders leave the store and so the table.
export function PendingOrders() {
  const openOrders = useAppState(selectOpenOrders);
  const last = useAppState(selectLast);
  const decimals = (useAppState(selectInstrument) ?? INSTRUMENT).priceDecimals;
  const live = useAppState(selectLive);
  const gateway = useGateway();
  const canCancel = gateway !== null && live;

  const orders = useMemo(() => [...openOrders].sort((a, b) => b.orderId - a.orderId), [openOrders]);

  const cancelAll =
    orders.length === 0 ? undefined : (
      <button
        type="button"
        className="ghost-button"
        disabled={!canCancel}
        onClick={() => gateway?.cancelAll()}
      >
        Cancel all
      </button>
    );

  return (
    <Panel
      title="Your pending orders"
      className="panel--table"
      count={orders.length}
      actions={cancelAll}
    >
      <div className="table-scroll" role="region" aria-label="Pending orders table" tabIndex={0}>
        <table className="data-table data-table--orders">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Placed</th>
              <th scope="col">Side</th>
              <th scope="col" className="data-table__num">
                Filled / qty
              </th>
              <th scope="col" className="data-table__num">
                Remaining
              </th>
              <th scope="col" className="data-table__num">
                Limit
              </th>
              <th scope="col" className="data-table__num">
                vs last
              </th>
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <PendingOrderRow
                key={order.orderId}
                order={order}
                last={last}
                decimals={decimals}
                canCancel={canCancel}
                onCancel={() => gateway?.cancelOrder(order.orderId)}
              />
            ))}
          </tbody>
        </table>
        {orders.length === 0 && (
          <p className="table-empty">
            No pending orders. Limit orders rest here until they fill or you cancel them.
          </p>
        )}
      </div>
    </Panel>
  );
}

interface PendingOrderRowProps {
  order: OrderView;
  last: number | null;
  decimals: number;
  canCancel: boolean;
  onCancel: () => void;
}

function PendingOrderRow({ order, last, decimals, canCancel, onCancel }: PendingOrderRowProps) {
  const id = `#${String(order.orderId)}`;
  const filledPercent = order.originalQty === 0 ? 0 : (order.filledQty / order.originalQty) * 100;
  return (
    <tr>
      <td className="num data-table__id">{id}</td>
      <td className="num data-table__time">{formatLocalTime(order.placedAt)}</td>
      <td className={`data-table__side data-table__side--${order.side}`}>
        {formatSide(order.side)}
      </td>
      <td className="data-table__num">
        <span className="fill-progress">
          <span className="num">
            {formatQty(order.filledQty)} / {formatQty(order.originalQty)}
          </span>
          <span className="fill-progress__bar" aria-hidden="true">
            <span
              className={`fill-progress__value fill-progress__value--${order.side}`}
              style={{ width: `${filledPercent.toFixed(1)}%` }}
            />
          </span>
        </span>
      </td>
      <td className="num data-table__num">{formatQty(order.remainingQty)}</td>
      <td className="num data-table__num">
        {ticksToDecimalString(order.priceTicks, { priceDecimals: decimals })}
      </td>
      <td className="num data-table__num data-table__dim">
        {formatDistance(order.priceTicks, last)}
      </td>
      <td className="data-table__action">
        <button
          type="button"
          className="ghost-button ghost-button--small"
          aria-label={`Cancel order ${id}`}
          disabled={!canCancel}
          onClick={onCancel}
        >
          Cancel
        </button>
      </td>
    </tr>
  );
}
