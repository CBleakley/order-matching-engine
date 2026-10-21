import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { JoinFn } from '../src/session/join-api.js';
import { type ConnectFn, SessionGate } from '../src/session/SessionGate.js';
import { createSessionStore, type Session } from '../src/session/session-store.js';
import { createStore, StoreContext } from '../src/state/store.js';
import { welcome } from './messages.js';

const SESSION: Session = { token: 'payload.signature', traderId: 1_000_001, name: 'Ada' };

afterEach(() => {
  window.localStorage.clear();
});

// Records each connection, so tests can expire it and see it stopped.
function fakeConnect() {
  const connections: { session: Session; onExpired: () => void; stop: () => void }[] = [];
  const connect = vi.fn<ConnectFn>((_store, session, onExpired) => {
    const stop = vi.fn();
    connections.push({ session, onExpired, stop });
    return stop;
  });
  return { connect, connections };
}

function renderGate(saved: Session | null = null) {
  const sessionStore = createSessionStore();
  if (saved !== null) sessionStore.save(saved);
  const store = createStore();
  const join = vi.fn<JoinFn>(() => Promise.resolve({ ok: true, session: SESSION }));
  const { connect, connections } = fakeConnect();
  render(
    <StoreContext value={store}>
      <SessionGate sessionStore={sessionStore} join={join} connect={connect} />
    </StoreContext>,
  );
  return { sessionStore, store, join, connect, connections };
}

async function joinAs(name: string) {
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: name } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start trading' }));
    await Promise.resolve();
  });
}

const joinHeading = () => screen.queryByRole('heading', { name: 'Join the practice market' });

describe('SessionGate', () => {
  it('shows the join screen on a first visit, then connects with the new token', async () => {
    const { sessionStore, connect, connections } = renderGate();
    expect(joinHeading()).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();

    await joinAs('Ada');

    expect(joinHeading()).not.toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.session).toEqual(SESSION);
    expect(sessionStore.load()).toEqual(SESSION);
  });

  it('resumes a stored session without asking for a name', () => {
    const { connections } = renderGate(SESSION);
    expect(joinHeading()).not.toBeInTheDocument();
    expect(connections).toHaveLength(1);
    expect(connections[0]?.session.token).toBe(SESSION.token);
  });

  it('shows the name in the header, preferring the one the gateway confirms', () => {
    const { store } = renderGate(SESSION);
    const header = screen.getByRole('banner');
    expect(within(header).getByText('Ada')).toBeInTheDocument();

    act(() => {
      store.dispatch({
        type: 'server',
        message: { ...welcome(), you: { traderId: 1_000_001, name: 'Ada L' } },
      });
    });
    expect(within(header).getByText('Ada L')).toBeInTheDocument();
  });

  it('returns to the join screen with an explanation when the session expires', async () => {
    const { sessionStore, connections } = renderGate(SESSION);

    act(() => {
      connections[0]?.onExpired();
    });

    expect(joinHeading()).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/session has ended/);
    expect(sessionStore.load()).toBeNull();
    expect(connections[0]?.stop).toHaveBeenCalled();

    // Joining again connects afresh and drops the notice.
    await joinAs('Ada');
    expect(connections).toHaveLength(2);
    expect(joinHeading()).not.toBeInTheDocument();
  });

  it('leaves: forgets the token, disconnects and shows the join screen', () => {
    const { sessionStore, connections } = renderGate(SESSION);

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));

    expect(joinHeading()).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(sessionStore.load()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(connections[0]?.stop).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Display name')).toHaveFocus();
  });
});
