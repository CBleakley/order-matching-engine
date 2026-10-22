import { formatMoney, formatQty, INSTRUMENT, ticksToDecimalString } from '@ome/shared';

import { formatLocalTime } from '../chart/series-data.js';
import { formatSide } from '../orders/format.js';
import type { AppState } from '../state/app-state.js';
import { useAppState } from '../state/store.js';
import { Panel } from './Panel.js';

const selectFills = (state: AppState) => state.fills;
const selectInstrument = (state: AppState) => state.instrument;

// The viewer's fills, newest first. One order can fill in several parts, each
// its own row.
export function TradeHistory() {
  const fills = useAppState(selectFills);
  const decimals = (useAppState(selectInstrument) ?? INSTRUMENT).priceDecimals;

  return (
    <Panel title="Your trade history" className="panel--table" count={fills.length}>
      <div
        className="table-scroll table-scroll--tall"
        role="region"
        aria-label="Trade history table"
        tabIndex={0}
      >
        <table className="data-table data-table--fills">
          <thead>
            <tr>
              <th scope="col">Order</th>
              <th scope="col">Filled</th>
              <th scope="col">Side</th>
              <th scope="col" className="data-table__num">
                Qty
              </th>
              <th scope="col" className="data-table__num">
                Price
              </th>
              <th scope="col" className="data-table__num">
                Value
              </th>
              <th scope="col" className="data-table__num">
                Role
              </th>
            </tr>
          </thead>
          <tbody>
            {fills.map((fill, index) => (
              // Fills have no ID of their own and the rows hold no state, so the
              // position is a good enough key.
              <tr key={index}>
                <td className="num data-table__id">#{fill.orderId}</td>
                <td className="num data-table__time">{formatLocalTime(fill.time)}</td>
                <td className={`data-table__side data-table__side--${fill.side}`}>
                  {formatSide(fill.side)}
                </td>
                <td className="num data-table__num">{formatQty(fill.qty)}</td>
                <td className="num data-table__num">
                  {ticksToDecimalString(fill.priceTicks, { priceDecimals: decimals })}
                </td>
                <td className="num data-table__num">
                  {formatMoney(fill.priceTicks * fill.qty, { priceDecimals: decimals })}
                </td>
                <td className="data-table__num data-table__dim">
                  {fill.liquidity === 'maker' ? 'Maker' : 'Taker'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {fills.length === 0 && (
          <p className="table-empty">
            No fills yet. One order can fill in several parts, each shown as its own row.
          </p>
        )}
      </div>
    </Panel>
  );
}
