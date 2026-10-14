import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { setLang } from '../i18n';
import { agent, cloud, fakeApi, model, nodeInfo, nodeModel, provider, pull, renderPage } from '../test/fixtures';
import { Nodes } from './Nodes';

beforeEach(() => {
  setLang('en');
  window.location.hash = '#/nodes/home';
});

const big = () => nodeModel({ id: 'llama3.3:70b', size_bytes: 42e9, hub_id: 'home/llama3.3:70b', hub: null, parameter_size: '70B' });
const rowOf = async (name: string) => (await screen.findByText(name, { selector: '.cell-main' })).closest('tr')!;

describe('the list of machines', () => {
  beforeEach(() => {
    window.location.hash = '#/nodes';
  });

  it('lists the machines, not the cloud providers', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([provider(), cloud(), provider({ id: 'nas', name: 'NAS', status: 'asleep', node: { ...provider().node!, control_url: undefined as unknown as string } })]);
    renderPage(<Nodes />, api);
    expect(await screen.findByRole('heading', { name: 'Home PC' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'NAS' })).toBeInTheDocument();
    expect(screen.queryByText('OpenRouter')).not.toBeInTheDocument();
    expect(screen.getByText('agent set up')).toBeInTheDocument();
    expect(screen.getByText('no agent address')).toBeInTheDocument();
  });

  it('offers to wake a machine that is not up, and only that one', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.providers.list.mockResolvedValue([provider(), provider({ id: 'nas', name: 'NAS', status: 'asleep' })]);
    renderPage(<Nodes />, api);
    await screen.findByRole('heading', { name: 'NAS' });
    const wake = screen.getAllByRole('button', { name: 'Wake up' });
    expect(wake).toHaveLength(1);
    await user.click(wake[0]!);
    await waitFor(() => expect(api.providers.wake).toHaveBeenCalledWith('nas'));
  });

  it('explains how to add the first machine', async () => {
    const api = fakeApi();
    api.providers.list.mockResolvedValue([cloud()]);
    renderPage(<Nodes />, api);
    expect(await screen.findByText('No machines yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add provider' })).toHaveAttribute('href', '#/providers?add=1');
  });
});

