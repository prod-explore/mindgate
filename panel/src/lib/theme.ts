import { createStore, safeStorage, useStore } from './store';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'mindgate.theme';
const storage = safeStorage('local');

const read = (): ThemeChoice => {
  const v = storage.getItem(KEY);
  return v === 'light' || v === 'dark' ? v : 'system';
};

const store = createStore<ThemeChoice>(read());

export function applyTheme(choice: ThemeChoice = store.get()): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export const useTheme = (): [ThemeChoice, (c: ThemeChoice) => void] => [
  useStore(store),
  c => {
    storage.setItem(KEY, c);
    store.set(c);
    applyTheme(c);
  },
];
