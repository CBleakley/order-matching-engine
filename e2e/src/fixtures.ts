// Playwright fixtures: a fresh stack per test, and traders, each a browser
// context of its own (separate storage, so a separate session). The stack is
// stopped and the contexts closed when the test ends, pass or fail; on failure
// the processes' output is attached to the report.
import { test as base, type BrowserContext } from '@playwright/test';

import { Stack, type StackOptions } from './stack.ts';
import { TraderPage } from './trader-page.ts';

interface Fixtures {
  stackOptions: StackOptions;
  stack: Stack;
  // Opens the app in a new browser context and joins as `name`.
  joinAs: (name: string) => Promise<TraderPage>;
}

export const test = base.extend<Fixtures>({
  stackOptions: [{}, { option: true }],

  stack: async ({ stackOptions }, use, testInfo) => {
    const stack = await Stack.start(stackOptions);
    try {
      await use(stack);
    } finally {
      await stack.stop();
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('stack.log', { body: stack.logs(), contentType: 'text/plain' });
      }
    }
  },

  joinAs: async ({ browser, stack }, use) => {
    const contexts: BrowserContext[] = [];
    try {
      await use(async (name) => {
        const context = await browser.newContext();
        contexts.push(context);
        const trader = new TraderPage(await context.newPage());
        await trader.join(stack.url, name);
        return trader;
      });
    } finally {
      await Promise.all(contexts.map((context) => context.close()));
    }
  },
});

export { expect } from '@playwright/test';
