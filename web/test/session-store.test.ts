import { afterEach, describe, expect, it } from 'vitest';

import {
  createSessionStore,
  type Session,
  SESSION_STORAGE_KEY,
} from '../src/session/session-store.js';

const SESSION: Session = { token: 'payload.signature', traderId: 1_000_001, name: 'Ada' };

afterEach(() => {
  window.localStorage.clear();
});

// A Storage whose every method throws, as in some private windows.
const brokenStorage = (): Storage => {
  throw new DOMException('denied', 'SecurityError');
};

describe('createSessionStore', () => {
  it('has no session at first', () => {
    expect(createSessionStore().load()).toBeNull();
  });

  it('saves to localStorage, so a new page load resumes the session', () => {
    createSessionStore().save(SESSION);
    expect(createSessionStore().load()).toEqual(SESSION);
  });

  it('clears the stored session', () => {
    const store = createSessionStore();
    store.save(SESSION);
    store.clear();
    expect(store.load()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it.each([
    'not json',
    'null',
    JSON.stringify({ token: 'abc', traderId: 1_000_001, name: 'Ada' }),
    JSON.stringify({ v: 2, token: 'abc', traderId: 1_000_001, name: 'Ada' }),
    JSON.stringify({ v: 1, token: '', traderId: 1_000_001, name: 'Ada' }),
    JSON.stringify({ v: 1, token: 'abc', traderId: 'x', name: 'Ada' }),
  ])('discards the stored value %j', (raw) => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, raw);
    expect(createSessionStore().load()).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it('keeps the session in memory when storage throws', () => {
    const store = createSessionStore(brokenStorage);
    expect(store.load()).toBeNull();
    store.save(SESSION);
    expect(store.load()).toEqual(SESSION);
    store.clear();
    expect(store.load()).toBeNull();
  });

  it('keeps the session in memory when storage is full', () => {
    const full: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    // The store only uses these three methods.
    const store = createSessionStore(() => full as Storage);
    store.save(SESSION);
    expect(store.load()).toEqual(SESSION);
  });
});
