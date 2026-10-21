import { createContext, useContext } from 'react';

export interface SessionContextValue {
  // The name the viewer joined with; shown until `welcome` confirms it.
  readonly name: string;
  // Forgets the session and returns to the join screen.
  readonly leave: () => void;
}

// Null outside SessionGate (e.g. the dashboard rendered alone in tests).
export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue | null {
  return useContext(SessionContext);
}
