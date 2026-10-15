import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { alias, apiKey, cloud, FULL_KEY, fakeApi, provider, renderPage } from '../test/fixtures';
import { Keys } from './Keys';


describe('client keys', () => {
  it('lists the keys with what they have used of their limits', async () => {
    renderPage(<Keys />);
    const row = (await screen.findByText('open-webui')).closest('tr')!;
    expect(within(row).getByText('mg-ab12…')).toBeInTheDocument();
    expect(within(row).getByText('all models')).toBeInTheDocument();
    // 120 requests today of 1,000; 50 thousand tokens of 200 thousand
    expect(within(row).getByRole('meter', { name: 'Requests today: share of the limit used' })).toHaveAttribute('aria-valuenow', '120');
    expect(within(row).getByRole('meter', { name: 'Tokens today: share of the limit used' })).toHaveAttribute('aria-valuenow', '50000');
    expect(within(row).queryByRole('meter', { name: /this month/ })).not.toBeInTheDocument(); // no monthly limit, nothing to measure against
    expect(within(row).getByText('120')).toBeInTheDocument();
    expect(within(row).getByText('/ 1,000')).toBeInTheDocument();
    expect(within(row).getByText('50K')).toBeInTheDocument();
  });

  it('shows the whole new key once, and not again after it is closed', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Keys />);
    await screen.findByText('open-webui');

    await user.click(screen.getByRole('button', { name: 'Add key' }));
    const form = screen.getByRole('dialog');
    await user.type(within(form).getByLabelText('Name'), 'new-app');
    await user.click(within(form).getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(api.keys.create).toHaveBeenCalledTimes(1));
    expect(api.keys.create).toHaveBeenCalledWith({
      name: 'new-app',
      default_priority: 3,
      min_priority: 1,
      max_priority: 5,
      local_only: false,
      allowed_models: null,
      rpm: null,
      rpd: null,
      tokens_per_day: null,
      tokens_per_month: null,
    });

    const shown = await screen.findByTestId('new-key');
    expect(shown).toHaveTextContent(FULL_KEY);
    expect(screen.getByText(/the only time the whole key can be seen/)).toBeInTheDocument();
    expect(document.body.textContent).toContain(`Authorization: Bearer ${FULL_KEY}`);

    await user.click(screen.getByRole('button', { name: 'I have copied it' }));
    await waitFor(() => expect(screen.queryByTestId('new-key')).not.toBeInTheDocument());
    expect(document.body.textContent).not.toContain('THE-WHOLE-SECRET');
    // the list is refreshed, and it holds only the prefix
    await waitFor(() => expect(api.keys.list.mock.calls.length).toBeGreaterThan(1));
  });

  it('does not create a key without a valid name', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Keys />);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    const form = screen.getByRole('dialog');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText(/Use 1 to 64 letters, digits/)).toBeInTheDocument();
    expect(api.keys.create).not.toHaveBeenCalled();
  });

  it('does not accept a priority range that contradicts itself', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Keys />);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    const form = screen.getByRole('dialog');
    await user.type(within(form).getByLabelText('Name'), 'x');
    await user.selectOptions(within(form).getByLabelText('Lowest allowed'), '4'); // lowest 4 > usual 3
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText('Lowest ≤ usual ≤ highest.')).toBeInTheDocument();
    expect(api.keys.create).not.toHaveBeenCalled();
  });

  it('restricting to certain models needs at least one, and sends them', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.aliases.list.mockResolvedValue([alias({ name: 'smart' })]);
    api.providers.list.mockResolvedValue([provider(), cloud()]);
    renderPage(<Keys />, api);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    const form = screen.getByRole('dialog');
    await user.type(within(form).getByLabelText('Name'), 'private');
    await user.click(within(form).getByRole('switch', { name: 'Limit to certain models' }));
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByText('Add at least one entry, or turn the limit off.')).toBeInTheDocument();
    expect(api.keys.create).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText('Allowed models and aliases'), 'smart{Enter}');
    await user.click(within(form).getByRole('switch', { name: 'Local models only' }));
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.keys.create).toHaveBeenCalled());
    expect(api.keys.create.mock.calls[0]![0]).toMatchObject({ name: 'private', local_only: true, allowed_models: ['smart'] });
  });

  it('turns an emptied limit into "no limit", not zero', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Keys />);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog');
    const perDay = within(form).getByLabelText('Requests per day');
    expect(perDay).toHaveValue('1000');
    await user.clear(perDay);
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.keys.update).toHaveBeenCalled());
    const [id, body] = api.keys.update.mock.calls[0]!;
    expect(id).toBe('key_1');
    expect(body).toMatchObject({ rpd: null, tokens_per_day: 200000 });
  });

  it('revokes only after confirmation', async () => {
    const user = userEvent.setup();
    const { api } = renderPage(<Keys />);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    const ask = screen.getByRole('dialog');
    expect(within(ask).getByText('Revoke the key “open-webui”?')).toBeInTheDocument();
    await user.click(within(ask).getByRole('button', { name: 'Cancel' }));
    expect(api.keys.revoke).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(api.keys.revoke).toHaveBeenCalledWith('key_1'));
    expect(await screen.findByText('Key revoked.')).toBeInTheDocument();
  });

  it('shows a revoked key as such and offers nothing but deleting it', async () => {
    const api = fakeApi();
    api.keys.list.mockResolvedValue([apiKey({ revoked_at: '2026-10-13T00:00:00Z' })]);
    renderPage(<Keys />, api);
    const row = (await screen.findByText('open-webui')).closest('tr')!;
    expect(within(row).getByText('revoked')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('explains an empty list', async () => {
    const api = fakeApi();
    api.keys.list.mockResolvedValue([]);
    renderPage(<Keys />, api);
    expect(await screen.findByText('No client keys yet.')).toBeInTheDocument();
  });

  it('reports a failed save in the form, where the person is looking', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const { ApiError } = await import('../api/client');
    api.keys.create.mockRejectedValue(new ApiError(409, 'key_exists', 'A key with this name already exists'));
    renderPage(<Keys />, api);
    await screen.findByText('open-webui');
    await user.click(screen.getByRole('button', { name: 'Add key' }));
    const form = screen.getByRole('dialog');
    await user.type(within(form).getByLabelText('Name'), 'dup');
    await user.click(within(form).getByRole('button', { name: 'Create' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('A key with this name already exists');
    expect(screen.queryByTestId('new-key')).not.toBeInTheDocument();
  });
});
