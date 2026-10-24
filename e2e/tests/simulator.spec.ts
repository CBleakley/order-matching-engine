// Smoke test with the market simulator on: the backfilled history reaches the
// chart, and live trading keeps adding candles.
import { expect, test } from '../src/fixtures.ts';

test.use({ stackOptions: { simulatorWarmup: '30m' } });

test('the chart shows backfilled history and new candles appear', async ({ joinAs }) => {
  const viewer = await joinAs('Viewer');
  const { chart } = viewer;

  // 30 minutes of 15-second candles (the default interval).
  await expect
    .poll(async () => Number(await chart.getAttribute('data-candle-count')))
    .toBeGreaterThan(20);
  await expect(viewer.lastPrice).toHaveText(/^\d+\.\d{2}$/);

  const firstStart = Number(await chart.getAttribute('data-last-start'));
  await expect
    .poll(async () => Number(await chart.getAttribute('data-last-start')), { timeout: 30_000 })
    .toBeGreaterThan(firstStart);
});
