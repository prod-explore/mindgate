import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Hub } from './context.js';

/**
 * The admin panel is a static web app (built from /panel). The hub only hands out its files; everything the panel
 * shows comes from /admin/api, which needs the admin token. So the files themselves are public and hold no secrets.
 */

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** The panel talks only to this origin and loads nothing from anywhere else, so it may do nothing else. */
export const PANEL_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** `assets/index-Dv8ZRr_P.css` -> the file inside `root`, or null when the path leaves it, hides, or is malformed. */
export function resolvePanelFile(root: string, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (rel.includes('\0') || rel.includes('\\')) return null;
  const parts = rel.split('/').filter(p => p !== '');
  // nothing that starts with a dot: not `..` or `.`, and not what is hidden (.env, .git, …)
  if (parts.some(p => p.startsWith('.'))) return null;
  const file = resolve(root, join(...parts));
  const base = resolve(root);
  return file === base || file.startsWith(base + sep) ? file : null;
}

async function fileInfo(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const s = await stat(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** True when `dir` holds a built panel. */
export async function panelBuilt(dir: string): Promise<boolean> {
  return (await fileInfo(join(dir, 'index.html'))) !== null;
}

export async function registerPanel(app: FastifyInstance, hub: Hub): Promise<void> {
  const dir = hub.config.panelDir;
  if (!dir) return;
  if (!(await panelBuilt(dir))) {
    hub.log.warn({ dir }, 'the admin panel is not built there, so /admin/ is off (cd panel && npm ci && npm run build, or set MINDGATE_PANEL_DIR)');
    return;
  }
  const root = resolve(dir);
  const realRoot = await realpath(root);

  const send = async (reply: FastifyReply, file: string, method: string) => {
    const info = await fileInfo(file);
    if (!info) return reply.callNotFound();
    // a link inside the directory must not lead out of it
    const real = await realpath(file).catch(() => null);
    if (!real || !(real === realRoot || real.startsWith(realRoot + sep))) return reply.callNotFound();
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const active = type.startsWith('text/html') || type.startsWith('image/svg');
    const hashed = file.startsWith(join(root, 'assets') + sep);
    reply
      .header('Content-Type', type)
      .header('Content-Length', info.size)
      // built file names carry a hash of their content, so they never change; the page that names them must always be re-checked
      .header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer');
    // pages (and images that could carry script) may only do what the panel needs
    if (active) reply.header('Content-Security-Policy', PANEL_CSP).header('Cross-Origin-Opener-Policy', 'same-origin');
    return method === 'HEAD' ? reply.send() : reply.send(createReadStream(file));
  };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/admin',
    handler: async (_req, reply) => reply.redirect('/admin/', 308),
  });

  app.route({
    method: ['GET', 'HEAD'],
    url: '/admin/*',
    handler: async (req, reply) => {
      const rest = (req.params as { '*': string })['*'];
      // /admin/api/<unknown> is a mistake in an API call, not a page to hand out
      if (rest === 'api' || rest.startsWith('api/')) return reply.callNotFound();
      const target = rest === '' ? join(root, 'index.html') : resolvePanelFile(root, rest);
      if (!target) return reply.callNotFound();
      return send(reply, target, req.method);
    },
  });
}
