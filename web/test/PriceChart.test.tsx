import type { ServerMessage } from '@ome/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PriceChart } from '../src/components/PriceChart.js';
import { type GatewayCommands, GatewayContext } from '../src/connection/gateway-context.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { charts, liveChart } from './fake-chart.js';
import { bar, order, snapshot, welcome } from './messages.js';

vi.mock('lightweight-charts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lightweight-charts')>()),
  // vi.mock is hoisted above the imports, so the fake is loaded here.
  createChart: (await import('./fake-chart.js')).fakeCreateChart,
}));

function fakeGateway(connected = true): GatewayCommands {
  return {
    placeOrder: vi.fn(() => connected),
    cancelOrder: vi.fn(() => connected),
    cancelAll: vi.fn(() => connected),
    setInterval: vi.fn(() => connected),
  };
}

function renderChart(store: Store, gateway: GatewayCommands | null = fakeGateway()) {
  render(
    <StoreContext value={store}>
      <GatewayContext value={gateway}>
        <PriceChart />
      </GatewayContext>
    </StoreContext>,
  );
}

function serve(store: Store, ...messages: ServerMessage[]) {
  act(() => {
    for (const message of messages) store.dispatch({ type: 'server', message });
  });
}

function candleSeries() {
  const series = liveChart().seriesOfType('Candlestick');
  if (series === undefined) throw new Error('no candlestick series');
  return series;
}

function pressedInterval(): string | null {
  const group = screen.getByRole('group', { name: 'Interval' });
  const pressed = within(group)
    .getAllByRole('button')
    .find((button) => button.getAttribute('aria-pressed') === 'true');
  return pressed?.textContent ?? null;
}

beforeEach(() => {
  charts.length = 0;
});

