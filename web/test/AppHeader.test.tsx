import type { ServerMessage, Stats } from '@ome/shared';
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from '../src/components/AppHeader.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { order, snapshot, STATS, welcome } from './messages.js';

afterEach(() => {
  vi.useRealTimers();
});

function renderHeader(store: Store = createStore()) {
  render(
    <StoreContext value={store}>
      <AppHeader />
    </StoreContext>,
  );
  return store;
}

function serve(store: Store, ...messages: ServerMessage[]) {
  act(() => {
    for (const message of messages) store.dispatch({ type: 'server', message });
  });
}

function stat(label: string): HTMLElement {
  const term = screen.getByText(label, { selector: 'dt' });
  const value = term.nextElementSibling;
  if (!(value instanceof HTMLElement)) throw new Error(`no value for ${label}`);
  return value;
}

const lastPrice = () => document.querySelector('.last-price__value');
const change = () => document.querySelector('.last-price__change');

describe('AppHeader', () => {
  it('shows dashes before any market data', () => {
    renderHeader();
    expect(lastPrice()).toHaveTextContent('—');
    expect(change()).toHaveTextContent('—');
    for (const label of ['Day open', 'Day high', 'Day low', 'Your open orders']) {
      expect(stat(label)).toHaveTextContent('—');
    }
  });

  it('shows the daily stats and the viewer’s open order count', () => {
    const store = renderHeader();
    serve(store, welcome(), snapshot(2, { openOrders: [order(1), order(2)] }));
    expect(lastPrice()).toHaveTextContent('142.50');
    expect(stat('Day open')).toHaveTextContent('140.00');
    expect(stat('Day high')).toHaveTextContent('143.00');
    expect(stat('Day low')).toHaveTextContent('139.00');
    expect(stat('Your open orders')).toHaveTextContent('2');

    serve(store, { type: 'orderUpdate', seq: 3, ...order(3) });
    expect(stat('Your open orders')).toHaveTextContent('3');
  });

  it.each<[string, Partial<Stats>, string, string | null]>([
    ['up', { change: 250 }, '+2.50 (+1.79%)', 'last-price__change--up'],
    ['down', { last: 13750, change: -250 }, '−2.50 (−1.79%)', 'last-price__change--down'],
    ['unchanged', { last: 14000, change: 0 }, '+0.00 (+0.00%)', null],
  ])('colours the daily change by sign: %s', (_, overrides, text, className) => {
    const store = renderHeader();
    serve(store, snapshot(2, { stats: { ...STATS, ...overrides } }));
    const element = change();
    expect(element).toHaveTextContent(text);
    expect(element).toHaveTextContent(/^Daily change/);
    for (const name of ['last-price__change--up', 'last-price__change--down']) {
      if (name === className) expect(element).toHaveClass(name);
      else expect(element).not.toHaveClass(name);
    }
  });

  it('shows dashes before the instrument has ever traded', () => {
    const store = renderHeader();
    const none = { last: null, open: null, high: null, low: null, change: null };
    serve(store, snapshot(2, { stats: none, openOrders: [] }));
    expect(lastPrice()).toHaveTextContent('—');
    expect(change()).toHaveTextContent('—');
    expect(stat('Day high')).toHaveTextContent('—');
    expect(stat('Your open orders')).toHaveTextContent('0');
  });

  it('shows the current time in the connection pill, every second', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(2026, 9, 22, 14, 30, 5));
    renderHeader();
    const pill = within(screen.getByRole('banner')).getByRole('status');
    const time = pill.querySelector('time');
    expect(time).toHaveTextContent('14:30:05');
    // Kept out of the live region's announcements.
    expect(time).toHaveAttribute('aria-hidden', 'true');
    expect(pill).toHaveTextContent('OFFLINE');

    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(time).toHaveTextContent('14:30:07');
  });
});
