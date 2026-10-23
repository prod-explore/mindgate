import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Preset } from '../api/types';
import { cloud, fakeApi, provider, renderPage } from '../test/fixtures';
import { Providers } from './Providers';

beforeEach(() => {
  window.location.hash = '#/providers';
});

const PRESETS: Preset[] = [
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', note: 'Hundreds of models behind one key' },
  { id: 'mindgate-node', name: 'A machine with a MindGate agent', type: 'openai', base_url: 'http://pc.lan:3001/v1', locality: 'local', max_concurrency: 1, node: { port: 9, min_wake_priority: 3 } },
];

const rowOf = async (name: string) => (await screen.findByText(name, { selector: '.cell-main' })).closest('tr')!;

describe('providers', () => {
  it('lists the providers: where they run, what state they are in, whether a key is stored', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([
      provider({ status: 'online', last_error: null }),
      cloud({ has_api_key: false, api_key_hint: null, last_sync_error: 'HTTP 401: invalid key', models_synced_at: null }),
      cloud({ id: 'gemini', name: 'Gemini', api_key_unreadable: true }),
    ]);
    renderPage(<Providers />, api);

    const home = await rowOf('Home PC');
    expect(within(home).getByText('home')).toBeInTheDocument();
    expect(within(home).getByText('http://pc.lan:3001/v1')).toBeInTheDocument();
    expect(within(home).getByText('local')).toBeInTheDocument();
    expect(within(home).getByText('machine')).toBeInTheDocument();
    expect(within(home).getByText('Online')).toBeInTheDocument();
    expect(within(home).getByText('…f3a9')).toBeInTheDocument();
    expect(within(home).getByText('1 / 2')).toBeInTheDocument();

    const broken = await rowOf('OpenRouter');
    expect(within(broken).getByText('cloud')).toBeInTheDocument();
    expect(within(broken).getByText('no key')).toBeInTheDocument();
    expect(within(broken).getByText('HTTP 401: invalid key')).toBeInTheDocument();
    expect(within(broken).getByText('Never')).toBeInTheDocument(); // never synced

    expect(within(await rowOf('Gemini')).getByText('key unreadable')).toHaveClass('badge-bad');
  });

  it('explains an empty list', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([]);
    renderPage(<Providers />, api);
    expect(await screen.findByText('No providers yet.')).toBeInTheDocument();
  });

  it('tests a provider and reports both outcomes', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(<Providers />, api);
    await user.click(within(await rowOf('Home PC')).getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Reachable in 40 ms, 3 models.')).toBeInTheDocument();
    expect(api.providers.test).toHaveBeenCalledWith('home');

    api.providers.test.mockResolvedValue({ ok: false, latency_ms: 5, code: 'unreachable', error: 'connect ECONNREFUSED' } as never);
    await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Test failed: connect ECONNREFUSED')).toBeInTheDocument();
  });

  it('syncs the models of a provider and says what changed', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.providers.sync.mockResolvedValue({ provider: 'openrouter', added: 12, updated: 3, absent: 1 });
    renderPage(<Providers />, api);
    await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Sync models' }));
    expect(await screen.findByText('Models synced: 12 new, 3 updated, 1 no longer offered.')).toBeInTheDocument();
    expect(api.providers.sync).toHaveBeenCalledWith('openrouter');
    await waitFor(() => expect(api.providers.list).toHaveBeenCalledTimes(2));
  });

  it('wakes a machine that is not online, and only that', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.providers.list.mockResolvedValue([provider({ status: 'asleep' }), cloud({ status: 'online' }), provider({ id: 'nas', name: 'NAS', status: 'online' })]);
    renderPage(<Providers />, api);
    const asleep = await rowOf('Home PC');
    expect(within(await rowOf('OpenRouter')).queryByRole('button', { name: 'Wake up' })).not.toBeInTheDocument(); // not a machine
    expect(within(await rowOf('NAS')).queryByRole('button', { name: 'Wake up' })).not.toBeInTheDocument(); // already up
    await user.click(within(asleep).getByRole('button', { name: 'Wake up' }));
    expect(await screen.findByText('The machine is now: waking.')).toBeInTheDocument();
    expect(api.providers.wake).toHaveBeenCalledWith('home');
  });

  it('links a machine to its own page', async () => {
    renderPage(<Providers />);
    expect(within(await rowOf('Home PC')).getByRole('link', { name: 'Machine' })).toHaveAttribute('href', '#/providers/home');
    expect(within(await rowOf('OpenRouter')).queryByRole('link', { name: 'Machine' })).not.toBeInTheDocument();
  });

  it('turns a provider off', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(<Providers />, api);
    await user.click(within(await rowOf('OpenRouter')).getByRole('switch', { name: 'Enabled' }));
    await waitFor(() => expect(api.providers.update).toHaveBeenCalledWith('openrouter', { enabled: false }));
  });

  describe('deleting', () => {
    it('asks first, and does nothing on "cancel"', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      renderPage(<Providers />, api);
      await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete “OpenRouter”?' });
      expect(within(dialog).getByText(/Its 3 models leave the catalog/)).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.providers.remove).not.toHaveBeenCalled();
    });

    it('says so once the provider is gone, and reloads the list', async () => {
      const user = userEvent.setup();
      renderPage(<Providers />);
      await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Delete' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Provider deleted.')).toBeInTheDocument();
    });
  });

  describe('adding', () => {
    it('starts from a ready-made entry, and sends what the form holds', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      api.presets.mockResolvedValue(PRESETS);
      renderPage(<Providers />, api);
      await screen.findByText('Home PC');
      await user.click(screen.getByRole('button', { name: 'Add provider' }));
      const picker = await screen.findByRole('dialog', { name: 'Add a provider' });
      expect(await within(picker).findByText('Hundreds of models behind one key')).toBeInTheDocument();
      await user.click(within(picker).getByRole('button', { name: /OpenRouter/ }));

      const form = await screen.findByRole('dialog', { name: 'Add provider' });
      expect(within(form).getByLabelText(/^Id/)).toHaveValue('openrouter');
      expect(within(form).getByLabelText('Address')).toHaveValue('https://openrouter.ai/api/v1');
      await user.type(within(form).getByLabelText('API key'), '  sk-or-secret  ');
      await user.click(within(form).getByRole('button', { name: 'Create' }));

      await waitFor(() => expect(api.providers.create).toHaveBeenCalledTimes(1));
      expect(api.providers.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'openrouter', name: 'OpenRouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', auth_scheme: 'bearer', api_key: 'sk-or-secret' }),
      );
      expect(api.providers.create.mock.calls[0]![0]).not.toHaveProperty('node'); // not a machine
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(await screen.findByText('Provider added.')).toBeInTheDocument();
    });

    it('does not send a form with a wrong id or address, and says what is wrong', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      api.presets.mockResolvedValue(PRESETS);
      renderPage(<Providers />, api);
      await screen.findByText('Home PC');
      await user.click(screen.getByRole('button', { name: 'Add provider' }));
      await user.click(await screen.findByRole('button', { name: /Something else/ }));
      const form = await screen.findByRole('dialog', { name: 'Add provider' });
      await user.click(within(form).getByRole('button', { name: 'Create' }));
      expect(await within(form).findByText('Use 1 to 32 lower-case letters, digits and hyphens, starting with a letter or digit.')).toBeInTheDocument();
      expect(within(form).getByText('Enter a full address starting with http:// or https://.')).toBeInTheDocument();
      expect(api.providers.create).not.toHaveBeenCalled();
    });

    it('asks for the machine’s details when it is one, and sends them as a node', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      api.presets.mockResolvedValue(PRESETS);
      renderPage(<Providers />, api);
      await screen.findByText('Home PC');
      await user.click(screen.getByRole('button', { name: 'Add provider' }));
      await user.click(await screen.findByRole('button', { name: /A machine with a MindGate agent/ }));
      const form = await screen.findByRole('dialog', { name: 'Add provider' });
      await user.type(within(form).getByLabelText(/^Id/), 'workstation');
      await user.type(within(form).getByLabelText('Agent address'), 'http://pc.lan:3001');
      await user.type(within(form).getByLabelText('MAC address'), 'aa:bb:cc:dd:ee:01');
      await user.type(within(form).getByLabelText('Broadcast address'), '192.168.1.255');
      await user.type(within(form).getByLabelText('Agent secret'), 'a-long-enough-agent-secret-1234');
      await user.click(within(form).getByRole('button', { name: 'Create' }));
      await waitFor(() => expect(api.providers.create).toHaveBeenCalledTimes(1));
      const sent = api.providers.create.mock.calls[0]![0];
      expect(sent).toMatchObject({ id: 'workstation', locality: 'local', max_concurrency: 1, api_key: 'a-long-enough-agent-secret-1234' });
      expect(sent.node).toMatchObject({ mac: 'aa:bb:cc:dd:ee:01', broadcast: '192.168.1.255', control_url: 'http://pc.lan:3001' });
    });

    it('shows what the hub refused, and keeps the form open', async () => {
      const user = userEvent.setup();
      const { ApiError } = await import('../api/client');
      const api = fakeApi();
      api.presets.mockResolvedValue(PRESETS);
      api.providers.create.mockRejectedValue(new ApiError(409, 'provider_exists', 'A provider with this id already exists'));
      renderPage(<Providers />, api);
      await screen.findByText('Home PC');
      await user.click(screen.getByRole('button', { name: 'Add provider' }));
      await user.click(await screen.findByRole('button', { name: /OpenRouter/ }));
      const form = await screen.findByRole('dialog', { name: 'Add provider' });
      await user.click(within(form).getByRole('button', { name: 'Create' }));
      expect(await within(form).findByText(/already exists/)).toBeInTheDocument();
      expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeInTheDocument();
    });

    it('opens the picker straight away from the overview, and clears the address', async () => {
      window.location.hash = '#/providers?add=1';
      const api = fakeApi();
      api.presets.mockResolvedValue(PRESETS);
      renderPage(<Providers />, api);
      expect(await screen.findByRole('dialog', { name: 'Add a provider' })).toBeInTheDocument();
      expect(window.location.hash).toBe('#/providers');
    });
  });

  describe('editing', () => {
    it('keeps the stored key unless a new one is typed, and cannot change the id', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      renderPage(<Providers />, api);
      await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Edit' }));
      const form = await screen.findByRole('dialog', { name: 'Edit “OpenRouter”' });
      expect(within(form).getByLabelText(/^Id/)).toBeDisabled();
      expect(within(form).getByText(/A key ending in …f3a9 is stored/)).toBeInTheDocument();
      await user.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(api.providers.update).toHaveBeenCalledTimes(1));
      const [id, sent] = api.providers.update.mock.calls[0]!;
      expect(id).toBe('openrouter');
      expect(sent).not.toHaveProperty('api_key'); // untouched
      expect(sent).not.toHaveProperty('id');
    });

    it('removes the key only when asked to', async () => {
      const user = userEvent.setup();
      const api = fakeApi();
      renderPage(<Providers />, api);
      await user.click(within(await rowOf('OpenRouter')).getByRole('button', { name: 'Edit' }));
      const form = await screen.findByRole('dialog', { name: 'Edit “OpenRouter”' });
      await user.click(within(form).getByRole('switch', { name: 'Remove the stored key' }));
      await user.click(within(form).getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(api.providers.update).toHaveBeenCalledTimes(1));
      expect(api.providers.update.mock.calls[0]![1]).toMatchObject({ api_key: null });
    });
  });
});
