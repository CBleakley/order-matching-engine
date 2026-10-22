import type { Fill, ServerMessageOf } from '@ome/shared';
import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatLocalTime } from '../src/chart/series-data.js';
import { TradeHistory } from '../src/components/TradeHistory.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { fill, snapshot, welcome } from './messages.js';

function storeWithFills(fills: Fill[]): Store {
  const store = createStore();
  store.dispatch({ type: 'server', message: welcome() });
  store.dispatch({ type: 'server', message: snapshot(2, { fills }) });
  return store;
}

function renderPanel(store: Store) {
  render(
    <StoreContext value={store}>
      <TradeHistory />
    </StoreContext>,
  );
}

function fillMessage(seq: number, view: Fill): ServerMessageOf<'fill'> {
  return { type: 'fill', seq, ...view };
}

function bodyRows() {
  const [, body] = within(screen.getByRole('table')).getAllByRole('rowgroup');
  if (body === undefined) throw new Error('no table body');
  return within(body).queryAllByRole('row');
}

function cells(row: HTMLElement | undefined): string[] {
  if (row === undefined) throw new Error('no row');
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

describe('TradeHistory', () => {
  it('lists fills newest first with value and role', () => {
    const store = storeWithFills([
      fill(12, {
        side: 'sell',
        qty: 1500,
        priceTicks: 14251,
        time: 1_700_000_010_000,
        liquidity: 'taker',
      }),
      fill(11, { side: 'buy', qty: 5, priceTicks: 14250, time: 1_700_000_000_000 }),
    ]);
    renderPanel(store);

    const rows = bodyRows();
    expect(cells(rows[0])).toEqual([
      '#12',
      formatLocalTime(1_700_000_010_000),
      'Sell',
      '1,500',
      '142.51',
      '213,765.00',
      'Taker',
    ]);
    expect(cells(rows[1])).toEqual([
      '#11',
      formatLocalTime(1_700_000_000_000),
      'Buy',
      '5',
      '142.50',
      '712.50',
      'Maker',
    ]);
  });

  it('prepends live fills, one row per fill of the same order, and counts them', () => {
    const store = storeWithFills([fill(1)]);
    renderPanel(store);
    const region = screen.getByRole('region', { name: 'Your trade history' });
    expect(within(region).getByText('1', { selector: '.panel__count' })).toBeInTheDocument();

    act(() => {
      store.dispatch({
        type: 'server',
        message: fillMessage(3, fill(2, { qty: 3, priceTicks: 14260, liquidity: 'taker' })),
      });
      store.dispatch({
        type: 'server',
        message: fillMessage(4, fill(2, { qty: 7, priceTicks: 14270, liquidity: 'taker' })),
      });
    });

    const rows = bodyRows();
    expect(rows.map((row) => cells(row).slice(0, 5))).toEqual([
      ['#2', formatLocalTime(1_700_000_000_000), 'Buy', '7', '142.70'],
      ['#2', formatLocalTime(1_700_000_000_000), 'Buy', '3', '142.60'],
      ['#1', formatLocalTime(1_700_000_000_000), 'Buy', '5', '142.50'],
    ]);
    expect(within(region).getByText('3', { selector: '.panel__count' })).toBeInTheDocument();
  });

  it('shows the empty state when there are no fills', () => {
    renderPanel(storeWithFills([]));
    expect(
      screen.getByText(
        'No fills yet. One order can fill in several parts, each shown as its own row.',
      ),
    ).toBeInTheDocument();
    expect(bodyRows()).toHaveLength(0);
  });
});
