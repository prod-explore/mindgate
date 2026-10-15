import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { cloud, fakeApi, model, provider, renderPage } from '../test/fixtures';
import { ProviderPage } from './ProviderPage';

beforeEach(() => {
  setLang('en');
  window.location.hash = '#/providers/openrouter';
});

const cloudModels = () => [model({ id: 'openrouter/deepseek/deepseek-chat', provider: 'openrouter', upstream_id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', locality: 'cloud', supports: [] })];

function seeded() {
  const api = fakeApi();
  api.providers.list.mockResolvedValue([provider(), cloud()]);
  api.models.list.mockResolvedValue(cloudModels());
  return api;
}

describe('a provider’s page', () => {
  it('shows its models, and asks the hub for that provider’s only', async () => {
    const api = seeded();
    renderPage(<ProviderPage id="openrouter" />, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'OpenRouter' })).toBeInTheDocument();
    expect(await screen.findByText('DeepSeek Chat')).toBeInTheDocument();
    expect(api.models.list).toHaveBeenCalledWith('openrouter', expect.anything());
    expect(screen.queryByLabelText('Provider')).not.toBeInTheDocument(); // the page already says which one
    expect(screen.getByRole('link', { name: 'All providers' })).toHaveAttribute('href', '#/providers');
  });

  it('adds a model the provider does not list, under Advanced, without asking which provider', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<ProviderPage id="openrouter" />, api);
    await screen.findByText('DeepSeek Chat');
    await user.click(screen.getByText('Advanced'));
    await user.click(screen.getByRole('button', { name: 'Add model' }));
    const form = await screen.findByRole('dialog', { name: 'Add model' });
    expect(within(form).queryByLabelText('Provider')).not.toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Create' })).toBeDisabled(); // no id yet
    await user.type(within(form).getByLabelText(/Id at the provider/), ' llama3.2:3b ');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.models.create).toHaveBeenCalledWith({ provider: 'openrouter', id: 'llama3.2:3b', kind: 'chat' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await waitFor(() => expect(api.models.list.mock.calls.length).toBeGreaterThan(1)); // the list is read again
  });

  it('shows a machine as a machine, with its models in the hub below', async () => {
    window.location.hash = '#/providers/home';
    const api = fakeApi();
    api.providers.list.mockResolvedValue([provider(), cloud()]);
    renderPage(<ProviderPage id="home" />, api);
    expect(await screen.findByRole('heading', { level: 1, name: 'Home PC' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Models in the hub' })).toBeInTheDocument();
    expect(api.models.list).toHaveBeenCalledWith('home', expect.anything());
    // models of a machine come from the machine: nothing to add by hand
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add model' })).not.toBeInTheDocument();
  });

  it('says so when there is no such provider', async () => {
    const api = seeded();
    renderPage(<ProviderPage id="gone" />, api);
    expect(await screen.findByText('There is no such provider.')).toBeInTheDocument();
  });
});
