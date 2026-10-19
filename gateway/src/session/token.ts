// Stateless session tokens: base64url(JSON payload) "." base64url(signature),
// where the signature is HMAC-SHA256 over the first part, keyed by
// SESSION_SECRET. The gateway keeps no session table; a token is valid if its
// signature checks out, it is not too old, and it was issued against the
// engine instance that is running now (a restarted engine has lost the book).
import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { validateDisplayName } from './name.js';
import { MAX_HUMAN_TRADER_ID, MIN_HUMAN_TRADER_ID } from './trader-ids.js';

// Far above any real token; rejects oversized input before any work.
export const MAX_TOKEN_LENGTH = 1024;

// A token issued slightly in the future (clock adjustment) is tolerated.
const MAX_CLOCK_SKEW_MS = 60_000;

const SIGNATURE_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface SessionClaims {
  readonly traderId: number;
  readonly name: string;
  readonly engineInstanceId: bigint;
  // Issue time, Unix milliseconds.
  readonly issuedAt: number;
}

// The wire form of the payload. The engine instance ID is a u64, so it is a
// decimal string: JSON has no 64-bit integers.
const payloadSchema = z.strictObject({
  v: z.literal(1),
  traderId: z.number().int().min(MIN_HUMAN_TRADER_ID).max(MAX_HUMAN_TRADER_ID),
  name: z.string().refine((name) => {
    const result = validateDisplayName(name);
    return result.ok && result.name === name;
  }),
  engineInstanceId: z.string().regex(/^(0|[1-9][0-9]{0,19})$/),
  iat: z.number().int().nonnegative(),
});

type Payload = z.infer<typeof payloadSchema>;

export type TokenRejection = 'malformed' | 'badSignature' | 'expired' | 'engineMismatch';

export type TokenVerification =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: TokenRejection };

export interface VerifyOptions {
  readonly secret: string;
  readonly maxAgeMs: number;
  readonly engineInstanceId: bigint | undefined;
  readonly now: number;
}

function sign(encodedPayload: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest();
}

export function signToken(claims: SessionClaims, secret: string): string {
  const payload: Payload = {
    v: 1,
    traderId: claims.traderId,
    name: claims.name,
    engineInstanceId: claims.engineInstanceId.toString(),
    iat: claims.issuedAt,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload, secret).toString('base64url')}`;
}

export function verifyToken(token: unknown, options: VerifyOptions): TokenVerification {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  const [encodedPayload, encodedSignature] = parts;
  if (
    parts.length !== 2 ||
    encodedPayload === undefined ||
    encodedSignature === undefined ||
    !BASE64URL.test(encodedPayload) ||
    !BASE64URL.test(encodedSignature)
  ) {
    return { ok: false, reason: 'malformed' };
  }

  // Nothing in the payload is trusted, or even parsed, until it is
  // authenticated.
  const signature = Buffer.from(encodedSignature, 'base64url');
  const expected = sign(encodedPayload, options.secret);
  if (signature.length !== SIGNATURE_BYTES || !timingSafeEqual(signature, expected)) {
    return { ok: false, reason: 'badSignature' };
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = payloadSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = parsed.data;

  if (payload.iat > options.now + MAX_CLOCK_SKEW_MS) {
    return { ok: false, reason: 'malformed' };
  }
  if (options.now - payload.iat > options.maxAgeMs) {
    return { ok: false, reason: 'expired' };
  }
  const engineInstanceId = BigInt(payload.engineInstanceId);
  if (engineInstanceId !== options.engineInstanceId) {
    return { ok: false, reason: 'engineMismatch' };
  }
  return {
    ok: true,
    claims: {
      traderId: payload.traderId,
      name: payload.name,
      engineInstanceId,
      issuedAt: payload.iat,
    },
  };
}
