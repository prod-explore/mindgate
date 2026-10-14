import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UsageRow } from '../api/types';
import { setLang } from '../i18n';
import { cloud, fakeApi, logRow, provider, renderPage, usage } from '../test/fixtures';
import { Overview } from './Overview';

beforeEach(() => {
  setLang('en');
  window.location.hash = '#/';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-14T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const row = (over: Partial<UsageRow>): UsageRow => ({ day: '2026-10-14', key_id: 'key_1', model: 'home/qwen3:4b', requests: 1, errors: 0, input_tokens: 0, output_tokens: 0, ...over });
const figure = (label: string) => screen.getByText(label, { selector: 'dt' }).closest('.figure') as HTMLElement;
const rowOf = async (name: string) => (await screen.findByText(name, { selector: '.cell-main' })).closest('tr')!;

describe('overview', () => {
  it('invites to add a first provider when there is none', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([]);
    renderPage(<Overview />, api);
    expect(await screen.findByText('No providers yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add provider' })).toHaveAttribute('href', '#/providers?add=1');
  });

  it('shows each provider’s state, queue and problem; a machine links to its page', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([
      provider({ status: 'unknown', last_error: 'no answer on port 3001', queue: { running: 3, queued: 4 } }),
      cloud({ last_sync_error: 'HTTP 401: invalid key' }),
      cloud({ id: 'gemini', name: 'Gemini', api_key_unreadable: true }),
    ]);
    renderPage(<Overview />, api);
    const home = await rowOf('Home PC');
    expect(within(home).getByRole('link', { name: 'Home PC' })).toHaveAttribute('href', '#/nodes/home');
    expect(within(home).getByText('machine')).toBeInTheDocument();
    expect(within(home).getByText('Unknown')).toBeInTheDocument();
    expect(within(home).getByText('no answer on port 3001')).toBeInTheDocument();
    expect(within(home).getByText('3 / 4')).toBeInTheDocument(); // running / waiting
    expect(home.textContent).toContain('1 / 2'); // models on / models known

    const broken = await rowOf('OpenRouter');
    expect(within(broken).getByRole('link', { name: 'OpenRouter' })).toHaveAttribute('href', '#/providers');
    expect(within(broken).getByText('HTTP 401: invalid key')).toBeInTheDocument();
    expect(within(broken).getByText('–', { selector: 'td.num' })).toBeInTheDocument(); // no slot limit and nothing waiting

    expect(within(await rowOf('Gemini')).getByText('key unreadable')).toBeInTheDocument();
  });

  it('counts only today in the figures, and the share that ran at home', async () => {
    const api = fakeApi();
    api.usage.mockResolvedValue(
      usage([
        row({ day: '2026-10-13', requests: 99, errors: 9, input_tokens: 90000, output_tokens: 90000 }), // yesterday: in the chart, not in the figures
        row({ requests: 8, errors: 2, input_tokens: 1000, output_tokens: 500 }),
        row({ model: 'openrouter/deepseek/deepseek-chat', requests: 2, input_tokens: 2000, output_tokens: 1500 }),
      ]),
    );
    renderPage(<Overview />, api);
    await screen.findByText('Today');
    expect(api.usage).toHaveBeenCalledWith({ from: '2026-10-01', to: '2026-10-14' }, expect.anything()); // 14 days
    expect(await within(figure('Requests')).findByText('10')).toBeInTheDocument();
    expect(within(figure('Tokens')).getByText('5K')).toBeInTheDocument();
    expect(within(figure('Tokens')).getByText('3K in, 2K out')).toBeInTheDocument();
    expect(within(figure('Errors')).getByText('2')).toBeInTheDocument();
    expect(within(figure('Errors')).getByText('20%')).toBeInTheDocument();
    expect(within(figure('On your hardware')).getByText('30%')).toBeInTheDocument(); // 1,500 of 5,000
  });

  it('shows dashes rather than 0% when nothing ran today', async () => {
    renderPage(<Overview />);
    await screen.findByText('Today');
    expect(await within(figure('Requests')).findByText('0')).toBeInTheDocument();
    expect(within(figure('On your hardware')).getByText('–')).toBeInTheDocument();
  });

  it('lists the latest failures, a client error milder than a failure on our side', async () => {
    const api = fakeApi();
    api.log.mockResolvedValue([
      logRow({ id: 2, status: 429, error_code: 'rate_limited' }),
      logRow({ id: 1, status: 502, error_code: 'upstream_error', model: null, requested_model: 'smart' }),
    ]);
    renderPage(<Overview />, api);
    const section = (await screen.findByRole('heading', { name: 'Recent errors' })).closest('section')!;
    expect(await within(section).findByText('429')).toHaveClass('badge-warn');
    expect(within(section).getByText('502')).toHaveClass('badge-bad');
    expect(within(section).getByText('smart')).toBeInTheDocument();
    expect(api.log).toHaveBeenCalledWith({ limit: 6, errors: true }, expect.anything());
    expect(within(section).getByRole('link', { name: 'Open the request log' })).toHaveAttribute('href', '#/log?errors=1');
  });

  it('says so when there are no errors', async () => {
    renderPage(<Overview />);
    expect(await screen.findByText('No errors lately.')).toBeInTheDocument();
  });

  it('a failing usage call does not take the provider table with it, and can be retried', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('../api/client');
    const api = fakeApi();
    api.usage.mockRejectedValueOnce(new ApiError(500, 'internal_error', 'Internal error in the hub'));
    renderPage(<Overview />, api);
    expect(await rowOf('Home PC')).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await within(figure('Requests')).findByText('0')).toBeInTheDocument();
    expect(api.usage).toHaveBeenCalledTimes(2);
  });

  it('shows the hub’s error, with a retry, when the providers cannot be read', async () => {
    const { ApiError } = await import('../api/client');
    const api = fakeApi();
    api.providers.list.mockRejectedValue(new ApiError(500, 'internal_error', 'Internal error in the hub'));
    renderPage(<Overview />, api);
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
