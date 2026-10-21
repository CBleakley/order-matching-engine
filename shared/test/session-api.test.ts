import { describe, expect, it } from 'vitest';

import { MAX_TOKEN_LENGTH } from '../src/protocol.js';
import { joinErrorResponseSchema, joinResponseSchema } from '../src/session-api.js';

describe('joinResponseSchema', () => {
  it('accepts a session', () => {
    const body = { token: 'abc.def', traderId: 1_000_000, name: 'Ada' };
    expect(joinResponseSchema.parse(body)).toEqual(body);
  });

  it.each([
    { token: '', traderId: 1_000_000, name: 'Ada' },
    { token: 'x'.repeat(MAX_TOKEN_LENGTH + 1), traderId: 1_000_000, name: 'Ada' },
    { token: 'abc', traderId: 1.5, name: 'Ada' },
    { token: 'abc', traderId: 0, name: 'Ada' },
    { token: 'abc', traderId: 1_000_000, name: '' },
    { token: 'abc', traderId: 1_000_000 },
    null,
  ])('rejects %j', (body) => {
    expect(joinResponseSchema.safeParse(body).success).toBe(false);
  });
});

describe('joinErrorResponseSchema', () => {
  it.each([
    { error: 'invalidName', message: 'Name must be 2–20 characters' },
    { error: 'rateLimited' },
    { error: 'engineUnavailable' },
  ])('accepts %j', (body) => {
    expect(joinErrorResponseSchema.parse(body)).toEqual(body);
  });

  it.each([{ error: 'invalidName' }, { error: 'other' }, {}])('rejects %j', (body) => {
    expect(joinErrorResponseSchema.safeParse(body).success).toBe(false);
  });
});
