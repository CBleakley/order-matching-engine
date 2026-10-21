// The page root: the join screen until the viewer has a session, then the
// dashboard connected to the gateway. A stored session is resumed without
// asking; if the gateway rejects its token the viewer is sent back to join.
import { useCallback, useEffect, useMemo, useState } from 'react';

import { App } from '../App.js';
import { GatewayClient } from '../connection/gateway-client.js';
import { type Store, useStore } from '../state/store.js';
import { type JoinFn, joinSession } from './join-api.js';
import { type JoinNotice, JoinScreen } from './JoinScreen.js';
import { SessionContext, type SessionContextValue } from './session-context.js';
import { createSessionStore, type Session, type SessionStore } from './session-store.js';

// Starts feeding `store` from the gateway as `session`; returns a function
// that disconnects. `onExpired` is called if the gateway rejects the token.
export type ConnectFn = (store: Store, session: Session, onExpired: () => void) => () => void;

export const connectGateway: ConnectFn = (store, session, onExpired) => {
  const client = new GatewayClient({
    store,
    getToken: () => session.token,
    onSessionExpired: onExpired,
  });
  client.start();
  return () => {
    client.stop();
  };
};

interface SessionGateProps {
  readonly sessionStore?: SessionStore;
  readonly join?: JoinFn;
  readonly connect?: ConnectFn;
}

const defaultSessionStore = createSessionStore();

export function SessionGate({
  sessionStore = defaultSessionStore,
  join = joinSession,
  connect = connectGateway,
}: SessionGateProps) {
  const store = useStore();
  const [session, setSession] = useState<Session | null>(() => sessionStore.load());
  const [notice, setNotice] = useState<JoinNotice | null>(null);

  const end = useCallback(
    (reason: JoinNotice | null) => {
      sessionStore.clear();
      store.dispatch({ type: 'reset' });
      setSession(null);
      setNotice(reason);
    },
    [sessionStore, store],
  );

  useEffect(() => {
    if (session === null) return;
    return connect(store, session, () => {
      end('expired');
    });
  }, [connect, store, session, end]);

  const context = useMemo<SessionContextValue | null>(
    () =>
      session === null
        ? null
        : {
            name: session.name,
            leave: () => {
              end(null);
            },
          },
    [session, end],
  );

  if (context === null) {
    return (
      <JoinScreen
        join={join}
        notice={notice}
        onJoined={(joined) => {
          sessionStore.save(joined);
          setNotice(null);
          setSession(joined);
        }}
      />
    );
  }
  return (
    <SessionContext value={context}>
      <App />
    </SessionContext>
  );
}
