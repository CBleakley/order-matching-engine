import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '../src/App.js';
import { PALETTE_STORAGE_KEY } from '../src/settings/palette.js';
import { createStore, StoreContext } from '../src/state/store.js';
import { snapshot } from './messages.js';

// jsdom has no canvas for the price chart.
vi.mock('lightweight-charts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('lightweight-charts')>()),
  // vi.mock is hoisted above the imports, so the fake is loaded here.
  createChart: (await import('./fake-chart.js')).fakeCreateChart,
}));

afterEach(() => {
  window.localStorage.clear();
  delete document.documentElement.dataset['palette'];
});

describe('App shell', () => {
  it('renders the header, main landmark and every placeholder panel', () => {
    render(<App />);

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('heading', { level: 1, name: 'NOVA' })).toBeInTheDocument();
    expect(within(header).getByText('Nova Dynamics · Practice market')).toBeInTheDocument();

    const main = screen.getByRole('main');
    for (const name of [
      'Price chart',
      'Place order',
      'Your pending orders',
      'Your trade history',
    ]) {
      expect(within(main).getByRole('region', { name })).toBeInTheDocument();
    }
  });

  it('links past the header to the main content', () => {
    render(<App />);
    expect(screen.getByRole('link', { name: 'Skip to main content' })).toHaveAttribute(
      'href',
      '#main',
    );
  });

  it('switches to the colour-blind palette and remembers it', () => {
    render(<App />);
    const toggle = screen.getByRole('button', { name: 'Colour-blind palette' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.dataset['palette']).toBe('blue-orange');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('blue-orange');

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.dataset['palette']).toBe('green-red');
    expect(window.localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('green-red');
  });

  it('starts with the saved palette', () => {
    window.localStorage.setItem(PALETTE_STORAGE_KEY, 'blue-orange');
    render(<App />);
    expect(screen.getByRole('button', { name: 'Colour-blind palette' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('shows the connection status in the header pill', () => {
    const store = createStore();
    render(
      <StoreContext value={store}>
        <App />
      </StoreContext>,
    );
    const pill = within(screen.getByRole('banner')).getByRole('status');
    expect(pill).toHaveTextContent('OFFLINE');

    act(() => {
      store.dispatch({ type: 'reconnecting', attempt: 3 });
    });
    expect(pill).toHaveTextContent('RECONNECTING (3)');

    act(() => {
      store.dispatch({ type: 'server', message: snapshot() });
    });
    expect(pill).toHaveTextContent('LIVE');
    expect(pill).toHaveClass('pill--live');
  });
});
