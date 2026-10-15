import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, signOut } from '../lib/session';
import { hubStatus } from '../test/fixtures';
import { Login } from './Login';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  signOut();
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  signOut();
});

async function typeToken(token: string, remember = false) {
  const user = userEvent.setup();
  render(<Login expired={false} />);
  await user.type(screen.getByLabelText('Admin token'), token);
  if (remember) await user.click(screen.getByRole('switch', { name: /Keep me signed in/ }));
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('signing in', () => {
  it('asks the hub with the typed token before accepting it', async () => {
    const fetchMock = vi.fn(async () => json(200, hubStatus()));
    vi.stubGlobal('fetch', fetchMock);
    await typeToken('  correct-token  ');
    await waitFor(() => expect(getToken()).toBe('correct-token'));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('/admin/api/status');
    expect(init.headers['Authorization']).toBe('Bearer correct-token');
  });

  it('keeps the token for this tab only, unless asked to remember it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, hubStatus())));
    await typeToken('tab-only-token');
    await waitFor(() => expect(getToken()).toBe('tab-only-token'));
    expect(sessionStorage.getItem('mindgate.admin-token')).toBe('tab-only-token');
    expect(localStorage.getItem('mindgate.admin-token')).toBeNull();
  });

  it('remembers it on the device when asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, hubStatus())));
    await typeToken('remembered-token', true);
    await waitFor(() => expect(getToken()).toBe('remembered-token'));
    expect(localStorage.getItem('mindgate.admin-token')).toBe('remembered-token');
    expect(sessionStorage.getItem('mindgate.admin-token')).toBeNull();
  });

  it('does not accept a token the hub refuses, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { error: { message: 'Invalid admin token', code: 'invalid_admin_token', type: 'authentication_error' } })));
    await typeToken('wrong');
    expect(await screen.findByRole('alert')).toHaveTextContent('That is not the admin token.');
    expect(getToken()).toBeNull();
    expect(sessionStorage.getItem('mindgate.admin-token')).toBeNull();
    expect(localStorage.getItem('mindgate.admin-token')).toBeNull();
  });

  it('says when the hub cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await typeToken('whatever');
    expect(await screen.findByRole('alert')).toHaveTextContent('The hub does not answer');
    expect(getToken()).toBeNull();
  });

  it('says when the hub is throttling wrong tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(429, { error: { message: 'Try again in 60 s', code: 'too_many_auth_failures' } })));
    await typeToken('guess');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Too many wrong tokens.*Try again in 60 s/);
  });

  it('cannot be submitted empty, and tells a returning person why they are here', () => {
    render(<Login expired />);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.getByText('The hub did not accept the token. Sign in again.')).toBeInTheDocument();
  });

});
