import { createStore, safeStorage, useStore } from './store';

const KEY = 'mindgate.admin-token';
const session = safeStorage('session');
const local = safeStorage('local');

interface SessionState {
  token: string | null;
  /** Set when the hub refused the token we had, so the login screen can say why. */
  expired: boolean;
}

const store = createStore<SessionState>({ token: session.getItem(KEY) ?? local.getItem(KEY), expired: false });

export const getToken = (): string | null => store.get().token;
export const useSession = (): SessionState => useStore(store);

/** The token lives in this tab only, unless the person asks to keep it on this device. */
export function signIn(token: string, remember: boolean): void {
  session.removeItem(KEY);
  local.removeItem(KEY);
  (remember ? local : session).setItem(KEY, token);
  store.set({ token, expired: false });
}

export function signOut(expired = false): void {
  session.removeItem(KEY);
  local.removeItem(KEY);
  store.set({ token: null, expired });
}
