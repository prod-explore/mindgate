import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiProvider } from './api/context';
import { App } from './app';
import { setLang } from './i18n';
import { signIn, signOut } from './lib/session';
import { fakeApi } from './test/fixtures';

beforeEach(() => {
  setLang('en');
  signOut();
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = '';
});
afterEach(() => signOut());

const mount = (api = fakeApi()) => ({ api, ...render(<ApiProvider api={api}><App /></ApiProvider>) });

describe('the app', () => {
  it('shows the sign-in screen, and nothing from the hub, to someone without a token', () => {
    const { api } = mount();
    expect(screen.getByRole('heading', { name: 'Sign in to MindGate' })).toBeInTheDocument();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.providers.list).not.toHaveBeenCalled();
  });

  it('shows the panel once there is a token, with the counts from the hub next to the menu', async () => {
    act(() => signIn('tok', false));
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /Providers/ })).toHaveTextContent('2');
    expect(within(nav).getByRole('link', { name: /^Aliases/ })).toBeInTheDocument();
    // machines and models live under their provider now
    expect(within(nav).queryByRole('link', { name: 'Nodes' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: /^Models/ })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Usage' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Request log' })).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Overview – MindGate'));
  });

  it('goes to the page in the address and keeps the menu in step', async () => {
    window.location.hash = '#/keys';
    act(() => signIn('tok', false));
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Client keys' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Client keys/ })).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe('Client keys – MindGate');

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: 'Request log' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Request log' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/log');
  });

  it('opens the providers in the menu, each linking to its own page', async () => {
    const user = userEvent.setup();
    act(() => signIn('tok', false));
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Home PC' })).not.toBeInTheDocument(); // closed away from the providers
    await user.click(within(nav).getByRole('button', { name: 'Show the providers' }));
    expect(within(nav).getByRole('link', { name: 'Home PC' })).toHaveAttribute('href', '#/providers/home');
    expect(within(nav).getByRole('link', { name: 'OpenRouter' })).toHaveAttribute('href', '#/providers/openrouter');
    await user.click(within(nav).getByRole('button', { name: 'Show the providers' }));
    expect(within(nav).queryByRole('link', { name: 'Home PC' })).not.toBeInTheDocument();
  });

  it('is open on the providers, and marks the one being looked at', async () => {
    window.location.hash = '#/providers/openrouter';
    act(() => signIn('tok', false));
    mount();
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(await within(nav).findByRole('link', { name: 'OpenRouter' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: /^Providers/ })).not.toHaveAttribute('aria-current');
  });

  it('sends the old address of a machine to its provider page', async () => {
    window.location.hash = '#/nodes/home';
    act(() => signIn('tok', false));
    mount();
    await waitFor(() => expect(window.location.hash).toBe('#/providers/home'));
  });

  it('says so for a page that does not exist', async () => {
    window.location.hash = '#/nothing-here';
    act(() => signIn('tok', false));
    mount();
    expect(await screen.findByText('There is no page here.')).toBeInTheDocument();
  });

  it('signs out, and forgets the token everywhere', async () => {
    const user = userEvent.setup();
    act(() => signIn('tok', true));
    mount();
    await screen.findByRole('navigation', { name: 'Main' });
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in to MindGate' })).toBeInTheDocument();
    expect(localStorage.getItem('mindgate.admin-token')).toBeNull();
    expect(sessionStorage.getItem('mindgate.admin-token')).toBeNull();
  });

  it('goes back to the sign-in screen, with the reason, when the hub stops accepting the token', async () => {
    act(() => signIn('tok', false));
    mount();
    await screen.findByRole('navigation', { name: 'Main' });
    act(() => signOut(true));
    expect(await screen.findByText('The hub did not accept the token. Sign in again.')).toBeInTheDocument();
  });

  it('speaks Polish when switched, in the menu and on the page', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/keys';
    act(() => signIn('tok', false));
    mount();
    await screen.findByRole('heading', { level: 1, name: 'Client keys' });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'pl');
    expect(await screen.findByRole('heading', { level: 1, name: 'Klucze klientów' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Dostawcy/ })).toBeInTheDocument();
    expect(document.documentElement.lang).toBe('pl');
  });
});
