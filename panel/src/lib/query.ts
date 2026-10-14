import { useCallback, useEffect, useRef, useState } from 'react';

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** No answer yet for the current inputs. */
  loading: boolean;
  /** A request is on its way (also while old data is on screen). */
  refreshing: boolean;
  reload: () => Promise<void>;
}

export interface QueryOptions {
  /** Ask again every so many milliseconds while the page is visible. */
  every?: number;
  enabled?: boolean;
}

/**
 * Loads data and keeps it fresh. Old data stays on screen while new data loads (no flicker on a filter change or
 * a poll); a failed refresh keeps the data and reports the error next to it.
 */
export function useQuery<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[], options: QueryOptions = {}): QueryResult<T> {
  const { every, enabled = true } = options;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(enabled);
  const [refreshing, setRefreshing] = useState(enabled);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const abortRef = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const seq = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const run = useCallback(async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const mine = ++seq.current;
    const ac = new AbortController();
    abortRef.current = ac;
    setRefreshing(true);
    try {
      const result = await fetcherRef.current(ac.signal);
      if (ac.signal.aborted || mine !== seq.current) return;
      setData(result);
      setError(null);
    } catch (e) {
      if (ac.signal.aborted || mine !== seq.current) return;
      setError(e);
    } finally {
      // an answer that no longer matters (new inputs, unmount) must not touch the state of the newer request
      if (mine === seq.current) {
        busy.current = false;
        if (!ac.signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    setLoading(true);
    void run();
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = () => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void run();
    };
    if (every) timer = setInterval(tick, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && every) void run();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      abortRef.current?.abort();
      busy.current = false;
      seq.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, every, run, ...deps]);

  const reload = useCallback(async () => {
    // a query that is switched off stays off, also for "refresh" buttons that refresh everything on the page
    if (!enabledRef.current) return;
    abortRef.current?.abort();
    busy.current = false;
    await run();
  }, [run]);

  return { data, error, loading, refreshing, reload };
}
