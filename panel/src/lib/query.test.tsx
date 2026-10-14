import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useQuery } from './query';

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('useQuery', () => {
  it('loads once and then has data', async () => {
    const fetcher = vi.fn(async () => 'one');
    const { result } = renderHook(() => useQuery(fetcher, []));
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(result.current.data).toBe('one'));
    expect(result.current.loading).toBe(false);
    expect(result.current.refreshing).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps the old data while it asks again, and when asking again fails', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => {
      n++;
      if (n === 2) throw new Error('hub down');
      return `answer ${n}`;
    });
    const { result } = renderHook(() => useQuery(fetcher, []));
    await waitFor(() => expect(result.current.data).toBe('answer 1'));

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('answer 1'); // not blanked by the failure
    expect((result.current.error as Error).message).toBe('hub down');

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.data).toBe('answer 3');
    expect(result.current.error).toBeNull(); // and the error goes away with the next good answer
  });

  it('polls', async () => {
    const fetcher = vi.fn(async () => Date.now());
    renderHook(() => useQuery(fetcher, [], { every: 20 }));
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
  });

  it('does not poll while the page is hidden', async () => {
    const fetcher = vi.fn(async () => 1);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderHook(() => useQuery(fetcher, [], { every: 15 }));
    await new Promise(r => setTimeout(r, 120));
    expect(fetcher).toHaveBeenCalledTimes(1); // the first load only
    hidden.mockReturnValue('visible');
    await waitFor(() => expect(fetcher.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
  });

  it('asks again when its inputs change, and ignores the answer to the old question', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fetcher = vi.fn((_signal: AbortSignal) => (fetcher.mock.calls.length === 1 ? first.promise : second.promise));
    const { result, rerender } = renderHook(({ q }) => useQuery(fetcher, [q]), { initialProps: { q: 'a' } });
    rerender({ q: 'b' });
    await act(async () => {
      second.resolve('answer for b');
      await second.promise;
    });
    await waitFor(() => expect(result.current.data).toBe('answer for b'));
    await act(async () => {
      first.resolve('late answer for a');
      await first.promise;
    });
    expect(result.current.data).toBe('answer for b');
    expect(fetcher.mock.calls[0]![0].aborted).toBe(true);
  });

  it('does not ask while disabled', async () => {
    const fetcher = vi.fn(async () => 1);
    const { result, rerender } = renderHook(({ on }) => useQuery(fetcher, [], { enabled: on }), { initialProps: { on: false } });
    await new Promise(r => setTimeout(r, 30));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    rerender({ on: true });
    await waitFor(() => expect(result.current.data).toBe(1));
  });

  it('does not ask on reload either while disabled', async () => {
    const fetcher = vi.fn(async () => 1);
    const { result } = renderHook(() => useQuery(fetcher, [], { enabled: false }));
    await act(async () => {
      await result.current.reload();
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops when it goes away', async () => {
    const d = deferred<string>();
    let signal!: AbortSignal;
    const fetcher = vi.fn((s: AbortSignal) => {
      signal = s;
      return d.promise;
    });
    const { unmount } = renderHook(() => useQuery(fetcher, []));
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    unmount();
    expect(signal.aborted).toBe(true);
  });
});
