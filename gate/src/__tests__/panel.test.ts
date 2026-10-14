import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { loadConfig } from '../config.js';
import { PANEL_CSP, resolvePanelFile } from '../panel.js';
import { ADMIN, MASTER, startHub, type TestHub } from './helpers.js';

const INDEX = '<!doctype html><title>MindGate</title><div id="root"></div><script type="module" src="/admin/assets/app-abc123.js"></script>';

describe('admin panel files', () => {
  let tmp: string;
  let root: string;
  let h: TestHub;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mindgate-panel-'));
    root = join(tmp, 'panel');
    mkdirSync(join(root, 'assets'), { recursive: true });
    writeFileSync(join(root, 'index.html'), INDEX);
    writeFileSync(join(root, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    writeFileSync(join(root, 'assets', 'app-abc123.js'), 'console.log("panel")');
    writeFileSync(join(root, 'assets', 'font.woff2'), 'wOF2');
    writeFileSync(join(root, '.env'), 'SECRET=hidden');
    // a folder called `api` inside the panel must never be served: /admin/api/* belongs to the API alone
    mkdirSync(join(root, 'api'));
    writeFileSync(join(root, 'api', 'leak.txt'), 'LEAK');
    // a file next to the panel directory that must never be reachable through it
    writeFileSync(join(tmp, 'secret.txt'), 'TOP-SECRET');
    mkdirSync(join(tmp, 'panel-evil'));
    writeFileSync(join(tmp, 'panel-evil', 'x.txt'), 'EVIL');
    symlinkSync(join(tmp, 'secret.txt'), join(root, 'assets', 'link.txt'));
    h = await startHub({ env: { MINDGATE_PANEL_DIR: root } });
  });

  after(async () => {
    await h.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  const get = (path: string, method = 'GET') => fetch(h.base + path, { method, redirect: 'manual' });

  /** The path exactly as written: fetch() would tidy `..` and `%2e%2e` away before they reach the server. */
  const rawGet = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const u = new URL(h.base);
      const req = request({ host: u.hostname, port: u.port, path, method: 'GET' }, res => {
        let body = '';
        res.on('data', c => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on('error', reject);
      req.end();
    });

  it('hands out the page at /admin/ with a strict content security policy', async () => {
    const r = await get('/admin/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(await r.text(), INDEX);
    assert.equal(r.headers.get('cache-control'), 'no-cache');
    assert.equal(r.headers.get('content-security-policy'), PANEL_CSP);
    assert.match(PANEL_CSP, /script-src 'self'/);
    assert.doesNotMatch(PANEL_CSP, /unsafe-inline|unsafe-eval/);
    assert.match(PANEL_CSP, /frame-ancestors 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('redirects /admin to /admin/', async () => {
    const r = await get('/admin');
    assert.equal(r.status, 308);
    assert.equal(r.headers.get('location'), '/admin/');
  });

  it('serves built assets with the right type, cached for good because their names carry a hash', async () => {
    const js = await get('/admin/assets/app-abc123.js');
    assert.equal(js.status, 200);
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await js.text(), 'console.log("panel")');
    assert.equal((await get('/admin/assets/font.woff2')).headers.get('content-type'), 'font/woff2');
    const svg = await get('/admin/favicon.svg');
    assert.equal(svg.headers.get('content-type'), 'image/svg+xml');
    assert.equal(svg.headers.get('cache-control'), 'no-cache');
    assert.equal(svg.headers.get('content-security-policy'), PANEL_CSP);
  });

  it('answers HEAD with the headers and no body', async () => {
    const r = await get('/admin/assets/app-abc123.js', 'HEAD');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-length'), String('console.log("panel")'.length));
    assert.equal(await r.text(), '');
  });

  it('never leaves its directory', async () => {
    const attempts = [
      '/admin/../secret.txt',
      '/admin/%2e%2e/secret.txt',
      '/admin/%2e%2e%2fsecret.txt',
      '/admin/assets/..%2f..%2fsecret.txt',
      '/admin/assets/%2e%2e/%2e%2e/secret.txt',
      '/admin/..%2fpanel-evil/x.txt',
      '/admin/assets/..%5c..%5csecret.txt',
      '/admin/%00',
      '/admin/assets/app-abc123.js%00.png',
      '/admin/%ZZ',
      '/admin/../../etc/passwd',
      '/admin/assets/../../secret.txt',
    ];
    for (const path of attempts) {
      const r = await rawGet(path);
      assert.ok(!r.body.includes('TOP-SECRET') && !r.body.includes('EVIL'), `${path} leaked a file`);
      assert.ok(r.status === 404 || r.status === 400, `${path} -> ${r.status}`);
    }
  });

  it('does not hand out hidden files, directories or what a link points to outside', async () => {
    assert.equal((await get('/admin/.env')).status, 404);
    assert.equal((await get('/admin/assets/')).status, 404);
    assert.equal((await get('/admin/assets')).status, 404);
    assert.equal((await get('/admin/nothing-here.js')).status, 404);
    const link = await get('/admin/assets/link.txt');
    assert.ok(!(await link.text()).includes('TOP-SECRET'), 'a symlink led out of the panel directory');
  });

  it('keeps the API where it was: unknown API paths are JSON errors, and the API still needs the token', async () => {
    const unknown = await h.api('GET', '/admin/api/nope', undefined, {}, ADMIN);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'unknown_endpoint');
    assert.equal((await h.api('GET', '/admin/api', undefined, {}, ADMIN)).status, 404);
    assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, null)).status, 401);
    assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, ADMIN)).status, 200);
  });

  it('never serves a panel file from under the API path', async () => {
    for (const path of ['/admin/api/leak.txt', '/admin/api']) {
      const r = await get(path);
      assert.equal(r.status, 404, path);
      assert.doesNotMatch(await r.text(), /LEAK/, path);
    }
  });

  it('only reads: other methods are not routes', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await fetch(h.base + '/admin/', { method, headers: { 'Content-Type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 404, method);
    }
  });
});

