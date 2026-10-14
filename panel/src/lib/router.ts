import { useSyncExternalStore } from 'react';

/** Hash routes (`#/models?provider=pc`), so the hub needs no knowledge of the panel's pages. */
export interface Route {
  segments: string[];
  query: URLSearchParams;
}

export const parseHash = (hash: string): Route => {
  const raw = hash.replace(/^#/, '');
  const [path = '', search = ''] = raw.split('?');
  return {
    segments: path
      .split('/')
      .filter(Boolean)
      .map(s => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      }),
    query: new URLSearchParams(search),
  };
};

export function href(segments: string[], query?: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v) q.set(k, v);
  const s = q.toString();
  return `#/${segments.map(encodeURIComponent).join('/')}${s ? `?${s}` : ''}`;
}

export const navigate = (segments: string[], query?: Record<string, string | undefined>): void => {
  globalThis.location.hash = href(segments, query);
};

/** Change the query without adding a history entry for every keystroke in a filter box. */
export function replaceQuery(segments: string[], query: Record<string, string | undefined>): void {
  globalThis.history.replaceState(null, '', href(segments, query));
  globalThis.dispatchEvent(new HashChangeEvent('hashchange'));
}

const subscribe = (fn: () => void) => {
  globalThis.addEventListener('hashchange', fn);
  return () => globalThis.removeEventListener('hashchange', fn);
};
const snapshot = () => globalThis.location.hash;

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot, () => '');
  return parseHash(hash);
}
