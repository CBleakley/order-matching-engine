import type { OrderView, ServerMessage, ServerMessageOf } from '@ome/shared';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { formatLocalTime } from '../src/chart/series-data.js';
import { PendingOrders } from '../src/components/PendingOrders.js';
import { type GatewayCommands, GatewayContext } from '../src/connection/gateway-context.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { order, snapshot, welcome } from './messages.js';

function fakeGateway(): GatewayCommands {
  return {
    placeOrder: vi.fn(() => true),
    cancelOrder: vi.fn(() => true),
    cancelAll: vi.fn(() => true),
    setInterval: vi.fn(() => true),
  };
}

function renderPanel(store: Store, gateway: GatewayCommands | null = fakeGateway()) {
  render(
    <StoreContext value={store}>
      <GatewayContext value={gateway}>
        <PendingOrders />
      </GatewayContext>
    </StoreContext>,
  );
  return gateway;
}

function serve(store: Store, ...messages: ServerMessage[]) {
  act(() => {
    for (const message of messages) store.dispatch({ type: 'server', message });
  });
}

function orderUpdate(seq: number, view: OrderView): ServerMessageOf<'orderUpdate'> {
  return { type: 'orderUpdate', seq, ...view };
}

function liveStore(openOrders: OrderView[]): Store {
  const store = createStore();
  store.dispatch({ type: 'server', message: welcome() });
  store.dispatch({ type: 'server', message: snapshot(2, { openOrders }) });
  return store;
}

function bodyRows() {
  const table = screen.getByRole('table');
  // The first row group is the header.
  const [, body] = within(table).getAllByRole('rowgroup');
  if (body === undefined) throw new Error('no table body');
  return within(body).queryAllByRole('row');
}

function cells(row: HTMLElement): string[] {
  return within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent);
}

describe('PendingOrders', () => {
  it('lists the resting orders newest first', () => {
    const store = liveStore([
      order(7, { priceTicks: 14200, placedAt: 1_700_000_000_000 }),
      order(9, {
        side: 'sell',
        priceTicks: 14300,
        originalQty: 100,
        filledQty: 40,
        remainingQty: 60,
        placedAt: 1_700_000_005_000,
      }),
    ]);
    renderPanel(store);

    const region = screen.getByRole('region', { name: 'Your pending orders' });
    expect(within(region).getByText('2', { selector: '.panel__count' })).toBeInTheDocument();
    const rows = bodyRows();
    expect(rows.map((row) => cells(row)[0])).toEqual(['#9', '#7']);
    const [first] = rows;
    if (first === undefined) throw new Error('no row');
    expect(cells(first)).toEqual([
      '#9',
      formatLocalTime(1_700_000_005_000),
      'Sell',
      '40 / 100',
      '60',
      '143.00',
      // Last is 142.50 in the snapshot's stats.
      '+0.35%',
      'Cancel',
    ]);
  });

  it('updates a row in place on a partial fill and removes it when filled', () => {
    const store = liveStore([order(1, { originalQty: 10, remainingQty: 10 })]);
    renderPanel(store);
    const before = bodyRows()[0];

    serve(store, orderUpdate(3, order(1, { filledQty: 4, remainingQty: 6 })));
    const rows = bodyRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(before);
    expect(cells(rows[0] as HTMLElement).slice(3, 5)).toEqual(['4 / 10', '6']);

    serve(store, orderUpdate(4, order(1, { filledQty: 10, remainingQty: 0, status: 'filled' })));
    expect(bodyRows()).toHaveLength(0);
    expect(screen.getByText(/^No pending orders\./)).toBeInTheDocument();
  });

  it('removes a cancelled order', () => {
    const store = liveStore([order(1), order(2)]);
    renderPanel(store);
    serve(store, orderUpdate(3, order(1, { status: 'cancelled' })));
    expect(bodyRows().map((row) => cells(row)[0])).toEqual(['#2']);
  });

  it('sends cancelOrder for the row whose Cancel button is pressed', () => {
    const store = liveStore([order(1), order(2)]);
    const gateway = renderPanel(store);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel order #1' }));
    expect(gateway?.cancelOrder).toHaveBeenCalledExactlyOnceWith(1);
    expect(gateway?.cancelAll).not.toHaveBeenCalled();
  });

  it('sends cancelAll from the panel header', () => {
    const store = liveStore([order(1), order(2)]);
    const gateway = renderPanel(store);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    expect(gateway?.cancelAll).toHaveBeenCalledOnce();
    expect(gateway?.cancelOrder).not.toHaveBeenCalled();
  });

  it('shows the empty state, without Cancel all, when nothing is resting', () => {
    renderPanel(liveStore([]));
    expect(
      screen.getByText(
        'No pending orders. Limit orders rest here until they fill or you cancel them.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel all' })).not.toBeInTheDocument();
    expect(bodyRows()).toHaveLength(0);
  });

  it('disables cancelling while the connection is not live', () => {
    const store = liveStore([order(1)]);
    renderPanel(store);
    act(() => {
      store.dispatch({ type: 'offline' });
    });
    expect(screen.getByRole('button', { name: 'Cancel order #1' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel all' })).toBeDisabled();
  });

  it('disables cancelling without a gateway', () => {
    renderPanel(liveStore([order(1)]), null);
    expect(screen.getByRole('button', { name: 'Cancel order #1' })).toBeDisabled();
  });

  it('shows a dash for the distance until the last price is known', () => {
    const store = createStore();
    store.dispatch({ type: 'server', message: welcome() });
    // An order update with no snapshot yet, so no stats.
    store.dispatch({ type: 'server', message: orderUpdate(2, order(1)) });
    renderPanel(store);
    expect(cells(bodyRows()[0] as HTMLElement)[6]).toBe('—');
  });
});