describe('admin panel switched off', () => {
  it('has no files when the directory is empty or unset to nothing', async () => {
    const h = await startHub({ env: { MINDGATE_PANEL_DIR: '' } });
    try {
      assert.equal((await fetch(h.base + '/admin/')).status, 404);
      assert.equal((await fetch(h.base + '/admin')).status, 404);
      assert.equal((await h.api('GET', '/admin/api/status', undefined, {}, ADMIN)).status, 200);
    } finally {
      await h.close();
    }
  });

  it('starts without a panel when the directory holds no build', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mindgate-nopanel-'));
    const h = await startHub({ env: { MINDGATE_PANEL_DIR: empty } });
    try {
      assert.equal((await fetch(h.base + '/admin/')).status, 404);
      assert.equal((await h.api('GET', '/health', undefined, {}, null)).status, 200);
    } finally {
      await h.close();
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('panel directory setting', () => {
  const env = { MINDGATE_MASTER_KEY: MASTER, MINDGATE_ADMIN_TOKEN: ADMIN };
  it('defaults to the panel built next to the hub, can be moved, and can be turned off', () => {
    const def = loadConfig({ ...env }, () => undefined).panelDir;
    assert.ok(def && def.endsWith(join('panel', 'dist')), String(def));
    assert.equal(loadConfig({ ...env, MINDGATE_PANEL_DIR: '/srv/panel' }, () => undefined).panelDir, '/srv/panel');
    assert.equal(loadConfig({ ...env, MINDGATE_PANEL_DIR: '' }, () => undefined).panelDir, null);
  });
});

describe('resolvePanelFile', () => {
  const root = '/srv/panel';
  it('maps a URL path into the directory', () => {
    assert.equal(resolvePanelFile(root, 'assets/app.js'), '/srv/panel/assets/app.js');
    assert.equal(resolvePanelFile(root, 'a//b'), '/srv/panel/a/b');
  });
  it('refuses everything that is not a plain path below it', () => {
    for (const bad of ['a/../index.html', 'assets/../assets/app.js', '../x', 'a/../../x', '%2e%2e/x', 'a/%2e%2e/%2e%2e/x', '.env', 'a/.git/config', 'a\\b', 'a%5Cb', 'a%00b', '%E0%A4%A']) {
      assert.equal(resolvePanelFile(root, bad), null, bad);
    }
  });
});
