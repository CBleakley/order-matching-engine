import { INSTRUMENT, ticksToDecimalString } from '@ome/shared';

import { formatLocalTime } from '../chart/series-data.js';
import { formatChange } from '../format/change.js';
import { NO_VALUE } from '../orders/format.js';
import { usePalette } from '../settings/palette.js';
import { type AppState, connectionLabel } from '../state/app-state.js';
import { useAppState } from '../state/store.js';
import { useNow } from './use-now.js';
import { UserBadge } from './UserBadge.js';

const selectConnection = (state: AppState) => state.connection;
const selectStats = (state: AppState) => state.stats;
const selectInstrument = (state: AppState) => state.instrument;
const selectOpenOrderCount = (state: AppState) => state.openOrders.length;

export function AppHeader() {
  const [palette, setPalette] = usePalette();
  const colourBlind = palette === 'blue-orange';
  const connection = useAppState(selectConnection);
  const stats = useAppState(selectStats);
  const instrument = useAppState(selectInstrument) ?? INSTRUMENT;
  const openOrderCount = useAppState(selectOpenOrderCount);
  const now = useNow(1000);

  const price = (ticks: number | null | undefined) =>
    ticks === null || ticks === undefined ? NO_VALUE : ticksToDecimalString(ticks, instrument);
  const change = stats?.change ?? null;
  const open = stats?.open ?? null;
  const changeText =
    change === null || open === null
      ? NO_VALUE
      : formatChange(change, open, instrument.priceDecimals);
  const direction =
    change === null || change === 0
      ? ''
      : change > 0
        ? ' last-price__change--up'
        : ' last-price__change--down';
  const statValues = [
    ['Day open', price(open)],
    ['Day high', price(stats?.high)],
    ['Day low', price(stats?.low)],
    // Unknown until the snapshot brings the viewer's orders.
    ['Your open orders', stats === null ? NO_VALUE : String(openOrderCount)],
  ] as const;

  return (
    <header className="app-header">
      <div className="brand">
        <div className="brand__icon">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M7 3v4M7 17v4M17 6v3M17 19v2" />
            <rect x="4.5" y="7" width="5" height="10" rx="1" />
            <rect x="14.5" y="9" width="5" height="10" rx="1" />
          </svg>
        </div>
        <div className="brand__text">
          <div className="brand__line">
            <h1 className="brand__symbol">{INSTRUMENT.symbol}</h1>
            <span className="brand__tag">Simulated</span>
          </div>
          <span className="brand__name">{INSTRUMENT.name} · Practice market</span>
        </div>
      </div>

      <div className="last-price">
        <span className="visually-hidden">Last price</span>
        <span className="num last-price__value">{price(stats?.last)}</span>
        <span className={`num last-price__change${direction}`}>
          <span className="visually-hidden">Daily change </span>
          {changeText}
        </span>
      </div>

      <dl className="stats">
        {statValues.map(([label, value]) => (
          <div key={label} className="stat">
            <dt className="stat__label">{label}</dt>
            <dd className="num stat__value">{value}</dd>
          </div>
        ))}
      </dl>

      <div className="header-actions">
        <UserBadge />
        <div className={`pill pill--${connection.kind}`} role="status">
          <span className="pill__dot" aria-hidden="true" />
          <span className="pill__label">{connectionLabel(connection)}</span>
          {/* Hidden from assistive technology: the pill is a live region, and a
              clock inside it would be announced every second. */}
          <time
            className="num pill__time"
            dateTime={new Date(now).toISOString()}
            aria-hidden="true"
          >
            {formatLocalTime(now)}
          </time>
        </div>
        <button
          type="button"
          className="palette-toggle"
          aria-pressed={colourBlind}
          onClick={() => {
            setPalette(colourBlind ? 'green-red' : 'blue-orange');
          }}
        >
          <span className="swatch swatch--up" aria-hidden="true" />
          <span className="swatch swatch--down" aria-hidden="true" />
          Colour-blind palette
        </button>
      </div>
    </header>
  );
}
