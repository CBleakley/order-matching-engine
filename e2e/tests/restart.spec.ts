// Restarting the back-end processes under a live page. The engine service is
// the source of truth: a new gateway rebuilds everything from it, but a new
// engine service is a new market, so sessions end.
import { expect, test } from '../src/fixtures.ts';

// The browser retries with exponential backoff (up to 30 s between attempts),
// so after a restart it can take a while to come back.
const RECOVERY_TIMEOUT_MS = 45_000;

test.describe.configure({ timeout: 120_000 });

test('the page reconnects to a restarted gateway with its orders and fills', async ({
  joinAs,
  stack,
}) => {
  const alice = await joinAs('Alice');
  const bob = await joinAs('Bob');
  const sellId = await alice.placeOrder('sell', 100, '142.50');
  await bob.placeOrder('buy', 40, '142.50');
  await alice.expectPending(sellId, '40 / 100', '60');
  await expect(alice.fills).toHaveCount(1);

  await stack.stopGateway();
  await expect(alice.connectionPill).toHaveText(/^RECONNECTING \(\d+\)$/);
  await expect(
    alice.page.getByText('Order entry is paused until the connection is restored.'),
  ).toBeVisible();

  await stack.startGateway();
  await expect(alice.connectionPill).toHaveText('LIVE', { timeout: RECOVERY_TIMEOUT_MS });
  await expect(alice.pendingOrders).toHaveCount(1);
  await alice.expectPending(sellId, '40 / 100', '60');
  await expect(alice.fills).toHaveCount(1);
  await alice.expectFill(0, { side: 'Sell', qty: '40', price: '142.50', role: 'Maker' });
  await expect(alice.netShares).toHaveText('-40');
  await expect(alice.lastPrice).toHaveText('142.50');
  await expect(alice.chart).toHaveAttribute('data-last-close', '14250');

  // Still the same session: it can trade again.
  await expect(bob.connectionPill).toHaveText('LIVE', { timeout: RECOVERY_TIMEOUT_MS });
  await bob.placeOrder('buy', 60, '142.50');
  await expect(alice.pendingOrders).toHaveCount(0);
  await expect(alice.netShares).toHaveText('-100');
});

test('the page returns to the join screen when the engine service restarts', async ({
  joinAs,
  stack,
}) => {
  const alice = await joinAs('Alice');
  await alice.placeOrder('sell', 100, '142.50');

  await stack.stopEngine();
  await stack.startEngine();

  await expect(alice.joinHeading).toBeVisible({ timeout: RECOVERY_TIMEOUT_MS });
  await expect(alice.page.getByText(/^Your session has ended/)).toBeVisible();

  // Joining again gives a fresh session on the new, empty market.
  await alice.joinFromJoinScreen('Alice');
  await expect(alice.pendingOrders).toHaveCount(0);
  await expect(alice.fills).toHaveCount(0);
  await expect(alice.lastPrice).toHaveText('—');
});
