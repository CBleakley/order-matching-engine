// Chart harness: renders the price chart from fixture bars, with no gateway.
// Run `npm run dev -w @ome/web` and open /harness/chart.html. Not part of the
// production build (vite builds index.html only).
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/geist-mono/600.css';
import '../src/styles/tokens.css';
import '../src/styles/global.css';

import {
  INSTRUMENT,
  type Interval,
  type OrderView,
  type ServerMessage,
  type Side,
} from '@ome/shared';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { Panel } from '../src/components/Panel.js';
import { PriceChart } from '../src/components/PriceChart.js';
import { type GatewayCommands, GatewayContext } from '../src/connection/gateway-context.js';
import { applyPalette, loadPalette, type Palette } from '../src/settings/palette.js';
import { createStore, StoreContext } from '../src/state/store.js';
import { FixtureMarket } from './fixtures.js';

const HISTORY_SECONDS = 3 * 60 * 60;
const AUTO_RUN_MS = 250;
// Simulated answer time for setInterval.
const GATEWAY_DELAY_MS = 150;

const store = createStore();
const market = new FixtureMarket(42, Date.now(), HISTORY_SECONDS);
let seq = 0;
let nextOrderId = 1001;

// A server message before the harness numbers it. Distributes Omit over the
// union, so each variant keeps its own fields.
type Unnumbered = ServerMessage extends infer M
  ? M extends ServerMessage
    ? Omit<M, 'seq'>
    : never
  : never;

function serve(message: Unnumbered): void {
  seq += 1;
  // Adding seq back to any variant gives that variant.
  store.dispatch({ type: 'server', message: { ...message, seq } });
}

function sendSnapshot(interval: Interval): void {
  const state = store.getState();
  serve({
    type: 'snapshot',
    interval,
    candles: market.barsFor(interval),
    stats: { last: null, open: null, high: null, low: null, change: null },
    openOrders: [...state.openOrders],
    fills: [],
    position: { netQty: 0, cashTicks: 0, pnlAtLastTicks: 0, fillCount: 0, openOrderCount: 0 },
  });
}

function tick(): void {
  const changed = market.step();
  const interval = store.getState().interval;
  const bar = interval === null ? undefined : changed.get(interval);
  if (interval !== null && bar !== undefined) {
    serve({ type: 'candles', interval, bars: [bar] });
  }
}

function sendOrder(order: OrderView): void {
  serve({ type: 'orderUpdate', ...order });
}

function addOrder(side: Side): void {
  const offset = 5 + Math.floor(Math.random() * 60);
  const qty = 100 * (1 + Math.floor(Math.random() * 20));
  sendOrder({
    orderId: nextOrderId++,
    side,
    priceTicks: market.lastPriceTicks + (side === 'buy' ? -offset : offset),
    originalQty: qty,
    filledQty: 0,
    remainingQty: qty,
    status: 'resting',
    placedAt: market.now,
  });
}

function oldestOrder(): OrderView | undefined {
  return store.getState().openOrders[0];
}

function partFillOldest(): void {
  const order = oldestOrder();
  if (order === undefined) return;
  const fill = Math.max(1, Math.floor(order.remainingQty / 2));
  const remainingQty = order.remainingQty - fill;
  sendOrder({
    ...order,
    filledQty: order.filledQty + fill,
    remainingQty,
    status: remainingQty === 0 ? 'filled' : 'resting',
  });
}

function fillOldest(): void {
  const order = oldestOrder();
  if (order === undefined) return;
  sendOrder({ ...order, filledQty: order.originalQty, remainingQty: 0, status: 'filled' });
}

function cancelOldest(): void {
  const order = oldestOrder();
  if (order === undefined) return;
  sendOrder({ ...order, status: 'cancelled' });
}

const gateway: GatewayCommands = {
  setInterval(interval) {
    setTimeout(() => {
      sendSnapshot(interval);
    }, GATEWAY_DELAY_MS);
    return true;
  },
  placeOrder: () => false,
  cancelOrder: () => false,
  cancelAll: () => false,
};

function Controls() {
  const [running, setRunning] = useState(false);
  const [palette, setPalette] = useState<Palette>(loadPalette);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(tick, AUTO_RUN_MS);
    return () => {
      clearInterval(timer);
    };
  }, [running]);

  const button = (label: string, onClick: () => void, pressed?: boolean) => (
    <button type="button" className="chart__toggle" aria-pressed={pressed} onClick={onClick}>
      {label}
    </button>
  );

  return (
    <div className="chart__intervals">
      {button('Tick', tick)}
      {button(
        'Auto-run',
        () => {
          setRunning((on) => !on);
        },
        running,
      )}
      {button('Add buy order', () => {
        addOrder('buy');
      })}
      {button('Add sell order', () => {
        addOrder('sell');
      })}
      {button('Part-fill oldest', partFillOldest)}
      {button('Fill oldest', fillOldest)}
      {button('Cancel oldest', cancelOldest)}
      {button(
        'Colour-blind palette',
        () => {
          const next = palette === 'blue-orange' ? 'green-red' : 'blue-orange';
          applyPalette(next);
          setPalette(next);
        },
        palette === 'blue-orange',
      )}
    </div>
  );
}

function Harness() {
  return (
    <div className="page">
      <div className="shell">
        <h1 className="panel__title">Chart harness (fixture data, no gateway)</h1>
        <Controls />
        <div className="row">
          <Panel title="Price chart" className="panel--chart" hideHeading>
            <PriceChart />
          </Panel>
        </div>
      </div>
    </div>
  );
}

applyPalette(loadPalette());
serve({
  type: 'welcome',
  you: { traderId: 1_000_001, name: 'Harness' },
  instrument: { ...INSTRUMENT },
  serverTime: market.now,
});
sendSnapshot('15s');

const container = document.getElementById('root');
if (container === null) throw new Error('chart.html has no #root element');
createRoot(container).render(
  <StrictMode>
    <StoreContext value={store}>
      <GatewayContext value={gateway}>
        <Harness />
      </GatewayContext>
    </StoreContext>
  </StrictMode>,
);
