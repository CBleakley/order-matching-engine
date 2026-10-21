// The bodies of POST /api/session (gateway/src/session/routes.ts), so the web
// client can validate what the gateway sends back.
//
//   request:  { "name": string }
//   200:      { "token": string, "traderId": number, "name": string }
//   400:      { "error": "invalidName", "message": string }
//   429:      { "error": "rateLimited" } with Retry-After (seconds)
//   503:      { "error": "engineUnavailable" }
import { z } from 'zod';

import { MAX_TOKEN_LENGTH } from './protocol.js';

export const SESSION_PATH = '/api/session';

export const joinResponseSchema = z.object({
  token: z.string().min(1).max(MAX_TOKEN_LENGTH),
  traderId: z.number().int().positive(),
  name: z.string().min(1),
});

export type JoinResponse = z.infer<typeof joinResponseSchema>;

export const joinErrorResponseSchema = z.discriminatedUnion('error', [
  z.object({ error: z.literal('invalidName'), message: z.string() }),
  z.object({ error: z.literal('rateLimited') }),
  z.object({ error: z.literal('engineUnavailable') }),
]);

export type JoinErrorResponse = z.infer<typeof joinErrorResponseSchema>;