describe('one machine', () => {
  it('shows the hardware with how much of it is used', async () => {
    renderPage(<Nodes />);
    expect(await screen.findByText('DESKTOP-PC', { exact: false })).toBeInTheDocument();
    const ram = screen.getByRole('meter', { name: /^Memory:/ });
    expect(ram).toHaveAttribute('aria-valuenow', String(10e9)); // 16 GB with 6 GB free
    expect(ram).toHaveAttribute('aria-valuemax', String(16e9));
    expect(screen.getByText('10 GB of 16 GB in use')).toBeInTheDocument();
    const vram = screen.getByRole('meter', { name: /^Graphics memory · GTX 1650/ });
    expect(vram).toHaveAttribute('aria-valuenow', String(1e9));
    expect(screen.getByText('7% busy')).toBeInTheDocument();
    expect(screen.getByText('200 GB free of 500 GB')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: /^Disk:/ })).toHaveAttribute('aria-valuenow', String(300e9));
    expect(screen.getByText('12 threads')).toBeInTheDocument();
    expect(screen.getByText('started by the agent')).toBeInTheDocument();
  });

  it('says so when there is no graphics card', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: agent({ system: { ...agent().system, gpus: [] } }) }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText(/No graphics card found/)).toBeInTheDocument();
    expect(await screen.findByText('no card: runs on the processor')).toBeInTheDocument();
  });

  it('tells which models fit in graphics memory', async () => {
    const api = fakeApi();
    api.nodes.models.mockResolvedValue([nodeModel(), big()]);
    renderPage(<Nodes />, api);
    const small = await rowOf('qwen3:4b');
    expect(within(small).getByText('2.6 GB')).toBeInTheDocument();
    expect(within(small).getByText('fits on the card')).toBeInTheDocument();
    const huge = await rowOf('llama3.3:70b');
    expect(within(huge).getByText('42 GB')).toBeInTheDocument();
    expect(within(huge).getByText(/larger than the card \(4 GB\)/)).toHaveClass('is-warn');
  });

  it('shows what the hub knows about each model on the machine', async () => {
    const api = fakeApi();
    api.nodes.models.mockResolvedValue([nodeModel(), big(), nodeModel({ id: 'old:1b', hub_id: 'home/old:1b', hub: model({ id: 'home/old:1b', enabled: false }) })]);
    renderPage(<Nodes />, api);
    expect(within(await rowOf('qwen3:4b')).getByText('on')).toBeInTheDocument();
    expect(within(await rowOf('llama3.3:70b')).getByText('not in the hub yet')).toBeInTheDocument();
    expect(within(await rowOf('old:1b')).getByText('off')).toBeInTheDocument();
  });

  it('marks uncensored models', async () => {
    const api = fakeApi();
    api.nodes.models.mockResolvedValue([nodeModel({ id: 'dolphin3:8b', tags: ['uncensored'], hub_id: 'home/dolphin3:8b' })]);
    renderPage(<Nodes />, api);
    expect(await screen.findByText('uncensored')).toHaveClass('chip-tag');
  });

  it('loads and unloads a model', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.models.mockResolvedValue([nodeModel(), nodeModel({ id: 'phi4-mini', hub_id: 'home/phi4-mini', hub: null, loaded: { vram_bytes: 2.4e9, size_bytes: 2.5e9, expires_at: null } })]);
    renderPage(<Nodes />, api);
    await user.click(within(await rowOf('qwen3:4b')).getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(api.nodes.load).toHaveBeenCalledWith('home', 'qwen3:4b'));
    expect(await screen.findByText('qwen3:4b is loaded.')).toBeInTheDocument();

    const loaded = await rowOf('phi4-mini');
    expect(within(loaded).getByText('in memory, 2.4 GB')).toBeInTheDocument();
    await user.click(within(loaded).getByRole('button', { name: 'Unload' }));
    await waitFor(() => expect(api.nodes.unload).toHaveBeenCalledWith('home', 'phi4-mini'));
  });

  it('lists what is loaded now, and unloads from there too', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: agent({ loaded: [{ id: 'qwen3:4b', size_bytes: 2.6e9, vram_bytes: 2.6e9, expires_at: '2026-10-14T12:00:00Z' }] }) }));
    renderPage(<Nodes />, api);
    const section = (await screen.findByRole('heading', { name: 'In memory now' })).closest('section')!;
    expect(within(section).getByText('qwen3:4b')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Unload' }));
    await waitFor(() => expect(api.nodes.unload).toHaveBeenCalledWith('home', 'qwen3:4b'));
  });

  it('does not offer to delete a model that is in memory', async () => {
    const api = fakeApi();
    api.nodes.models.mockResolvedValue([nodeModel({ loaded: { vram_bytes: 1, size_bytes: 1, expires_at: null } })]);
    renderPage(<Nodes />, api);
    expect(within(await rowOf('qwen3:4b')).getByRole('button', { name: 'Delete' })).toBeDisabled();
  });

  it('deletes a model only after confirmation, and names the aliases that lost it', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.remove.mockResolvedValue({ id: 'home/qwen3:4b', aliases_affected: ['smart', 'fast'] });
    renderPage(<Nodes />, api);
    await user.click(within(await rowOf('qwen3:4b')).getByRole('button', { name: 'Delete' }));
    const ask = screen.getByRole('dialog');
    expect(within(ask).getByText('Delete qwen3:4b from the machine?')).toBeInTheDocument();
    expect(within(ask).getByText(/frees 2.6 GB/)).toBeInTheDocument();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.nodes.remove).not.toHaveBeenCalled();

    await user.click(within(await rowOf('qwen3:4b')).getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.nodes.remove).toHaveBeenCalledWith('home', 'qwen3:4b'));
    const toast = await screen.findByText(/qwen3:4b deleted\. These aliases lost a model: smart, fast\./);
    expect(toast.closest('.toast')).toHaveClass('toast-warn');
  });

  it('refreshes the model list after a delete', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Nodes />);
    await user.click(within(await rowOf('qwen3:4b')).getByRole('button', { name: 'Delete' }));
    const before = api.nodes.models.mock.calls.length;
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.nodes.models.mock.calls.length).toBeGreaterThan(before));
  });
});

