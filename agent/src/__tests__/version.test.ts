import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { VERSION } from '../version.js';

describe('version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mindgate-agent-version-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('is the one in package.json', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    assert.equal(VERSION, manifest.version);
  });

  it('a build without its package.json fails to load instead of reporting a version', async () => {
    // The compiled module alone, one level below a directory that has no package.json.
    mkdirSync(join(dir, 'dist'));
    const copy = join(dir, 'dist', 'version.js');
    copyFileSync(new URL('../version.js', import.meta.url), copy);
    await assert.rejects(import(pathToFileURL(copy).href), { code: 'ENOENT' });
  });
});
