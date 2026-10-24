// One viewer's page, driven the way a person would: through labels, roles
// and visible text.
import { expect, type Locator, type Page } from '@playwright/test';

export type Side = 'buy' | 'sell';

// "Order #3 resting: …", "Order #3 filled: …" or "Order #3: 50 filled …, 50 resting …".
const SETTLED_STATUS = /^Order #(\d+)(?: resting| filled|:)/;

export class TraderPage {
  readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  // Joins from the join screen and waits for the connection to go live.
  async join(url: string, name: string): Promise<void> {
    await this.page.goto(url);
    await this.joinFromJoinScreen(name);
  }

  async joinFromJoinScreen(name: string): Promise<void> {
    await this.page.getByLabel('Display name').fill(name);
    await this.page.getByRole('button', { name: 'Start trading' }).click();
    await expect(this.connectionPill).toHaveText('LIVE');
  }

  get joinHeading(): Locator {
    return this.page.getByRole('heading', { name: 'Join the practice market' });
  }

  // The header's LIVE / RECONNECTING / OFFLINE label.
  get connectionPill(): Locator {
    return this.page.locator('.pill__label');
  }

  get lastPrice(): Locator {
    return this.page.locator('.last-price__value');
  }

  get chart(): Locator {
    return this.page.getByRole('img', { name: 'NOVA candlestick chart' });
  }

  // The order ticket's status line for the latest order.
  get ticketStatus(): Locator {
    return this.page.locator('.ticket__status');
  }

  get quantity(): Locator {
    return this.page.getByLabel('Quantity');
  }

  get limitPrice(): Locator {
    return this.page.getByLabel('Limit price');
  }

  // Fills in the ticket and submits it. Use placeOrder to also wait for the
  // engine's answer.
  async submitOrder(side: Side, qty: number | string, price: string): Promise<void> {
    await this.page
      .getByRole('group', { name: 'Order side' })
      .getByRole('button', { name: side === 'buy' ? 'Buy' : 'Sell' })
      .click();
    await this.quantity.fill(String(qty));
    await this.limitPrice.fill(price);
    await this.page
      .getByRole('button', { name: side === 'buy' ? 'Place buy order' : 'Place sell order' })
      .click();
  }

  // Submits an order and returns its ID once the ticket reports it resting
  // or filled.
  async placeOrder(side: Side, qty: number, price: string): Promise<number> {
    const before = await this.statusText();
    await this.submitOrder(side, qty, price);
    let status = '';
    await expect
      .poll(
        async () => {
          status = await this.statusText();
          return status !== before && SETTLED_STATUS.test(status);
        },
        { message: `order ${side} ${String(qty)} @ ${price} did not rest or fill` },
      )
      .toBe(true);
    const match = SETTLED_STATUS.exec(status);
    return Number(match?.[1]);
  }

  async statusText(): Promise<string> {
    return (await this.ticketStatus.count()) === 0 ? '' : await this.ticketStatus.innerText();
  }

  get pendingOrders(): Locator {
    return this.page.getByRole('region', { name: 'Pending orders table' }).locator('tbody tr');
  }

  pendingOrder(orderId: number): Locator {
    return this.pendingOrders.filter({
      has: this.page.locator('td.data-table__id', { hasText: new RegExp(`^#${String(orderId)}$`) }),
    });
  }

  // Checks a pending order's filled / qty and remaining columns.
  async expectPending(orderId: number, filledOfQty: string, remaining: string): Promise<void> {
    const cells = this.pendingOrder(orderId).locator('td');
    await expect(cells.nth(3)).toHaveText(filledOfQty);
    await expect(cells.nth(4)).toHaveText(remaining);
  }

  async cancelOrder(orderId: number): Promise<void> {
    await this.page.getByRole('button', { name: `Cancel order #${String(orderId)}` }).click();
  }

  async cancelAll(): Promise<void> {
    await this.page.getByRole('button', { name: 'Cancel all' }).click();
  }

  get fills(): Locator {
    return this.page.getByRole('region', { name: 'Trade history table' }).locator('tbody tr');
  }

  // Checks a trade history row (0 is the newest): side, qty, price and role.
  async expectFill(
    index: number,
    fill: { side: 'Buy' | 'Sell'; qty: string; price: string; role: 'Maker' | 'Taker' },
  ): Promise<void> {
    const cells = this.fills.nth(index).locator('td');
    await expect(cells.nth(2)).toHaveText(fill.side);
    await expect(cells.nth(3)).toHaveText(fill.qty);
    await expect(cells.nth(4)).toHaveText(fill.price);
    await expect(cells.nth(6)).toHaveText(fill.role);
  }

  get netShares(): Locator {
    return this.page.locator('.position__tile', { hasText: 'Net shares' }).locator('dd');
  }

  get positionNote(): Locator {
    return this.page.locator('.position__note');
  }
}
