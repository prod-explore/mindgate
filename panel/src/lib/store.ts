import { useSyncExternalStore } from 'react';

/** A tiny observable value, so that sessions, themes, languages and toasts can live outside React. */
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      const v = typeof next === 'function' ? (next as (p: T) => T)(value) : next;
      if (Object.is(v, value)) return;
      value = v;
      for (const l of [...listeners]) l();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const useStore = <T,>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get, s.get);

/** localStorage / sessionStorage can be missing or throw (private windows, blocked site data). */
export function safeStorage(kind: 'local' | 'session'): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  const get = (): Storage | null => {
    try {
      return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    } catch {
      return null;
    }
  };
  return {
    getItem: k => {
      try {
        return get()?.getItem(k) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (k, v) => {
      try {
        get()?.setItem(k, v);
      } catch {
        /* ignore */
      }
    },
    removeItem: k => {
      try {
        get()?.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}
