import {
  type ClientMessageOf,
  REJECT_REASON_TEXT,
  type RejectReason,
  type ServerMessage,
} from '@ome/shared';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { OrderTicket } from '../src/components/OrderTicket.js';
import { type GatewayCommands, GatewayContext } from '../src/connection/gateway-context.js';
import type { AppAction } from '../src/state/app-state.js';
import { createStore, type Store, StoreContext } from '../src/state/store.js';
import { fill, order, snapshot, STATS, welcome } from './messages.js';

type PlaceOrder = Omit<ClientMessageOf<'placeOrder'>, 'type'>;

function fakeGateway(connected = true) {
  const placeOrder = vi.fn<(order: PlaceOrder) => boolean>(() => connected);
  const gateway: GatewayCommands = {
    placeOrder,
    cancelOrder: vi.fn(() => connected),
    cancelAll: vi.fn(() => connected),
    setInterval: vi.fn(() => connected),
  };
  return { gateway, placeOrder };
}

// A store that has received welcome and a snapshot (last trade 142.50, no open orders).
function liveStore(stats = STATS): Store {
  const store = createStore();
  store.dispatch({ type: 'server', message: welcome() });
  store.dispatch({
    type: 'server',
    message: snapshot(2, { stats, openOrders: [], fills: [] }),
  });
  return store;
}

function renderTicket(store: Store, gateway: GatewayCommands | null) {
  render(
    <StoreContext value={store}>
      <GatewayContext value={gateway}>
        <OrderTicket />
      </GatewayContext>
    </StoreContext>,
  );
}

let seq = 3;
function serve(store: Store, ...messages: ServerMessage[]) {
  act(() => {
    for (const message of messages) store.dispatch({ type: 'server', message });
  });
}

function dispatch(store: Store, action: AppAction) {
  act(() => {
    store.dispatch(action);
  });
}

const qtyInput = () => screen.getByLabelText('Quantity');
const priceInput = () => screen.getByLabelText('Limit price');
const submitButton = () => screen.getByRole('button', { name: /order|Sending|Waiting/ });

function fillIn(qty: string, price: string) {
  fireEvent.change(qtyInput(), { target: { value: qty } });
  fireEvent.change(priceInput(), { target: { value: price } });
}

// Renders a live ticket, places `qty` @ `price` and returns the sent order.
function placeOrder(qty = '100', price = '142.50') {
  const store = liveStore();
  const { gateway, placeOrder: spy } = fakeGateway();
  renderTicket(store, gateway);
  fillIn(qty, price);
  fireEvent.click(submitButton());
  expect(spy).toHaveBeenCalledTimes(1);
  const sent = spy.mock.calls[0]?.[0];
  if (sent === undefined) throw new Error('no order sent');
  return { store, sent, spy };
}

const ack = (clientOrderId: string, orderId = 1043): ServerMessage => ({
  type: 'orderAck',
  seq: seq++,
  clientOrderId,
  orderId,
});

const takerFill = (qty: number, priceTicks: number, orderId = 1043): ServerMessage => ({
  type: 'fill',
  seq: seq++,
  ...fill(orderId, { qty, priceTicks, liquidity: 'taker' }),
});

const update = (
  status: 'resting' | 'filled',
  filledQty: number,
  originalQty = 100,
  orderId = 1043,
): ServerMessage => ({
  type: 'orderUpdate',
  seq: seq++,
  ...order(orderId, {
    priceTicks: 14250,
    originalQty,
    filledQty,
    remainingQty: originalQty - filledQty,
    status,
  }),
});

const reject = (clientOrderId: string, reason: RejectReason, message: string): ServerMessage => ({
  type: 'orderReject',
  seq: seq++,
  clientOrderId,
  reason,
  message,
});

