// Reconnect delays: exponential backoff with full jitter, so browsers that
// lost the gateway together do not all come back in the same instant.
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 30_000;

// The delay before reconnect attempt `attempt` (1 for the first retry):
// uniform in [0, min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2^(attempt - 1))].
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  // Capping the exponent keeps 2 ** exponent finite for any attempt count.
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(exponent, 30));
  return Math.round(random() * ceiling);
}
