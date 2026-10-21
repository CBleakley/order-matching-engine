// POST /api/session: trades a display name for a session token
// (shared/src/session-api.ts). Every outcome is returned as a value; the
// join screen shows each failure inline.
import { joinErrorResponseSchema, joinResponseSchema, SESSION_PATH } from '@ome/shared';

import type { Session } from './session-store.js';

export type JoinError =
  | { readonly kind: 'invalidName'; readonly message: string }
  | { readonly kind: 'rateLimited'; readonly retryAfterSeconds: number | null }
  | { readonly kind: 'engineUnavailable' }
  // The request failed, or the reply was not one the gateway documents.
  | { readonly kind: 'network' };

export type JoinResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly error: JoinError };

export type JoinFn = (name: string) => Promise<JoinResult>;

const NETWORK_ERROR: JoinResult = { ok: false, error: { kind: 'network' } };

export async function joinSession(
  name: string,
  fetchFn: typeof fetch = (input, init) => fetch(input, init),
): Promise<JoinResult> {
  let response: Response;
  let body: unknown;
  try {
    response = await fetchFn(SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    body = await response.json();
  } catch {
    return NETWORK_ERROR;
  }

  if (response.ok) {
    const parsed = joinResponseSchema.safeParse(body);
    return parsed.success ? { ok: true, session: parsed.data } : NETWORK_ERROR;
  }
  const parsed = joinErrorResponseSchema.safeParse(body);
  if (!parsed.success) return NETWORK_ERROR;
  switch (parsed.data.error) {
    case 'invalidName':
      return { ok: false, error: { kind: 'invalidName', message: parsed.data.message } };
    case 'rateLimited':
      return {
        ok: false,
        error: {
          kind: 'rateLimited',
          retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
        },
      };
    case 'engineUnavailable':
      return { ok: false, error: { kind: 'engineUnavailable' } };
  }
}

// The gateway sends whole seconds; an HTTP date or junk is ignored.
function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value)) return null;
  return Number(value);
}
