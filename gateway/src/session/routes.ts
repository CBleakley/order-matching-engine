// POST /api/session: join with a display name.
//
//   request:  { "name": string }
//   200:      { "token": string, "traderId": number, "name": string }
//   400:      { "error": "invalidName", "message": string }
//   429:      { "error": "rateLimited" } with Retry-After (seconds)
//   503:      { "error": "engineUnavailable" }
//
// The token is only ever sent in this response body; it is never logged.
import { z } from 'zod';

import type { GatewayServer } from '../server.js';
import type { SlidingWindowRateLimiter } from './rate-limiter.js';
import type { SessionService } from './session-service.js';
import { TraderIdExhaustedError } from './trader-ids.js';

export interface SessionRoutesOptions {
  readonly sessions: SessionService;
  // Keyed by client IP.
  readonly rateLimiter: SlidingWindowRateLimiter;
}

export type SessionErrorResponse =
  | { readonly error: 'invalidName'; readonly message: string }
  | { readonly error: 'rateLimited' }
  | { readonly error: 'engineUnavailable' };

const BODY_LIMIT_BYTES = 1024;

const bodySchema = z.object({ name: z.unknown() });

export function registerSessionRoutes(server: GatewayServer, options: SessionRoutesOptions): void {
  server.post('/api/session', { bodyLimit: BODY_LIMIT_BYTES }, (request, reply) => {
    const limit = options.rateLimiter.hit(request.ip);
    if (!limit.allowed) {
      const body: SessionErrorResponse = { error: 'rateLimited' };
      return reply
        .code(429)
        .header('retry-after', String(Math.max(1, Math.ceil(limit.retryAfterMs / 1000))))
        .send(body);
    }

    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      const body: SessionErrorResponse = {
        error: 'invalidName',
        message: 'Request body must be a JSON object with a "name" field',
      };
      return reply.code(400).send(body);
    }

    let result;
    try {
      result = options.sessions.create(parsed.data.name);
    } catch (error) {
      if (error instanceof TraderIdExhaustedError) {
        request.log.error({ err: error }, 'trader ID allocation failed');
        const body: SessionErrorResponse = { error: 'engineUnavailable' };
        return reply.code(503).send(body);
      }
      throw error;
    }

    if (!result.ok) {
      const body: SessionErrorResponse =
        result.error === 'invalidName'
          ? { error: 'invalidName', message: result.message }
          : { error: 'engineUnavailable' };
      return reply.code(result.error === 'invalidName' ? 400 : 503).send(body);
    }
    request.log.info({ traderId: result.session.traderId }, 'session created');
    return reply.code(200).send(result.session);
  });
}
