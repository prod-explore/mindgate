import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from '../config.js';
import { SECRET } from './harness.js';

const load = (env: Record<string, string>, warn: (m: string) => void = () => undefined) => loadConfig({ MINDGATE_NODE_SECRET: SECRET, ...env }, warn);

describe('agent configuration', () => {
  it('refuses to start without a secret, or with a weak one', () => {
    assert.throws(() => loadConfig({}, () => undefined), /MINDGATE_NODE_SECRET is not set/);
    assert.throws(() => loadConfig({ MINDGATE_NODE_SECRET: 'change-me' }, () => undefined), /placeholder/);
    assert.throws(() => loadConfig({ MINDGATE_NODE_SECRET: 'short' }, () => undefined), /shorter than/);
    assert.throws(() => loadConfig({ MINDGATE_NODE_SECRET: 'abababababababababababababab' }, () => undefined), /too few distinct/);
  });

  it('a weak secret can be allowed for development, with a warning', () => {
    const warnings: string[] = [];
    const c = loadConfig({ MINDGATE_NODE_SECRET: 'dev', MINDGATE_ALLOW_WEAK_SECRETS: 'true' }, m => warnings.push(m));
    assert.equal(c.secret, 'dev');
    assert.equal(warnings.length, 1);
  });

  it('has sensible defaults for a machine with Ollama installed next to the agent', () => {
    const c = load({});
    assert.equal(c.port, 3001);
    assert.equal(c.host, '0.0.0.0');
    assert.equal(c.ollama.url, 'http://127.0.0.1:11434');
    assert.equal(c.ollama.manage, true);
    assert.equal(c.trayUrl, 'http://127.0.0.1:3002');
    assert.equal(c.shutdownDelaySeconds, 30);
    assert.ok(c.nodeId.length > 0);
  });

  it('an empty MINDGATE_TRAY_URL means there is no tray (a headless server)', () => {
    assert.equal(load({ MINDGATE_TRAY_URL: '' }).trayUrl, null);
    assert.equal(load({ MINDGATE_TRAY_URL: 'http://localhost:4000/' }).trayUrl, 'http://localhost:4000');
  });

  it('only manages an Ollama that is on this machine', () => {
    assert.equal(load({ OLLAMA_URL: 'http://192.168.1.5:11434' }).ollama.manage, false);
    assert.throws(() => load({ OLLAMA_URL: 'http://192.168.1.5:11434', MINDGATE_MANAGE_OLLAMA: 'true' }), /on this machine/);
    assert.equal(load({ MINDGATE_MANAGE_OLLAMA: 'false' }).ollama.manage, false);
  });

  it('reads the context window Ollama was told to use', () => {
    assert.equal(load({ OLLAMA_CONTEXT_LENGTH: '8192' }).ollama.contextCap, 8192);
    assert.equal(load({}).ollama.contextCap, null);
  });

  it('says what is wrong with a bad value', () => {
    assert.throws(() => load({ MINDGATE_NODE_PORT: 'abc' }), /MINDGATE_NODE_PORT must be an integer/);
    assert.throws(() => load({ MINDGATE_NODE_PORT: '70000' }), /MINDGATE_NODE_PORT/);
    assert.throws(() => load({ OLLAMA_URL: 'not a url' }), /OLLAMA_URL is not a valid URL/);
    assert.throws(() => load({ OLLAMA_URL: 'ftp://x' }), /http:\/\/ or https:\/\//);
    assert.throws(() => load({ MINDGATE_MANAGE_OLLAMA: 'maybe' }), /true or false/);
  });
});
