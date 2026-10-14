import { describe, expect, it } from 'vitest';
import { blankDraft, draftFromPreset, draftFromProvider, nodeOf, optionsOf, toInput, validate } from './provider-form';
import { cloud, provider } from '../test/fixtures';

const filled = () => ({ ...blankDraft(), id: 'openrouter', base_url: 'https://openrouter.ai/api/v1', api_key: 'sk-or-abc' });

describe('building the request', () => {
  it('creates a plain provider without node settings or an empty header', () => {
    const input = toInput(filled(), 'create');
    expect(input).toMatchObject({ id: 'openrouter', name: 'openrouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', auth_scheme: 'bearer', api_key: 'sk-or-abc', extra_headers: {} });
    expect('node' in input).toBe(false);
    expect('auth_header' in input).toBe(false);
  });

  it('on edit, an empty key box keeps the stored key, a typed one replaces it, and "remove" clears it', () => {
    const d = draftFromProvider(provider());
    expect('api_key' in toInput(d, 'edit')).toBe(false);
    expect(toInput({ ...d, api_key: '  new-secret  ' }, 'edit').api_key).toBe('new-secret');
    expect(toInput({ ...d, clear_key: true, api_key: 'ignored' }, 'edit').api_key).toBeNull();
  });

  it('on edit, switching the machine settings off sends null', () => {
    const d = { ...draftFromProvider(provider()), is_node: false };
    expect(toInput(d, 'edit').node).toBeNull();
  });

  it('only writes options that differ from the default and keeps the ones the form has no field for', () => {
    const d = { ...filled(), options_rest: { anthropic_version: '2023-06-01' }, stream_usage: false, first_byte_timeout_ms: 90_000, chat_path: ' /chat ' };
    expect(optionsOf(d)).toEqual({ anthropic_version: '2023-06-01', stream_usage: false, first_byte_timeout_ms: 90_000, chat_path: '/chat' });
    expect(optionsOf(filled())).toEqual({});
  });

  it('writes the machine settings, leaving optional addresses out when empty', () => {
    const d = { ...filled(), is_node: true, mac: ' AA:BB:CC:DD:EE:FF ', broadcast: '192.168.1.255', control_url: 'http://pc.lan:3001', idle_shutdown_minutes: 15 };
    expect(nodeOf(d)).toEqual({
      mac: 'AA:BB:CC:DD:EE:FF',
      broadcast: '192.168.1.255',
      port: 9,
      min_wake_priority: 3,
      boot_timeout_ms: 120000,
      poll_interval_ms: 2000,
      control_url: 'http://pc.lan:3001',
      idle_shutdown_minutes: 15,
    });
  });

  it('drops headers without a name', () => {
    const d = { ...filled(), headers: [{ name: 'X-Title', value: 'MindGate' }, { name: ' ', value: 'x' }] };
    expect(toInput(d, 'create').extra_headers).toEqual({ 'X-Title': 'MindGate' });
  });
});

describe('reading a provider back into the form', () => {
  it('round-trips without losing anything', () => {
    const p = provider({ extra_headers: { 'X-Title': 'MindGate' }, options: { first_byte_timeout_ms: 5000, anthropic_version: '2023-06-01' } });
    const d = draftFromProvider(p);
    expect(d.is_node).toBe(true);
    expect(d.control_url).toBe('http://pc.lan:3001');
    expect(d.headers).toEqual([{ name: 'X-Title', value: 'MindGate' }]);
    const input = toInput(d, 'edit');
    expect(input.options).toEqual({ first_byte_timeout_ms: 5000, anthropic_version: '2023-06-01' });
    expect(input.node).toMatchObject({ mac: 'AA:BB:CC:DD:EE:FF', control_url: 'http://pc.lan:3001' });
    expect(input.extra_headers).toEqual({ 'X-Title': 'MindGate' });
  });

  it('does not treat a cloud provider as a machine', () => {
    expect(draftFromProvider(cloud()).is_node).toBe(false);
  });

  it('starts a new provider from a preset', () => {
    const d = draftFromPreset({ id: 'openrouter', name: 'OpenRouter', type: 'openai', base_url: 'https://openrouter.ai/api/v1', locality: 'cloud', options: { auto_enable_models: false } });
    expect(d).toMatchObject({ id: 'openrouter', name: 'OpenRouter', locality: 'cloud', auto_enable_models: false });
  });

  it('a machine preset leaves the id for the person to choose and turns the machine settings on', () => {
    const d = draftFromPreset({ id: 'mindgate-node', name: 'PC with an agent', type: 'openai', base_url: 'http://pc.lan:3001/v1', locality: 'local', max_concurrency: 1, node: { port: 9, min_wake_priority: 3 } });
    expect(d.id).toBe('');
    expect(d.is_node).toBe(true);
    expect(d.max_concurrency).toBe(1);
    expect(d.locality).toBe('local');
  });
});

describe('validation', () => {
  it('accepts a good form', () => {
    expect(validate(filled(), 'create')).toEqual({});
  });
  it('wants a short lower-case id, only when creating', () => {
    for (const id of ['', 'Has Caps', '-lead', 'a'.repeat(33), 'with space', 'under_score']) expect(validate({ ...filled(), id }, 'create').id, id).toBeTruthy();
    expect(validate({ ...filled(), id: '' }, 'edit').id).toBeUndefined();
    for (const id of ['a', 'home', 'open-router', '0pc']) expect(validate({ ...filled(), id }, 'create').id, id).toBeUndefined();
  });
  it('wants an http(s) address', () => {
    for (const base_url of ['', 'openrouter.ai', 'ftp://x', 'http://', 'https://has space']) expect(validate({ ...filled(), base_url }, 'create').base_url, base_url).toBeTruthy();
    expect(validate({ ...filled(), base_url: 'http://pc.lan:3001/v1' }, 'create').base_url).toBeUndefined();
  });
  it('wants a header name when the key travels in a header', () => {
    expect(validate({ ...filled(), auth_scheme: 'header', auth_header: ' ' }, 'create').auth_header).toBeTruthy();
    expect(validate({ ...filled(), auth_scheme: 'header', auth_header: 'x-api-key' }, 'create').auth_header).toBeUndefined();
  });
  it('wants a real MAC address and a broadcast address for a machine', () => {
    const node = { ...filled(), is_node: true };
    expect(validate(node, 'create')).toMatchObject({ mac: expect.any(String), broadcast: expect.any(String) });
    for (const mac of ['AA:BB:CC:DD:EE', 'AA:BB:CC:DD:EE:GG', 'AABBCCDDEEFF']) expect(validate({ ...node, mac, broadcast: '1.2.3.255' }, 'create').mac, mac).toBeTruthy();
    for (const mac of ['AA:BB:CC:DD:EE:FF', 'aa-bb-cc-dd-ee-ff']) expect(validate({ ...node, mac, broadcast: '1.2.3.255' }, 'create').mac, mac).toBeUndefined();
  });
  it('idle shutdown needs a way to shut down', () => {
    const node = { ...filled(), is_node: true, mac: 'AA:BB:CC:DD:EE:FF', broadcast: '1.2.3.255', idle_shutdown_minutes: 15 };
    expect(validate(node, 'create').idle).toBeTruthy();
    expect(validate({ ...node, control_url: 'http://pc:3001' }, 'create').idle).toBeUndefined();
    expect(validate({ ...node, shutdown_url: 'http://pc:3002/shutdown' }, 'create').idle).toBeUndefined();
    expect(validate({ ...node, idle_shutdown_minutes: null }, 'create').idle).toBeUndefined();
  });
});
