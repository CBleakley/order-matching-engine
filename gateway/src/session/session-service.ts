// Issues and verifies anonymous sessions. A session is a display name, a
// gateway-assigned human trader ID and the engine instance it belongs to,
// carried in a signed token (see token.ts).
import type { EngineStatus } from '../engine/engine-client.js';

import { validateDisplayName } from './name.js';
import { signToken, verifyToken, type SessionClaims, type TokenVerification } from './token.js';
import type { TraderIdRegistry } from './trader-ids.js';

export interface SessionServiceOptions {
  readonly secret: string;
  readonly maxAgeMs: number;
  // Sessions are only issued while connected, since the engine instance may
  // change during a disconnection. Tokens are verified against the current or
  // last instance, so a brief disconnection does not force everyone to re-join.
  readonly engineStatus: () => Pick<EngineStatus, 'connected' | 'engineInstanceId'>;
  readonly traderIds: TraderIdRegistry;
  readonly now?: () => number;
}

export interface IssuedSession {
  readonly token: string;
  readonly traderId: number;
  readonly name: string;
}

export type CreateSessionResult =
  | { readonly ok: true; readonly session: IssuedSession }
  | { readonly ok: false; readonly error: 'invalidName'; readonly message: string }
  | { readonly ok: false; readonly error: 'engineUnavailable' };

export class SessionService {
  readonly #secret: string;
  readonly #maxAgeMs: number;
  readonly #engineStatus: () => Pick<EngineStatus, 'connected' | 'engineInstanceId'>;
  readonly #traderIds: TraderIdRegistry;
  readonly #now: () => number;

  constructor(options: SessionServiceOptions) {
    this.#secret = options.secret;
    this.#maxAgeMs = options.maxAgeMs;
    this.#engineStatus = options.engineStatus;
    this.#traderIds = options.traderIds;
    this.#now = options.now ?? Date.now;
  }

  // Throws TraderIdExhaustedError if no free trader ID can be drawn.
  create(rawName: unknown): CreateSessionResult {
    const validation = validateDisplayName(rawName);
    if (!validation.ok) {
      return { ok: false, error: 'invalidName', message: validation.message };
    }
    const { connected, engineInstanceId } = this.#engineStatus();
    if (!connected || engineInstanceId === undefined) {
      return { ok: false, error: 'engineUnavailable' };
    }
    const claims: SessionClaims = {
      traderId: this.#traderIds.allocate(),
      name: validation.name,
      engineInstanceId,
      issuedAt: this.#now(),
    };
    return {
      ok: true,
      session: {
        token: signToken(claims, this.#secret),
        traderId: claims.traderId,
        name: claims.name,
      },
    };
  }

  // Verifies a token presented by a client. A valid token's trader ID is
  // recorded as known, so it is never handed to someone else.
  verify(token: unknown): TokenVerification {
    const result = verifyToken(token, {
      secret: this.#secret,
      maxAgeMs: this.#maxAgeMs,
      engineInstanceId: this.#engineStatus().engineInstanceId,
      now: this.#now(),
    });
    if (result.ok) {
      this.#traderIds.add(result.claims.traderId);
    }
    return result;
  }
}
