import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiKey, fakeApi, logRow, renderPage } from '../test/fixtures';
import { Log } from './Log';

beforeEach(() => {
  window.location.hash = '#/log';
});

const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => logRow({ id: from - i, request_id: `req_${from - i}xxxxxx` }));

describe('request log', () => {
  it('lists requests: who, which model, how it went', async () => {
    const api = fakeApi();
    api.log.mockResolvedValue([
      logRow({ id: 3 }),
      logRow({ id: 2, status: 429, error_code: 'rate_limited', model: null, requested_model: 'cloud/ghost', input_tokens: null, output_tokens: null, latency_ms: 3 }),
      logRow({ id: 1, status: 502, error_code: 'upstream_error', attempts: 2 }),
    ]);
    renderPage(<Log />, api);
    const rows = await screen.findAllByRole('row');
    const ok = rows[1]!;
    expect(within(ok).getByText('open-webui')).toBeInTheDocument();
    expect(within(ok).getByText('200', { selector: '.badge' })).toHaveClass('badge-ok');
    expect(within(ok).getByText('200', { selector: 'td.num' })).toBeInTheDocument(); // 120 + 80 tokens
    expect(within(rows[2]!).getByText('429')).toHaveClass('badge-warn');
    expect(within(rows[2]!).getByText('rate_limited')).toBeInTheDocument();
    expect(within(rows[3]!).getByText('502')).toHaveClass('badge-bad');
    expect(within(rows[3]!).getByText('2 attempts')).toBeInTheDocument();
    // a request that never reached a model still shows which one it asked for
    expect(within(rows[2]!).getByText('cloud/ghost')).toBeInTheDocument();
  });

  it('opens the details of one request', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.log.mockResolvedValue([logRow({ estimated: true, tag: 'private' })]);
    renderPage(<Log />, api);
    await user.click(await screen.findByRole('button', { name: 'Details' }));
    const detail = screen.getByText('Request id').closest('dl')!;
    expect(within(detail).getByText('req_0123456789abcdef')).toBeInTheDocument();
    expect(within(detail).getByText('2.1 s')).toBeInTheDocument();
    expect(within(detail).getByText('480 ms')).toBeInTheDocument();
    expect(within(detail).getByText('12 ms')).toBeInTheDocument();
    expect(within(detail).getByText(/120 in, 80 out \(estimated\)/)).toBeInTheDocument();
    expect(within(detail).getByText(/tag private/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('Request id')).not.toBeInTheDocument();
  });

  it('starts with only errors when the address says so (from the overview)', async () => {
    window.location.hash = '#/log?errors=1';
    const api = fakeApi();
    renderPage(<Log />, api);
    await waitFor(() => expect(api.log).toHaveBeenCalled());
    expect(api.log.mock.calls[0]![0]).toMatchObject({ errors: true });
    expect(screen.getByRole('switch', { name: 'Errors only' })).toBeChecked();
    expect(await screen.findByText('No failed requests.')).toBeInTheDocument();
  });

  it('filters by key and by errors, and the address follows', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.keys.list.mockResolvedValue([apiKey(), apiKey({ id: 'key_9', name: 'cli' })]);
    renderPage(<Log />, api);
    await user.selectOptions(await screen.findByLabelText('Key'), 'key_9');
    await waitFor(() => expect(api.log).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'key_9' }), expect.anything()));
    await user.click(screen.getByRole('switch', { name: 'Errors only' }));
    await waitFor(() => expect(api.log).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'key_9', errors: true }), expect.anything()));
    expect(window.location.hash).toBe('#/log?errors=1&key=key_9');
  });

  it('loads older requests below the newest, once, from the last one it has', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.log.mockImplementation(async q => (q?.before ? page(q.before - 1, 40) : page(500, 100)));
    renderPage(<Log />, api);
    await screen.findAllByRole('row');
    expect(screen.getAllByRole('row')).toHaveLength(101);
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(141));
    expect(api.log).toHaveBeenCalledWith(expect.objectContaining({ before: 401 }));
    // a short page means that is everything
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
    expect(screen.getByText('That is everything (140 requests).')).toBeInTheDocument();
  });

  it('keeps what slid out of the newest page while older requests were read, and shows nothing twice', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    // a log that grows: ids 1..500 to begin with, newest first, like the hub returns them
    let newest = 500;
    const store = (lo: number, hi: number, limit: number) => Array.from({ length: Math.min(limit, hi - lo + 1) }, (_, i) => logRow({ id: hi - i, request_id: `req_${hi - i}xxxxxx` }));
    api.log.mockImplementation(async q => (q?.before ? store(1, q.before - 1, q.limit ?? 100) : store(1, newest, q?.limit ?? 100)));
    renderPage(<Log />, api);
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(201)); // 500..301
    // 30 more requests arrive: the newest page is now 530..431, so 430..401 would have been lost
    newest = 530;
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(231)); // 530..301
    const ids = screen.getAllByRole('button', { name: 'Details' }).map(b => Number(b.getAttribute('aria-controls')?.replace('log-', '')));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(530);
    expect(ids.at(-1)).toBe(301);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids).toContain(415); // slid out of the newest page, still there
    // and the next page continues from the oldest one it has
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(331));
    expect(api.log).toHaveBeenLastCalledWith(expect.objectContaining({ before: 301 }));
  });

  it('starts over when a filter changes', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.log.mockImplementation(async q => (q?.before ? page(q.before - 1, 100) : page(500, 100)));
    renderPage(<Log />, api);
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(201));
    await user.click(screen.getByRole('switch', { name: 'Errors only' }));
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(101));
  });

  it('keeps what it has and says so when older requests cannot be fetched', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../api/client');
    const api = fakeApi();
    api.log.mockImplementation(async q => {
      if (q?.before) throw new ApiError(500, 'internal_error', 'Internal error in the hub');
      return page(500, 100);
    });
    renderPage(<Log />, api);
    await screen.findAllByRole('row');
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error in the hub');
    expect(screen.getAllByRole('row')).toHaveLength(101);
    expect(screen.getByRole('button', { name: 'Load older' })).toBeEnabled();
  });

  it('can stop refreshing by itself', async () => {
    const user = userEvent.setup();
    renderPage(<Log />);
    const auto = await screen.findByRole('switch', { name: 'Update by itself' });
    expect(auto).toBeChecked();
    await user.click(auto);
    expect(auto).not.toBeChecked();
  });

  it('explains an empty log', async () => {
    renderPage(<Log />);
    expect(await screen.findByText('No requests yet.')).toBeInTheDocument();
  });
});
