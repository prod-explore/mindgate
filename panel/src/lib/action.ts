import { useCallback, useRef, useState } from 'react';
import { describeError } from './errors';
import { toast } from './toast';

export interface ActionOptions<R> {
  /** Said in a toast when it worked. */
  ok?: string | ((result: R) => string);
  /** Errors go into `error` (for a form to show) instead of a toast. */
  inline?: boolean;
}

export interface Action<A extends unknown[], R> {
  run: (...args: A) => Promise<R | undefined>;
  pending: boolean;
  error: string | null;
  clearError: () => void;
}

/** Runs something that changes data: one at a time, with its error reported where the caller wants it. */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>, options: ActionOptions<R> = {}): Action<A, R> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const optRef = useRef(options);
  optRef.current = options;
  const running = useRef(false);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await fnRef.current(...args);
      const ok = optRef.current.ok;
      if (ok) toast.ok(typeof ok === 'function' ? ok(result) : ok);
      return result;
    } catch (e) {
      const text = describeError(e);
      if (optRef.current.inline) setError(text);
      else toast.error(text);
      return undefined;
    } finally {
      running.current = false;
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: () => setError(null) };
}
