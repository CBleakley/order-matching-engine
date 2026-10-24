// Joining and trading between two people, with the simulator off so the book
// holds only the test's orders. Prices stay within 10% of the reference price
// (142.50), the gateway's band before the first trade.
import { expect, test } from '../src/fixtures.ts';

test('joining shows the live dashboard with empty panels', async ({ joinAs }) => {
  const alice = await joinAs('Alice');
  const { page } = alice;

  await expect(alice.connectionPill).toHaveText('LIVE');
  await expect(page.locator('.user-badge__name')).toHaveText('Alice');
  await expect(alice.chart.locator('canvas').first()).toBeVisible();
  await expect(alice.chart).toHaveAttribute('data-candle-count', '0');
  await expect(page.getByText('Waiting for market data…')).toHaveCount(0);
  await expect(alice.lastPrice).toHaveText('—');
  await expect(page.getByText(/^No pending orders\./)).toBeVisible();
  await expect(page.getByText(/^No fills yet\./)).toBeVisible();
  await expect(alice.netShares).toHaveText('0');
  await expect(alice.positionNote).toHaveText('0 fills · 0 open orders');
});

test('a buy through a resting sell fills both sides', async ({ joinAs }) => {
  const alice = await joinAs('Alice');
  const bob = await joinAs('Bob');

  const sellId = await alice.placeOrder('sell', 150, '142.50');
  await expect(alice.ticketStatus).toHaveText(`Order #${String(sellId)} resting: 150 @ 142.50`);
  await alice.expectPending(sellId, '0 / 150', '150');

  // Bob bids above the ask; the trade is at Alice's resting price.
  const buyId = await bob.placeOrder('buy', 100, '142.60');
  await expect(bob.ticketStatus).toHaveText(`Order #${String(buyId)} filled: 100 at 142.50`);

  await expect(bob.fills).toHaveCount(1);
  await bob.expectFill(0, { side: 'Buy', qty: '100', price: '142.50', role: 'Taker' });
  await expect(alice.fills).toHaveCount(1);
  await alice.expectFill(0, { side: 'Sell', qty: '100', price: '142.50', role: 'Maker' });

  await alice.expectPending(sellId, '100 / 150', '50');
  await expect(bob.pendingOrders).toHaveCount(0);

  await expect(alice.netShares).toHaveText('-100');
  await expect(alice.positionNote).toHaveText('1 fill · 1 open order');
  await expect(bob.netShares).toHaveText('100');
  await expect(bob.positionNote).toHaveText('1 fill · 0 open orders');

  for (const trader of [alice, bob]) {
    await expect(trader.lastPrice).toHaveText('142.50');
    await expect(trader.chart).toHaveAttribute('data-candle-count', '1');
    await expect(trader.chart).toHaveAttribute('data-last-close', '14250');
  }
});

test('a buy fills across two resting sells; cancel the rest, then cancel all', async ({
  joinAs,
}) => {
  const alice = await joinAs('Alice');
  const bob = await joinAs('Bob');

  const first = await alice.placeOrder('sell', 100, '142.50');
  const second = await alice.placeOrder('sell', 100, '142.60');
  await expect(alice.pendingOrders).toHaveCount(2);

  // 100 at 142.50, then 50 at 142.60.
  const buyId = await bob.placeOrder('buy', 150, '142.60');
  await expect(bob.ticketStatus).toHaveText(`Order #${String(buyId)} filled: 150 at avg 142.53`);

  await expect(alice.fills).toHaveCount(2);
  await alice.expectFill(0, { side: 'Sell', qty: '50', price: '142.60', role: 'Maker' });
  await alice.expectFill(1, { side: 'Sell', qty: '100', price: '142.50', role: 'Maker' });
  await expect(bob.fills).toHaveCount(2);
  await expect(alice.pendingOrder(first)).toHaveCount(0);
  await alice.expectPending(second, '50 / 100', '50');
  await expect(alice.netShares).toHaveText('-150');
  await expect(bob.netShares).toHaveText('150');
  await expect(bob.lastPrice).toHaveText('142.60');

  await alice.cancelOrder(second);
  await expect(alice.pendingOrders).toHaveCount(0);
  await expect(alice.page.getByText(/^No pending orders\./)).toBeVisible();
  // Cancelling does not undo fills.
  await expect(alice.netShares).toHaveText('-150');
  await expect(alice.positionNote).toHaveText('2 fills · 0 open orders');

  await alice.placeOrder('buy', 10, '142.00');
  await alice.placeOrder('buy', 20, '141.90');
  await alice.placeOrder('sell', 30, '143.00');
  await expect(alice.pendingOrders).toHaveCount(3);
  await alice.cancelAll();
  await expect(alice.pendingOrders).toHaveCount(0);
  await expect(alice.positionNote).toHaveText('2 fills · 0 open orders');
  await expect(alice.fills).toHaveCount(2);
});

test('orders outside the price band or over the size limit are rejected', async ({ joinAs }) => {
  const alice = await joinAs('Alice');
  const { page } = alice;

  // The gateway checks the band (10% of 142.50 before any trade).
  await alice.submitOrder('sell', 100, '200.00');
  await expect(page.getByRole('alert')).toHaveText('Price must be within 10% of the last trade');
  await expect(alice.pendingOrders).toHaveCount(0);

  // The ticket stops an oversized order before it is sent.
  await alice.submitOrder('buy', 10_001, '142.50');
  await expect(page.getByText('Quantity must be between 1 and 10,000')).toBeVisible();
  await expect(alice.quantity).toHaveAttribute('aria-invalid', 'true');
  await expect(alice.ticketStatus).toHaveText('Price must be within 10% of the last trade');

  // The gateway rejects one sent anyway, from a second connection on the
  // same session.
  const reject = await page.evaluate(async () => {
    const stored = localStorage.getItem('nova.session');
    const { token } = JSON.parse(stored ?? '{}') as { token: string };
    const socket = new WebSocket(`ws://${location.host}/ws`);
    return new Promise<{ reason: string; message: string }>((resolve, reject) => {
      setTimeout(() => {
        reject(new Error('no orderReject'));
      }, 5000);
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token }));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as {
          type: string;
          reason?: string;
          message?: string;
        };
        if (message.type === 'welcome') {
          socket.send(
            JSON.stringify({
              type: 'placeOrder',
              clientOrderId: 'oversized',
              side: 'buy',
              qty: 10_001,
              priceTicks: 14_250,
            }),
          );
        } else if (message.type === 'orderReject') {
          socket.close();
          resolve({ reason: message.reason ?? '', message: message.message ?? '' });
        }
      };
    });
  });
  expect(reject).toEqual({
    reason: 'qtyOutOfRange',
    message: 'Quantity must be between 1 and 10000',
  });
  await expect(alice.pendingOrders).toHaveCount(0);
});
