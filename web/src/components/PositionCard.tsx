import { formatQty, INSTRUMENT } from '@ome/shared';
import { useId } from 'react';

import { formatSignedMoney, NO_VALUE, positionNote } from '../orders/format.js';
import type { AppState } from '../state/app-state.js';
import { useAppState } from '../state/store.js';

const selectPosition = (state: AppState) => state.position;
const selectInstrument = (state: AppState) => state.instrument;

// The viewer's net position and P&L at the last trade price, below the order ticket.
export function PositionCard() {
  const position = useAppState(selectPosition);
  const decimals = (useAppState(selectInstrument) ?? INSTRUMENT).priceDecimals;
  const headingId = useId();

  const pnl = position?.pnlAtLastTicks ?? 0;
  const direction = pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';

  return (
    <section className="position" aria-labelledby={headingId}>
      <h3 id={headingId} className="position__title">
        Your position
      </h3>
      <dl className="position__tiles">
        <div className="position__tile">
          <dt className="position__label">Net shares</dt>
          <dd className="num position__value">
            {position === null ? NO_VALUE : formatQty(position.netQty)}
          </dd>
        </div>
        <div className="position__tile">
          <dt className="position__label">P&amp;L at last</dt>
          <dd className={`num position__value position__value--${direction}`}>
            {position === null ? NO_VALUE : formatSignedMoney(pnl, decimals)}
          </dd>
        </div>
      </dl>
      <p className="position__note">
        {position === null ? NO_VALUE : positionNote(position.fillCount, position.openOrderCount)}
      </p>
    </section>
  );
}