describe('PriceChart', () => {
  it('waits for market data, then loads the snapshot bars', () => {
    const store = createStore();
    renderChart(store);
    expect(screen.getByText('Waiting for market data…')).toBeInTheDocument();

    serve(store, welcome(), snapshot());
    expect(screen.queryByText('Waiting for market data…')).not.toBeInTheDocument();
    expect(candleSeries().calls.at(-1)).toEqual({
      method: 'setData',
      data: [
        { time: 15, open: 142.5, high: 142.5, low: 142.5, close: 142.5 },
        { time: 30, open: 142.5, high: 142.5, low: 142.5, close: 142.5 },
      ],
    });
    expect(screen.getByText('NOVA · 15s candles · local time')).toBeInTheDocument();
    expect(pressedInterval()).toBe('15s');
  });

  it('keeps the licence attribution logo on', () => {
    renderChart(createStore());
    expect(liveChart().options).toMatchObject({ layout: { attributionLogo: true } });
  });

  it('updates live bars in place instead of reloading the series', () => {
    const store = createStore();
    renderChart(store);
    serve(store, welcome(), snapshot());
    const series = candleSeries();
    const before = series.calls.length;

    serve(store, {
      type: 'candles',
      seq: 3,
      interval: '15s',
      bars: [bar(30_000, 14300), bar(45_000, 14310)],
    });
    expect(series.calls.slice(before)).toEqual([
      { method: 'update', data: { time: 30, open: 143, high: 143, low: 143, close: 143 } },
      { method: 'update', data: { time: 45, open: 143.1, high: 143.1, low: 143.1, close: 143.1 } },
    ]);
    expect(candleSeries()).toBe(series);
  });

  it('sends setInterval, shows the choice pressed, and reloads on the new snapshot', () => {
    const store = createStore();
    const gateway = fakeGateway();
    renderChart(store, gateway);
    serve(store, welcome(), snapshot());

    fireEvent.click(screen.getByRole('button', { name: '1m' }));
    expect(gateway.setInterval).toHaveBeenCalledWith('1m');
    expect(pressedInterval()).toBe('1m');

    const series = candleSeries();
    const before = series.calls.length;
    serve(store, snapshot(3, { interval: '1m', candles: [bar(60_000)] }));
    expect(series.calls.slice(before)).toEqual([
      {
        method: 'setData',
        data: [{ time: 60, open: 142.5, high: 142.5, low: 142.5, close: 142.5 }],
      },
    ]);
    expect(pressedInterval()).toBe('1m');
    expect(screen.getByText('NOVA · 1m candles · local time')).toBeInTheDocument();
  });

  it('follows the store when a later snapshot changes the interval', () => {
    const store = createStore();
    renderChart(store);
    serve(store, welcome(), snapshot());
    fireEvent.click(screen.getByRole('button', { name: '5m' }));
    serve(store, snapshot(3, { interval: '5m' }));
    // A reconnect starts again on the gateway's default interval.
    serve(store, snapshot(4, { interval: '15s' }));
    expect(pressedInterval()).toBe('15s');
  });

  it('does not change interval without a connected gateway', () => {
    const store = createStore();
    const gateway = fakeGateway(false);
    renderChart(store, gateway);
    serve(store, welcome(), snapshot());
    fireEvent.click(screen.getByRole('button', { name: '5s' }));
    expect(pressedInterval()).toBe('15s');
  });

  it('draws, relabels and removes order lines as orders rest, fill and cancel', () => {
    const store = createStore();
    renderChart(store);
    serve(store, welcome(), snapshot(2, { openOrders: [order(1)] }));
    const series = candleSeries();
    expect(series.priceLines.map((line) => line.options.title)).toEqual(['BUY 10 @ 142.00 · #1']);

    serve(store, {
      type: 'orderUpdate',
      seq: 3,
      ...order(2, { side: 'sell', priceTicks: 14500, originalQty: 100, remainingQty: 100 }),
    });
    expect(series.priceLines.map((line) => line.options.title)).toEqual([
      'BUY 10 @ 142.00 · #1',
      'SELL 100 @ 145.00 · #2',
    ]);

    serve(store, { type: 'orderUpdate', seq: 4, ...order(1, { filledQty: 4, remainingQty: 6 }) });
    expect(series.priceLines[0]?.options.title).toBe('BUY 6 @ 142.00 · #1');

    serve(
      store,
      {
        type: 'orderUpdate',
        seq: 5,
        ...order(1, { filledQty: 10, remainingQty: 0, status: 'filled' }),
      },
      {
        type: 'orderUpdate',
        seq: 6,
        ...order(2, { side: 'sell', priceTicks: 14500, status: 'cancelled' }),
      },
    );
    expect(series.priceLines).toEqual([]);
  });

  it('shows a tooltip for the hovered candle', () => {
    const store = createStore();
    renderChart(store);
    serve(
      store,
      welcome(),
      snapshot(2, { candles: [bar(15_000, 14300, { open: 14250, trades: 3 })] }),
    );

    act(() => {
      liveChart().moveCrosshair({ time: 15 as never, point: { x: 10, y: 10 } as never });
    });
    expect(screen.getByText('+0.50 (+0.35%)')).toBeInTheDocument();
    expect(screen.getByText('Trades').nextElementSibling).toHaveTextContent('3');

    act(() => {
      liveChart().moveCrosshair({});
    });
    expect(screen.queryByText('+0.50 (+0.35%)')).not.toBeInTheDocument();
  });

  it('adds and removes the volume histogram', () => {
    const store = createStore();
    renderChart(store);
    serve(store, welcome(), snapshot());
    expect(liveChart().seriesOfType('Histogram')).toBeUndefined();

    const toggle = screen.getByRole('button', { name: 'Volume' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(liveChart().seriesOfType('Histogram')?.calls.at(-1)?.method).toBe('setData');

    fireEvent.click(toggle);
    expect(liveChart().seriesOfType('Histogram')).toBeUndefined();
  });

  it('renders the legend', () => {
    renderChart(createStore());
    expect(screen.getByText('Close ≥ open')).toBeInTheDocument();
    expect(screen.getByText('Close < open')).toBeInTheDocument();
    expect(
      screen.getByText('Dashed lines mark your resting orders. Hover a candle for details.'),
    ).toBeInTheDocument();
  });

  it('removes the chart on unmount', () => {
    const { unmount } = render(
      <StoreContext value={createStore()}>
        <PriceChart />
      </StoreContext>,
    );
    const chart = liveChart();
    unmount();
    expect(chart.removed).toBe(true);
  });
});
