// Reconnect delays: exponential backoff with full jitter, so a restarted
// engine service is not hit by retries in lockstep.

export interface BackoffOptions {
  readonly initialMs: number;
  readonly maxMs: number;
}

// The delay before reconnect attempt `attempt` (0 for the first retry): a
// uniformly random value in [0, min(maxMs, initialMs * 2^attempt)).
// `random` returns values in [0, 1), like Math.random.
export function backoffDelay(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.initialMs * 2 ** Math.min(attempt, 30));
  return Math.floor(random() * ceiling);
}
