import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { cloud, fakeApi, model, provider, renderPage } from '../test/fixtures';
import { Models } from './Models';

beforeEach(() => {
  window.location.hash = '#/models';
});

const CATALOG = () => [
  model({ tags: ['fast'] }),
  model({ id: 'openrouter/deepseek/deepseek-chat', provider: 'openrouter', upstream_id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', locality: 'cloud', enabled: false, context_length: 128000, supports: [] }),
  model({ id: 'home/old:1b', upstream_id: 'old:1b', name: 'old:1b', present: false }),
  model({ id: 'home/nomic-embed-text', upstream_id: 'nomic-embed-text', name: 'nomic-embed-text', kind: 'embedding', source: 'manual', supports: [] }),
];

function seeded(models = CATALOG()) {
  const api = fakeApi();
  api.models.list.mockResolvedValue(models);
  api.providers.list.mockResolvedValue([provider(), cloud()]);
  return api;
}

const rowOf = async (id: string) => (await screen.findByText(id.split('/').slice(1).join('/'))).closest('tr')!;

describe('models', () => {
  it('lists what the hub can serve, with where it runs and what it is', async () => {
    renderPage(<Models />, seeded());
    const local = await rowOf('home/qwen3:4b');
    expect(within(local).getByText('local')).toBeInTheDocument();
    expect(within(local).getByText('32.8K')).toBeInTheDocument();
    expect(within(local).getByText('Tool calls')).toBeInTheDocument();
    expect(within(local).getByRole('button', { name: 'fast' })).toBeInTheDocument();
    expect(within(local).getByRole('switch', { name: 'Enabled' })).toBeChecked();

    const remote = await rowOf('openrouter/deepseek/deepseek-chat');
    expect(within(remote).getByText('cloud')).toBeInTheDocument();
    expect(within(remote).getByText('DeepSeek Chat')).toBeInTheDocument(); // a name that differs from the id
    expect(within(remote).getByRole('switch', { name: 'Enabled' })).not.toBeChecked();

    expect(within(await rowOf('home/old:1b')).getByText('not offered')).toBeInTheDocument();
    const embed = await rowOf('home/nomic-embed-text');
    expect(within(embed).getByText('embedding')).toBeInTheDocument();
    expect(within(embed).getByText('added by hand')).toBeInTheDocument();
    expect(screen.getByText('Showing 4 of 4')).toBeInTheDocument();
  });

  it('turns one model on or off and reads the list again', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<Models />, api);
    const remote = await rowOf('openrouter/deepseek/deepseek-chat');
    await user.click(within(remote).getByRole('switch', { name: 'Enabled' }));
    await waitFor(() => expect(api.models.update).toHaveBeenCalledWith('openrouter/deepseek/deepseek-chat', { enabled: true }));
    await waitFor(() => expect(api.models.list).toHaveBeenCalledTimes(2));
  });

  it('searches and filters, and the address follows', async () => {
    const user = userEvent.setup();
    renderPage(<Models />, seeded());
    await screen.findByText('Showing 4 of 4');
    await user.type(screen.getByLabelText('Search'), 'deepseek');
    expect(await screen.findByText('Showing 1 of 4')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/models?q=deepseek');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Showing 4 of 4')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/models');

    await user.selectOptions(screen.getByLabelText('Runs'), 'cloud');
    expect(await screen.findByText('Showing 1 of 4')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Runs'), '');
    await user.click(screen.getByRole('button', { name: 'fast' })); // a tag is a filter too
    expect(await screen.findByText('Showing 1 of 4')).toBeInTheDocument();
    expect(window.location.hash).toBe('#/models?tag=fast');
  });

  it('says when nothing matches', async () => {
    window.location.hash = '#/models?q=zzz';
    renderPage(<Models />, seeded());
    expect(await screen.findByText('No model matches these filters.')).toBeInTheDocument();
  });

  it('explains an empty catalog', async () => {
    renderPage(<Models />, seeded([]));
    expect(await screen.findByText('No models yet.')).toBeInTheDocument();
  });

  it('changes a few selected models without asking, and only those that actually change', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<Models />, api);
    await screen.findByText('Showing 4 of 4');
    await user.click(screen.getByRole('checkbox', { name: 'Select home/qwen3:4b' })); // already on
    await user.click(screen.getByRole('checkbox', { name: 'Select openrouter/deepseek/deepseek-chat' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(api.models.update).toHaveBeenCalledTimes(1));
    expect(api.models.update).toHaveBeenCalledWith('openrouter/deepseek/deepseek-chat', { enabled: true });
    expect(await screen.findByText('Done: 1 models changed.')).toBeInTheDocument();
    expect(screen.queryByText('2 selected')).not.toBeInTheDocument(); // the selection is cleared
  });

  describe('many at once', () => {
    const MANY = () => Array.from({ length: 25 }, (_, i) => model({ id: `openrouter/m${i}`, provider: 'openrouter', upstream_id: `m${i}`, name: `m${i}`, locality: 'cloud', enabled: false }));

    it('asks first when it is more than twenty, and does nothing on "cancel"', async () => {
      window.location.hash = '#/models?state=off';
      const user = userEvent.setup();
      const api = seeded(MANY());
      renderPage(<Models />, api);
      await user.click(await screen.findByRole('button', { name: 'Turn on all 25 shown' }));
      const dialog = await screen.findByRole('dialog', { name: 'Turn on 25 models?' });
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(api.models.update).not.toHaveBeenCalled();
    });

    it('then changes every one of them', async () => {
      window.location.hash = '#/models?state=off';
      const user = userEvent.setup();
      const api = seeded(MANY());
      renderPage(<Models />, api);
      await user.click(await screen.findByRole('button', { name: 'Turn on all 25 shown' }));
      const dialog = await screen.findByRole('dialog', { name: 'Turn on 25 models?' });
      await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
      await waitFor(() => expect(api.models.update).toHaveBeenCalledTimes(25));
      const ids = api.models.update.mock.calls.map(c => c[0]).sort();
      expect(new Set(ids).size).toBe(25);
      expect(api.models.update.mock.calls.every(c => c[1].enabled === true)).toBe(true);
      expect(await screen.findByText('Done: 25 models changed.')).toBeInTheDocument();
    });

    it('says how many could not be changed, and does not claim success', async () => {
      window.location.hash = '#/models?state=off';
      const user = userEvent.setup();
      const api = seeded(MANY().slice(0, 5));
      api.models.update.mockImplementation(async (id: string) => {
        if (id === 'openrouter/m1' || id === 'openrouter/m3') throw new Error('boom');
        return model();
      });
      renderPage(<Models />, api);
      await user.click(await screen.findByRole('button', { name: 'Turn on all 5 shown' }));
      expect(await screen.findByText('2 models could not be changed. Try again.')).toBeInTheDocument();
      expect(screen.queryByText(/^Done:/)).not.toBeInTheDocument();
    });
  });

  it('turns a model the provider lists off instead of deleting it, and deletes one added by hand', async () => {
    const user = userEvent.setup();
    const api = seeded();
    renderPage(<Models />, api);

    const synced = await rowOf('home/qwen3:4b');
    await user.click(within(synced).getByRole('button', { name: 'Delete' }));
    let dialog = await screen.findByRole('dialog', { name: 'Remove this model?' });
    expect(within(dialog).getByText(/only turned off/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(api.models.remove).toHaveBeenCalledWith('home/qwen3:4b'));

    const manual = await rowOf('home/nomic-embed-text');
    await user.click(within(manual).getByRole('button', { name: 'Delete' }));
    dialog = await screen.findByRole('dialog', { name: 'Remove this model?' });
    expect(within(dialog).getByText(/It is deleted\./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.models.remove).toHaveBeenCalledWith('home/nomic-embed-text'));
  });
});
