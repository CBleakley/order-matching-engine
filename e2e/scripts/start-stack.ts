// Starts the full stack on free ports, as the end-to-end tests do, and keeps
// it running until Ctrl+C. Needs the same builds as the tests.
//
//   npm run stack -w @ome/e2e                    (simulator off)
//   npm run stack -w @ome/e2e -- --warmup 30m    (simulator on)
//
// Run with Node 24, which strips the types itself.
import { parseArgs } from 'node:util';

import { checkBuilt, Stack } from '../src/stack.ts';

const { values } = parseArgs({ options: { warmup: { type: 'string' } } });

checkBuilt();
const stack = await Stack.start(
  values.warmup === undefined ? {} : { simulatorWarmup: values.warmup },
);
process.stdout.write(`Stack running at ${stack.url} (Ctrl+C to stop)\n`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void stack.stop().then(() => {
    process.exit(0);
  });
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
