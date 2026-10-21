import { describe, expect, it, vi } from 'vitest';

import { joinSession } from '../src/session/join-api.js';

function reply(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      }),
    ),
  );
}

describe('joinSession', () => {
  it('posts the name as JSON and returns the session', async () => {
    const session = { token: 'payload.signature', traderId: 1_000_001, name: 'Ada' };
    const fetchFn = reply(200, session);

    await expect(joinSession('Ada', fetchFn)).resolves.toEqual({ ok: true, session });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe('/api/session');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(init?.body).toBe(JSON.stringify({ name: 'Ada' }));
  });

  it('returns the gateway message for an invalid name', async () => {
    const fetchFn = reply(400, { error: 'invalidName', message: 'Name must be 2–20 characters' });
    await expect(joinSession('A', fetchFn)).resolves.toEqual({
      ok: false,
      error: { kind: 'invalidName', message: 'Name must be 2–20 characters' },
    });
  });

  it('reads Retry-After when rate limited', async () => {
    const fetchFn = reply(429, { error: 'rateLimited' }, { 'retry-after': '12' });
    await expect(joinSession('Ada', fetchFn)).resolves.toEqual({
      ok: false,
      error: { kind: 'rateLimited', retryAfterSeconds: 12 },
    });
  });

  it('ignores a Retry-After that is not whole seconds', async () => {
    const fetchFn = reply(429, { error: 'rateLimited' }, { 'retry-after': 'soon' });
    await expect(joinSession('Ada', fetchFn)).resolves.toEqual({
      ok: false,
      error: { kind: 'rateLimited', retryAfterSeconds: null },
    });
  });

  it('reports the engine being unavailable', async () => {
    const fetchFn = reply(503, { error: 'engineUnavailable' });
    await expect(joinSession('Ada', fetchFn)).resolves.toEqual({
      ok: false,
      error: { kind: 'engineUnavailable' },
    });
  });

  it.each([
    ['a failed request', vi.fn<typeof fetch>(() => Promise.reject(new TypeError('offline')))],
    [
      'a body that is not JSON',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('<html>', { status: 502 }))),
    ],
    ['a malformed session', reply(200, { token: 'abc' })],
    ['an undocumented error', reply(500, { error: 'boom' })],
  ])('treats %s as a network error', async (_, fetchFn) => {
    await expect(joinSession('Ada', fetchFn)).resolves.toEqual({
      ok: false,
      error: { kind: 'network' },
    });
  });
});
