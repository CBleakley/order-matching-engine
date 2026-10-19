import { INSTRUMENT } from '@ome/shared';

import { usePalette } from '../settings/palette.js';
import { type AppState, connectionLabel } from '../state/app-state.js';
import { useAppState } from '../state/store.js';

const selectConnection = (state: AppState) => state.connection;

// Values arrive with live market data (P1-18); until then each shows a dash.
const PLACEHOLDER = '—';

const STATS = ['Day open', 'Day high', 'Day low', 'Your open orders'] as const;

export function AppHeader() {
  const [palette, setPalette] = usePalette();
  const colourBlind = palette === 'blue-orange';
  const connection = useAppState(selectConnection);

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
        <span className="num last-price__value">{PLACEHOLDER}</span>
        <span className="num last-price__change">{PLACEHOLDER}</span>
      </div>

      <dl className="stats">
        {STATS.map((label) => (
          <div key={label} className="stat">
            <dt className="stat__label">{label}</dt>
            <dd className="num stat__value">{PLACEHOLDER}</dd>
          </div>
        ))}
      </dl>

      <div className="header-actions">
        <div className={`pill pill--${connection.kind}`} role="status">
          <span className="pill__dot" aria-hidden="true" />
          <span className="pill__label">{connectionLabel(connection)}</span>
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
