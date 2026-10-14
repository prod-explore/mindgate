import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { setLang } from '../i18n';
import { alias, fakeApi, model, renderPage } from '../test/fixtures';
import { Aliases } from './Aliases';

beforeEach(() => setLang('en'));

const catalog = () => [
  model({ id: 'home/qwen3:4b' }),
  model({ id: 'openrouter/deepseek/deepseek-chat', provider: 'openrouter', locality: 'cloud', name: 'DeepSeek' }),
  model({ id: 'home/old', enabled: false }),
  model({ id: 'home/dolphin3', tags: ['uncensored'] }),
];

describe('the picture of an alias', () => {
  it('colours each hop by where it runs, and marks a missing or disabled target', async () => {
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    api.aliases.list.mockResolvedValue([alias({ targets: ['home/qwen3:4b', 'openrouter/deepseek/deepseek-chat', 'home/old', 'ghost/gone'], missing_targets: ['ghost/gone'] })]);
    renderPage(<Aliases />, api);
    const chain = await screen.findByRole('list', { name: 'Order in which “smart” tries its models' });
    const hops = within(chain).getAllByRole('listitem');
    expect(hops).toHaveLength(4);
    const hop = (i: number) => hops[i]!.querySelector('.hop')!;

    expect(hop(0)).toHaveClass('hop-local');
    expect(hop(0)).toHaveTextContent('first');
    expect(hop(1)).toHaveClass('hop-cloud');
    expect(hop(1)).toHaveTextContent('then');
    expect(hop(2)).toHaveClass('hop-off');
    expect(hop(2)).toHaveTextContent('disabled');
    expect(hop(3)).toHaveClass('hop-missing');
    expect(hop(3)).toHaveTextContent('not in the catalog');
    expect(screen.getByText('1 missing')).toBeInTheDocument();
    // an arrow between hops, none before the first
    expect(hops[0]!.querySelector('.chain-link')).toBeNull();
    expect(hops[1]!.querySelector('.chain-link')).not.toBeNull();
  });

  it('says plainly that fallback only happens through an alias', async () => {
    renderPage(<Aliases />);
    expect(await screen.findByText(/never switches to another model on its own/)).toBeInTheDocument();
  });

  it('explains an empty list', async () => {
    const api = fakeApi();
    api.aliases.list.mockResolvedValue([]);
    renderPage(<Aliases />, api);
    expect(await screen.findByText('No aliases yet.')).toBeInTheDocument();
  });
});

describe('editing', () => {
  it('reorders the models and saves the new order', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    renderPage(<Aliases />, api);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog');
    await user.click(within(form).getByRole('button', { name: 'Move openrouter/deepseek/deepseek-chat up' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.aliases.update).toHaveBeenCalled());
    expect(api.aliases.update).toHaveBeenCalledWith('smart', { description: '', tags: [], targets: ['openrouter/deepseek/deepseek-chat', 'home/qwen3:4b'], enabled: true });
  });

  it('cannot move the first model up or the last one down', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    renderPage(<Aliases />, api);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog');
    expect(within(form).getByRole('button', { name: 'Move home/qwen3:4b up' })).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Move openrouter/deepseek/deepseek-chat down' })).toBeDisabled();
  });

  it('warns when an uncensored model has a cloud fallback', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    api.aliases.list.mockResolvedValue([alias({ targets: ['home/dolphin3'] })]);
    renderPage(<Aliases />, api);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog');
    expect(within(form).queryByText(/mixes an uncensored model with a cloud model/)).not.toBeInTheDocument();
    await user.type(within(form).getByLabelText('Add a model'), 'openrouter/deepseek/deepseek-chat');
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    expect(await within(form).findByText(/mixes an uncensored model with a cloud model/)).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Remove openrouter/deepseek/deepseek-chat' }));
    expect(within(form).queryByText(/mixes an uncensored model with a cloud model/)).not.toBeInTheDocument();
  });

  it('creates an alias: valid name, at least one model, no duplicate names', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    renderPage(<Aliases />, api);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Add alias' }));
    const form = screen.getByRole('dialog');

    await user.type(within(form).getByLabelText('Name'), 'bad name');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText(/Start with a letter or digit/)).toBeInTheDocument();
    expect(within(form).getByText('Add at least one model.')).toBeInTheDocument();

    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'smart');
    expect(await within(form).findByText('An alias with this name already exists.')).toBeInTheDocument();

    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'fast');
    await user.type(within(form).getByLabelText('Add a model'), 'home/qwen3:4b{Enter}');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.aliases.create).toHaveBeenCalled());
    expect(api.aliases.create).toHaveBeenCalledWith({ name: 'fast', description: '', tags: [], targets: ['home/qwen3:4b'], enabled: true });
  });

  it('does not add the same model twice', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.models.list.mockResolvedValue(catalog());
    renderPage(<Aliases />, api);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog');
    await user.type(within(form).getByLabelText('Add a model'), 'home/qwen3:4b{Enter}');
    expect(within(form).getAllByRole('button', { name: /^Move home\/qwen3:4b up$/ })).toHaveLength(1);
  });
});

describe('deleting', () => {
  it('asks first, and only then removes', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Aliases />);
    await screen.findByText('smart');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(api.aliases.remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.aliases.remove).toHaveBeenCalledWith('smart'));
  });
});