describe('OrderTicket', () => {
  describe('validation', () => {
    it('shows inline messages on submit and sends nothing', () => {
      const store = liveStore();
      const { gateway, placeOrder: spy } = fakeGateway();
      renderTicket(store, gateway);
      fillIn('1.5', '142.505');
      fireEvent.click(submitButton());

      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByText('Quantity must be a whole number')).toBeInTheDocument();
      expect(screen.getByText('Prices move in steps of 0.01')).toBeInTheDocument();
      expect(qtyInput()).toHaveAttribute('aria-invalid', 'true');
      expect(qtyInput()).toHaveAccessibleDescription('Quantity must be a whole number');
      expect(priceInput()).toHaveAccessibleDescription('Prices move in steps of 0.01');
    });

    it('shows a field message once the field is left, and clears it when fixed', () => {
      renderTicket(liveStore(), fakeGateway().gateway);
      fireEvent.change(qtyInput(), { target: { value: '20000' } });
      expect(screen.queryByText('Quantity must be between 1 and 10,000')).not.toBeInTheDocument();

      fireEvent.blur(qtyInput());
      expect(screen.getByText('Quantity must be between 1 and 10,000')).toBeInTheDocument();
      // The untouched price field shows nothing yet.
      expect(screen.queryByText('Enter a limit price')).not.toBeInTheDocument();

      fireEvent.change(qtyInput(), { target: { value: '200' } });
      expect(screen.queryByText(/Quantity must/)).not.toBeInTheDocument();
      expect(qtyInput()).toHaveAttribute('aria-invalid', 'false');
    });

    it('asks for a price when it is empty', () => {
      const store = liveStore();
      const { gateway, placeOrder: spy } = fakeGateway();
      renderTicket(store, gateway);
      fireEvent.click(submitButton());
      expect(spy).not.toHaveBeenCalled();
      expect(screen.getByText('Enter a limit price')).toBeInTheDocument();
    });
  });

  describe('entry', () => {
    it('sends a placeOrder with a fresh clientOrderId and the chosen side', () => {
      const store = liveStore();
      const { gateway, placeOrder: spy } = fakeGateway();
      renderTicket(store, gateway);

      fireEvent.click(screen.getByRole('button', { name: 'Sell' }));
      expect(screen.getByRole('button', { name: 'Sell' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'false');

      fillIn('40', '142.5');
      fireEvent.click(screen.getByRole('button', { name: 'Place sell order' }));

      expect(spy).toHaveBeenCalledWith({
        clientOrderId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
        side: 'sell',
        qty: 40,
        priceTicks: 14250,
      });
      expect(store.getState().orderSubmission?.outcome).toEqual({ kind: 'sending' });
    });

    it('uses a new clientOrderId for every order', () => {
      const { store, sent, spy } = placeOrder();
      serve(store, ack(sent.clientOrderId), update('resting', 0));
      fireEvent.click(submitButton());
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[0].clientOrderId).not.toBe(sent.clientOrderId);
    });

    it('disables the button until the ack arrives', () => {
      const { store, sent } = placeOrder();
      expect(submitButton()).toBeDisabled();
      expect(submitButton()).toHaveTextContent('Sending…');
      expect(screen.getByRole('status')).toHaveTextContent('Sending order…');

      serve(store, ack(sent.clientOrderId));
      expect(submitButton()).toBeEnabled();
      expect(submitButton()).toHaveTextContent('Place buy order');
    });

    it('disables the button until a reject arrives', () => {
      const { store, sent } = placeOrder();
      expect(submitButton()).toBeDisabled();
      serve(
        store,
        reject(sent.clientOrderId, 'priceBand', 'Price must be within 10% of the last trade'),
      );
      expect(submitButton()).toBeEnabled();
    });

    it('records nothing if the gateway could not send', () => {
      const store = liveStore();
      const { gateway } = fakeGateway(false);
      renderTicket(store, gateway);
      fillIn('100', '142.50');
      fireEvent.click(submitButton());
      expect(store.getState().orderSubmission).toBeNull();
      expect(submitButton()).toBeEnabled();
    });

    it('"Use last" fills in the last trade price', () => {
      renderTicket(liveStore(), fakeGateway().gateway);
      expect(priceInput()).toHaveAttribute('placeholder', '142.50');
      fireEvent.click(screen.getByRole('button', { name: 'Use last' }));
      expect(priceInput()).toHaveValue('142.50');
    });

    it('"Use last" is disabled before the first trade', () => {
      const none = { last: null, open: null, high: null, low: null, change: null };
      renderTicket(liveStore(none), fakeGateway().gateway);
      expect(screen.getByRole('button', { name: 'Use last' })).toBeDisabled();
    });

    it('shows the estimated value of a valid order', () => {
      renderTicket(liveStore(), fakeGateway().gateway);
      const estimate = screen.getByTestId('estimated-value');
      fillIn('100', '142.50');
      expect(estimate).toHaveTextContent('14,250.00');
      fillIn('100', '142.5x');
      expect(estimate).toHaveTextContent('—');
    });
  });

  describe('feedback', () => {
    it('acknowledged and resting', () => {
      const { store, sent } = placeOrder('100', '142.50');
      serve(store, ack(sent.clientOrderId), update('resting', 0));
      expect(screen.getByRole('status')).toHaveTextContent('Order #1043 resting: 100 @ 142.50');
    });

    it('filled on arrival at one price', () => {
      const { store, sent } = placeOrder('100', '142.60');
      serve(store, ack(sent.clientOrderId), takerFill(100, 14251), update('filled', 100));
      expect(screen.getByRole('status')).toHaveTextContent('Order #1043 filled: 100 at 142.51');
    });

    it('filled on arrival across several prices, before the ack', () => {
      const { store, sent } = placeOrder('100', '142.60');
      serve(
        store,
        takerFill(50, 14250),
        takerFill(30, 14251),
        takerFill(20, 14255),
        update('filled', 100),
        ack(sent.clientOrderId),
      );
      // (50 × 142.50 + 30 × 142.51 + 20 × 142.55) / 100 = 142.513
      expect(screen.getByRole('status')).toHaveTextContent('Order #1043 filled: 100 at avg 142.51');
    });

    it('partly filled, the rest resting', () => {
      const { store, sent } = placeOrder('100', '142.50');
      serve(store, ack(sent.clientOrderId), takerFill(40, 14251), update('resting', 40));
      expect(screen.getByRole('status')).toHaveTextContent(
        'Order #1043: 40 filled at 142.51, 60 resting at 142.50',
      );
    });

    it('accepted while the outcome is still arriving', () => {
      const { store, sent } = placeOrder();
      serve(store, ack(sent.clientOrderId));
      expect(screen.getByRole('status')).toHaveTextContent('Order #1043 accepted');
    });

    const PLACE_REJECTS: readonly [RejectReason, string][] = [
      ['priceOutOfRange', REJECT_REASON_TEXT.priceOutOfRange],
      ['qtyOutOfRange', 'Quantity must be between 1 and 10000'],
      ['priceBand', 'Price must be within 10% of the last trade'],
      ['tooManyOpenOrders', 'Too many open orders (limit 50)'],
      ['rateLimited', REJECT_REASON_TEXT.rateLimited],
      ['duplicateClientOrderId', REJECT_REASON_TEXT.duplicateClientOrderId],
      ['engineUnavailable', REJECT_REASON_TEXT.engineUnavailable],
      ['internal', REJECT_REASON_TEXT.internal],
    ];

    it.each(PLACE_REJECTS)('rejected: %s', (reason, message) => {
      const { store, sent } = placeOrder();
      serve(store, reject(sent.clientOrderId, reason, message));
      expect(screen.getByRole('alert')).toHaveTextContent(message);
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    it('rejected without a message: the shared text for the reason', () => {
      const { store, sent } = placeOrder();
      serve(store, reject(sent.clientOrderId, 'rateLimited', ''));
      expect(screen.getByRole('alert')).toHaveTextContent('Slow down — order rate limit reached');
    });

    it('ignores replies to other orders', () => {
      const { store } = placeOrder();
      serve(store, reject('someone-else', 'priceBand', 'nope'));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(submitButton()).toBeDisabled();
    });

    it('reports an order lost to a disconnect', () => {
      const { store } = placeOrder();
      dispatch(store, { type: 'reset' });
      dispatch(store, { type: 'reconnecting', attempt: 1 });
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Connection lost before the order was confirmed',
      );
    });
  });

  describe('disconnected', () => {
    it.each<[string, AppAction]>([
      ['connecting', { type: 'connecting' }],
      ['reconnecting', { type: 'reconnecting', attempt: 2 }],
      ['offline', { type: 'offline' }],
    ])('is disabled with an explanation while %s', (_, action) => {
      const store = liveStore();
      const { gateway, placeOrder: spy } = fakeGateway();
      renderTicket(store, gateway);
      fillIn('100', '142.50');
      dispatch(store, action);

      const button = submitButton();
      expect(button).toBeDisabled();
      expect(button).toHaveTextContent('Waiting for connection…');
      expect(qtyInput()).toBeDisabled();
      expect(priceInput()).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Buy' })).toBeDisabled();
      expect(
        screen.getByText('Order entry is paused until the connection is restored.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('group', { name: 'New limit order' })).toHaveAccessibleDescription(
        'Order entry is paused until the connection is restored.',
      );

      fireEvent.submit(button.closest('form') as HTMLFormElement);
      expect(spy).not.toHaveBeenCalled();
    });

    it('is disabled without a gateway', () => {
      renderTicket(liveStore(), null);
      expect(submitButton()).toBeDisabled();
      expect(submitButton()).toHaveTextContent('Waiting for connection…');
    });

    it('comes back when the connection is live again', () => {
      const store = createStore();
      renderTicket(store, fakeGateway().gateway);
      expect(submitButton()).toBeDisabled();
      serve(store, welcome(), snapshot());
      expect(submitButton()).toBeEnabled();
      expect(
        screen.queryByText('Order entry is paused until the connection is restored.'),
      ).not.toBeInTheDocument();
    });
  });
});
