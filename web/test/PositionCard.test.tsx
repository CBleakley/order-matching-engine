import type { Position } from '@ome/shared';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PositionCard } from '../src/components/PositionCard.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { POSITION, snapshot, welcome } from './messages.js';

function renderCard(store: Store) {
  render(
    <StoreContext value={store}>
      <PositionCard />
    </StoreContext>,
  );
}

function setPosition(store: Store, position: Partial<Position>) {
  act(() => {
    store.dispatch({
      type: 'server',
      message: { type: 'position', seq: 3, ...POSITION, ...position },
    });
  });
}

function pnl() {
  // The definition list pairs each label with its value.
  const label = screen.getByText('P&L at last');
  const value = label.nextElementSibling;
  if (value === null) throw new Error('no P&L value');
  return value;
}

function liveStore(): Store {
  const store = createStore();
  store.dispatch({ type: 'server', message: welcome() });
  store.dispatch({ type: 'server', message: snapshot() });
  return store;
}

describe('PositionCard', () => {
  it('shows dashes until the position arrives', () => {
    renderCard(createStore());
    expect(screen.getByRole('region', { name: 'Your position' })).toBeInTheDocument();
    expect(screen.getByText('Net shares').nextElementSibling).toHaveTextContent('—');
    expect(pnl()).toHaveTextContent('—');
  });

  it('shows the net quantity and the fills and open orders note', () => {
    const store = liveStore();
    renderCard(store);
    setPosition(store, { netQty: -1200, fillCount: 3, openOrderCount: 2 });
    expect(screen.getByText('Net shares').nextElementSibling).toHaveTextContent('-1,200');
    expect(screen.getByText('3 fills · 2 open orders')).toBeInTheDocument();
  });

  it('colours the P&L by its sign', () => {
    const store = liveStore();
    renderCard(store);

    setPosition(store, { pnlAtLastTicks: 1250 });
    expect(pnl()).toHaveTextContent('+12.50');
    expect(pnl()).toHaveClass('position__value--up');

    setPosition(store, { pnlAtLastTicks: -300 });
    expect(pnl()).toHaveTextContent('−3.00');
    expect(pnl()).toHaveClass('position__value--down');

    setPosition(store, { pnlAtLastTicks: 0 });
    expect(pnl()).toHaveTextContent('+0.00');
    expect(pnl()).toHaveClass('position__value--flat');
  });
});
