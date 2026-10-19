// A minimal external store around `reduce`, read from React with
// useSyncExternalStore. One store per page; tests make their own.
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

import { type AppAction, type AppState, initialState, reduce } from './app-state.js';

export interface Store {
  // Properties rather than methods: they are passed around unbound.
  readonly getState: () => AppState;
  readonly dispatch: (action: AppAction) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createStore(initial: AppState = initialState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = reduce(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// The page's store. main.tsx connects it to the gateway once the viewer has joined (P1-16).
export const appStore = createStore();

export const StoreContext = createContext<Store>(appStore);

export function useStore(): Store {
  return useContext(StoreContext);
}

// Re-renders only when the selected value changes (by Object.is). Selectors
// must return existing state values, not new objects, or React loops.
export function useAppState<T>(selector: (state: AppState) => T): T {
  const store = useStore();
  const getSnapshot = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}