describe('downloading', () => {
  it('checks the name before it asks the machine', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Nodes />);
    const input = await screen.findByLabelText('Model name');
    await user.type(input, 'two words');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Letters, digits and . _ - : / only, no spaces.')).toBeInTheDocument();
    expect(api.nodes.pull).not.toHaveBeenCalled();
  });

  it('starts a download and clears the box', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Nodes />);
    const input = await screen.findByLabelText('Model name');
    await user.type(input, 'phi4-mini');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(api.nodes.pull).toHaveBeenCalledWith('home', 'phi4-mini'));
    await waitFor(() => expect(input).toHaveValue(''));
  });

  it('fills the box from a suggestion', async () => {
    const user = userEvent.setup();
    renderPage(<Nodes />);
    await user.click(await screen.findByRole('button', { name: 'qwen2.5-coder:3b' }));
    expect(screen.getByLabelText('Model name')).toHaveValue('qwen2.5-coder:3b');
  });

  it('shows the machine’s refusal next to the box', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.pull.mockRejectedValue(new ApiError(404, 'model_not_found', 'pull model manifest: file does not exist'));
    renderPage(<Nodes />, api);
    await user.type(await screen.findByLabelText('Model name'), 'nope:1b');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('pull model manifest: file does not exist')).toBeInTheDocument();
    expect(screen.getByLabelText('Model name')).toHaveValue('nope:1b'); // kept, so it can be corrected
  });

  it('shows progress while it runs, and lets it be cancelled', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.pulls.mockResolvedValue([pull()]);
    renderPage(<Nodes />, api);
    const bar = await screen.findByRole('meter', { name: 'Download progress: llama3.2:3b' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    const item = bar.closest('li')!;
    expect(within(item).getByText('downloading')).toBeInTheDocument();
    expect(within(item).getByText(/840 MB \/ 2 GB · 42%/)).toBeInTheDocument();
    expect(screen.getByText('One download runs at a time; the rest wait.')).toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.nodes.cancelPull).toHaveBeenCalledWith('home', 'pull_1'));
  });

  it('keeps a failed download readable until it is cleared', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.pulls.mockResolvedValue([pull({ status: 'failed', percent: null, error: 'disk full' })]);
    renderPage(<Nodes />, api);
    const item = (await screen.findByText('llama3.2:3b', { selector: '.pull-name' })).closest('li')!;
    expect(within(item).getByText('failed')).toBeInTheDocument();
    expect(within(item).getByText('disk full')).toBeInTheDocument();
    expect(within(item).queryByRole('meter')).not.toBeInTheDocument();
    await user.click(within(item).getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(api.nodes.cancelPull).toHaveBeenCalledWith('home', 'pull_1'));
  });

  it('puts a finished download into the model list without a manual refresh', async () => {
    const api = fakeApi();
    api.nodes.pulls.mockResolvedValueOnce([pull()]); // first look: still running
    renderPage(<Nodes />, api);
    await screen.findByRole('meter', { name: /Download progress/ });
    const before = api.nodes.models.mock.calls.length;
    api.nodes.pulls.mockResolvedValue([pull({ status: 'succeeded', percent: 100, completed: 2e9 })]);
    await waitFor(() => expect(api.nodes.models.mock.calls.length).toBeGreaterThan(before), { timeout: 4000 });
  });
});

