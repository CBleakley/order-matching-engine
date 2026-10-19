import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAX_TOKEN_LENGTH,
  signToken,
  verifyToken,
  type SessionClaims,
  type VerifyOptions,
} from '../../src/session/token.js';

const SECRET = 'a-very-long-session-secret-of-40-chars!!';
const DAY_MS = 24 * 60 * 60 * 1000;
const ISSUED_AT = 1_760_000_000_000;

const CLAIMS: SessionClaims = {
  traderId: 1_234_567,
  name: 'Ada',
  engineInstanceId: 18_446_744_073_709_551_615n,
  issuedAt: ISSUED_AT,
};

const OPTIONS: VerifyOptions = {
  secret: SECRET,
  maxAgeMs: 7 * DAY_MS,
  engineInstanceId: CLAIMS.engineInstanceId,
  now: ISSUED_AT + 1000,
};

// Signs arbitrary payload text with the real secret, to test what happens
// after the signature check.
function signText(text: string): string {
  const encoded = Buffer.from(text).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function flipChar(text: string, index: number): string {
  const c = text[index] === 'A' ? 'B' : 'A';
  return text.slice(0, index) + c + text.slice(index + 1);
}

describe('session tokens', () => {
  it('round-trips the claims', () => {
    const token = signToken(CLAIMS, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyToken(token, OPTIONS)).toEqual({ ok: true, claims: CLAIMS });
  });

  it('round-trips a non-ASCII name', () => {
    const claims = { ...CLAIMS, name: 'Seán Ó Briain' };
    expect(verifyToken(signToken(claims, SECRET), OPTIONS)).toEqual({ ok: true, claims });
  });

  it('rejects a tampered payload', () => {
    const [payload, signature] = signToken(CLAIMS, SECRET).split('.') as [string, string];
    const forged = Buffer.from(
      Buffer.from(payload, 'base64url').toString().replace('1234567', '7654321'),
    ).toString('base64url');
    expect(verifyToken(`${forged}.${signature}`, OPTIONS)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
    expect(verifyToken(`${flipChar(payload, 5)}.${signature}`, OPTIONS)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
  });

  it('rejects a tampered signature', () => {
    const [payload, signature] = signToken(CLAIMS, SECRET).split('.') as [string, string];
    expect(verifyToken(`${payload}.${flipChar(signature, 3)}`, OPTIONS)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
    // A truncated signature is rejected before the constant-time comparison.
    expect(verifyToken(`${payload}.${signature.slice(0, 20)}`, OPTIONS)).toEqual({
      ok: false,
      reason: 'badSignature',
    });
  });

  it('rejects a token signed with another secret', () => {
    const token = signToken(CLAIMS, 'another-secret-that-is-also-long-enough');
    expect(verifyToken(token, OPTIONS)).toEqual({ ok: false, reason: 'badSignature' });
  });

  it.each([
    ['not a string', 42],
    ['empty', ''],
    ['one part', 'abc'],
    ['three parts', 'a.b.c'],
    ['empty part', 'abc.'],
    ['non-base64url characters', 'ab+c.de/f'],
    ['too long', `${'a'.repeat(MAX_TOKEN_LENGTH)}.b`],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(verifyToken(token, OPTIONS)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['not JSON', 'raw'],
    ['wrong version', { v: 2, traderId: 1_234_567, name: 'Ada', engineInstanceId: '1', iat: 0 }],
    ['simulated trader ID', { v: 1, traderId: 7, name: 'Ada', engineInstanceId: '1', iat: 0 }],
    ['invalid name', { v: 1, traderId: 1_234_567, name: '<b>', engineInstanceId: '1', iat: 0 }],
    ['numeric instance', { v: 1, traderId: 1_234_567, name: 'Ada', engineInstanceId: 1, iat: 0 }],
    [
      'extra field',
      { v: 1, traderId: 1_234_567, name: 'Ada', engineInstanceId: '1', iat: 0, admin: true },
    ],
  ])('rejects a correctly signed token with a bad payload (%s)', (_label, payload) => {
    const token = signText(typeof payload === 'string' ? payload : JSON.stringify(payload));
    expect(verifyToken(token, { ...OPTIONS, engineInstanceId: 1n, now: 0 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('accepts a token exactly at the maximum age and rejects it just after', () => {
    const token = signToken(CLAIMS, SECRET);
    expect(verifyToken(token, { ...OPTIONS, now: ISSUED_AT + 7 * DAY_MS }).ok).toBe(true);
    expect(verifyToken(token, { ...OPTIONS, now: ISSUED_AT + 7 * DAY_MS + 1 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('honours a configured maximum age', () => {
    const token = signToken(CLAIMS, SECRET);
    expect(verifyToken(token, { ...OPTIONS, maxAgeMs: 500 })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('tolerates small clock skew but rejects a token from the far future', () => {
    const token = signToken(CLAIMS, SECRET);
    expect(verifyToken(token, { ...OPTIONS, now: ISSUED_AT - 30_000 }).ok).toBe(true);
    expect(verifyToken(token, { ...OPTIONS, now: ISSUED_AT - 120_000 })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('rejects a token from another engine instance', () => {
    const token = signToken(CLAIMS, SECRET);
    expect(verifyToken(token, { ...OPTIONS, engineInstanceId: 1n })).toEqual({
      ok: false,
      reason: 'engineMismatch',
    });
    expect(verifyToken(token, { ...OPTIONS, engineInstanceId: undefined })).toEqual({
      ok: false,
      reason: 'engineMismatch',
    });
  });
});
