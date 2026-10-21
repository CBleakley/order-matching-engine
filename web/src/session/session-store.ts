// Remembers the viewer's session across page loads, so a returning visitor
// skips the join screen. Storage can be missing or throw (private windows,
// blocked site data), so every access falls back to memory: the session then
// lasts for this page view only. The token is a secret and is never logged.
import { type JoinResponse, joinResponseSchema } from '@ome/shared';

export type Session = JoinResponse;

export interface SessionStore {
  readonly load: () => Session | null;
  readonly save: (session: Session) => void;
  readonly clear: () => void;
}

export const SESSION_STORAGE_KEY = 'nova.session';

const STORAGE_VERSION = 1;

export function createSessionStore(
  getStorage: () => Storage = () => window.localStorage,
): SessionStore {
  let inMemory: Session | null = null;

  return {
    load() {
      let raw: string | null;
      try {
        raw = getStorage().getItem(SESSION_STORAGE_KEY);
      } catch {
        return inMemory;
      }
      if (raw === null) return inMemory;
      const session = parseStored(raw);
      if (session === null) {
        // Corrupt or from an older build: forget it and join again.
        removeStored(getStorage);
      }
      return session;
    },
    save(session) {
      inMemory = session;
      try {
        getStorage().setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ v: STORAGE_VERSION, ...session }),
        );
      } catch {
        // Kept in memory only.
      }
    },
    clear() {
      inMemory = null;
      removeStored(getStorage);
    },
  };
}

function parseStored(raw: string): Session | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== 'object' || json === null || !('v' in json) || json.v !== STORAGE_VERSION) {
    return null;
  }
  const parsed = joinResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  const { token, traderId, name } = parsed.data;
  return { token, traderId, name };
}

function removeStored(getStorage: () => Storage): void {
  try {
    getStorage().removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Nothing stored that could be read back.
  }
}