describe('a machine that cannot be reached', () => {
  it('asleep: says so, offers to wake it, and asks the machine for nothing', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ status: 'asleep', agent: null, agent_error: { code: 'node_unavailable', message: 'timed out' } }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText('The machine is asleep.')).toBeInTheDocument();
    expect(screen.getByText(/does not wake it for this/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Wake up' }));
    await waitFor(() => expect(api.providers.wake).toHaveBeenCalledWith('home'));
    expect(api.nodes.models).not.toHaveBeenCalled();
    expect(api.nodes.pulls).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Hardware' })).not.toBeInTheDocument();
  });

  it('wrong secret: says what to change, in words', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: null, agent_error: { code: 'node_auth_failed', message: 'HTTP 401' } }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText('The agent does not answer.')).toBeInTheDocument();
    expect(screen.getByText(/rejected the secret stored for this provider/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Wake up' })).not.toBeInTheDocument();
  });

  it('no agent address configured', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: null, agent_configured: false }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText('No agent address.')).toBeInTheDocument();
    expect(screen.getByText(/Set “Agent address”/)).toBeInTheDocument();
  });

  it('waking: says it is on its way', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ status: 'waking', agent: null, agent_error: null }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText('The machine is waking up.')).toBeInTheDocument();
  });

  it('no such machine', async () => {
    const api = fakeApi();
    api.nodes.get.mockRejectedValue(new ApiError(404, 'provider_not_found', 'No provider "home"'));
    renderPage(<Nodes />, api);
    expect(await screen.findByText('There is no such machine.')).toBeInTheDocument();
  });

  it('a hub error is shown with a way to retry', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.get.mockRejectedValueOnce(new ApiError(500, 'internal_error', 'Internal error in the hub'));
    renderPage(<Nodes />, api);
    expect(await screen.findByRole('alert')).toHaveTextContent('Internal error in the hub');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/DESKTOP-PC/)).toBeInTheDocument();
  });
});

describe('power', () => {
  it('says when it is safe to switch the machine off, and when it is not', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: agent({ safe_to_shutdown: false, in_flight: 2, user_active: true }) }));
    renderPage(<Nodes />, api);
    expect(await screen.findByText(/Not now: requests are still running, someone is using the machine\./)).toBeInTheDocument();
  });

  it('shows the reason when the machine says no', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.shutdown.mockResolvedValue({ allow: false, reason: 'user_active' });
    renderPage(<Nodes />, api);
    await user.click(await screen.findByRole('button', { name: 'Shut down' }));
    await waitFor(() => expect(api.nodes.shutdown).toHaveBeenCalledWith('home', false));
    expect(await screen.findByText('Not shut down.')).toBeInTheDocument();
    expect(screen.getByText('someone is using the machine')).toBeInTheDocument();
  });

  it('a tray that does not answer is explained, not shown as a code', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.shutdown.mockResolvedValue({ allow: false, reason: 'tray_unreachable' });
    renderPage(<Nodes />, api);
    await user.click(await screen.findByRole('button', { name: 'Shut down' }));
    expect(await screen.findByText(/cannot tell whether someone is using it/)).toBeInTheDocument();
  });

  it('an unknown reason is shown as it came', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.nodes.shutdown.mockResolvedValue({ allow: false, reason: 'idle_for_only_3_minutes' });
    renderPage(<Nodes />, api);
    await user.click(await screen.findByRole('button', { name: 'Shut down' }));
    expect(await screen.findByText('idle_for_only_3_minutes')).toBeInTheDocument();
  });

  it('forcing asks first, and then really forces', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderPage(<Nodes />, api);
    await user.click(await screen.findByRole('button', { name: 'Shut down anyway' }));
    const ask = screen.getByRole('dialog');
    expect(within(ask).getByText('Shut down even if it is in use?')).toBeInTheDocument();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.nodes.shutdown).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Shut down anyway' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Shut down anyway' }));
    await waitFor(() => expect(api.nodes.shutdown).toHaveBeenCalledWith('home', true));
    expect(await screen.findByText('The machine is shutting down.', { selector: '.toast span' })).toBeInTheDocument();
  });

  it('cannot be switched off twice', async () => {
    const api = fakeApi();
    api.nodes.get.mockResolvedValue(nodeInfo({ agent: agent({ shutting_down: true, safe_to_shutdown: false }) }));
    renderPage(<Nodes />, api);
    expect(await screen.findByRole('button', { name: 'Shut down' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Shut down anyway' })).toBeDisabled();
  });
});
