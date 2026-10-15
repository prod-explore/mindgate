import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRow } from '../api/types';
import { apiKey, cloud, fakeApi, provider, renderPage, usage } from '../test/fixtures';
import { Usage } from './Usage';

beforeEach(() => {
  window.location.hash = '#/usage';
  // only the clock: timers must keep running for the test helpers
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const row = (over: Partial<UsageRow>): UsageRow => ({ day: '2026-10-14', key_id: 'key_1', model: 'home/qwen3:4b', requests: 1, errors: 0, input_tokens: 0, output_tokens: 0, ...over });

/** A key that still exists (open-webui), one that was deleted, a local model and a cloud one. */
const DATA = [
  row({ day: '2026-10-13', model: 'home/qwen3:4b', requests: 10, errors: 1, input_tokens: 1000, output_tokens: 500 }),
  row({ day: '2026-10-14', model: 'openrouter/deepseek/deepseek-chat', requests: 5, input_tokens: 2000, output_tokens: 1000 }),
  row({ day: '2026-10-14', key_id: 'key_gone', model: 'home/qwen3:4b', requests: 3, input_tokens: 500, output_tokens: 500 }),
];

function seeded() {
  const api = fakeApi();
  api.usage.mockResolvedValue(usage(DATA));
  api.keys.list.mockResolvedValue([apiKey()]);
  api.providers.list.mockResolvedValue([provider(), cloud()]);
  return api;
}

const figure = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.figure') as HTMLElement;

describe('usage', () => {
  it('asks for the last 30 days, in the hub’s days, and adds everything up', async () => {
    const api = seeded();
    renderPage(<Usage />, api);
    await screen.findByText('By model');
    expect(api.usage).toHaveBeenCalledWith({ from: '2026-09-15', to: '2026-10-14' }, expect.anything());
    // 18 requests, 1 failed; 3,500 tokens in and 2,000 out
    expect(within(figure('Requests')).getByText('18')).toBeInTheDocument();
    expect(within(figure('Tokens')).getByText('5.5K')).toBeInTheDocument();
    expect(within(figure('Tokens')).getByText('3.5K in, 2K out')).toBeInTheDocument();
    expect(within(figure('Errors')).getByText('1')).toBeInTheDocument();
    expect(within(figure('Errors')).getByText('5.6%')).toBeInTheDocument();
    // 1,500 + 1,000 of 5,500 tokens ran at home
    expect(within(figure('On your hardware')).getByText('45%')).toBeInTheDocument();
  });

  it('names a key that has been deleted since, and says where each model runs', async () => {
    renderPage(<Usage />, seeded());
    const keysTable = (await screen.findByRole('heading', { name: 'By key' })).closest('section')!;
    expect(within(keysTable).getByText('open-webui')).toBeInTheDocument();
    expect(within(keysTable).getByText('(deleted key)')).toBeInTheDocument();
    const modelsTable = screen.getByRole('heading', { name: 'By model' }).closest('section')!;
    const local = within(modelsTable).getByText('qwen3:4b').closest('tr')!;
    const remote = within(modelsTable).getByText('deepseek/deepseek-chat').closest('tr')!;
    expect(within(local).getByText('local')).toBeInTheDocument();
    expect(within(remote).getByText('cloud')).toBeInTheDocument();
    // the cloud model had the most tokens, so it comes first
    const names = within(modelsTable).getAllByRole('row').slice(1).map(r => r.textContent);
    expect(names[0]).toContain('deepseek');
  });

  it('narrows by key or model in the browser, without asking the hub again', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<Usage />, api);
    await screen.findByText('By model');
    await user.selectOptions(screen.getByLabelText('Key'), 'key_gone');
    expect(within(figure('Requests')).getByText('3')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/usage?key=key_gone');
    await user.selectOptions(screen.getByLabelText('Key'), '');
    await user.selectOptions(screen.getByLabelText('Model'), 'openrouter/deepseek/deepseek-chat');
    expect(within(figure('Requests')).getByText('5')).toBeInTheDocument();
    expect(within(figure('On your hardware')).getByText('0%')).toBeInTheDocument();
    expect(api.usage).toHaveBeenCalledTimes(1);
  });

  it('says so when a selection holds nothing', async () => {
    const user = userEvent.setup();
    renderPage(<Usage />, seeded());
    await screen.findByText('By model');
    await user.selectOptions(screen.getByLabelText('Key'), 'key_gone');
    await user.selectOptions(screen.getByLabelText('Model'), 'openrouter/deepseek/deepseek-chat');
    expect(await screen.findByText('Nothing in this selection.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'By model' })).not.toBeInTheDocument();
  });

  it('switches what the chart counts, and the address follows', async () => {
    const user = userEvent.setup();
    renderPage(<Usage />, seeded());
    await screen.findByText('By model');
    const tokens = screen.getByRole('button', { name: 'Tokens' });
    expect(screen.getByRole('button', { name: 'Requests' })).toHaveAttribute('aria-pressed', 'true');
    expect(tokens).toHaveAttribute('aria-pressed', 'false');
    await user.click(tokens);
    expect(tokens).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Tokens per day, last 30 days' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/usage?metric=tokens');
  });

  it('fetches again for another period, and keeps the default out of the address', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<Usage />, api);
    await screen.findByText('By model');
    await user.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(api.usage).toHaveBeenLastCalledWith({ from: '2026-10-08', to: '2026-10-14' }, expect.anything()));
    expect(window.location.hash).toBe('#/usage?days=7');
    await user.click(screen.getByRole('button', { name: '30 days' }));
    expect(window.location.hash).toBe('#/usage');
  });

  it('starts from the address', async () => {
    window.location.hash = '#/usage?days=90&metric=errors&key=key_1';
    const api = seeded();
    renderPage(<Usage />, api);
    await screen.findByText('By model');
    expect(api.usage).toHaveBeenCalledWith({ from: '2026-07-17', to: '2026-10-14' }, expect.anything());
    expect(screen.getByRole('button', { name: '90 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Errors' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Key')).toHaveValue('key_1');
    expect(within(figure('Requests')).getByText('15')).toBeInTheDocument();
  });

  it('explains a hub that cannot be reached, with a way to try again', async () => {
    const { ApiError } = await import('../api/client');
    const api = seeded();
    api.usage.mockRejectedValue(new ApiError(500, 'internal_error', 'Internal error in the hub'));
    renderPage(<Usage />, api);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
