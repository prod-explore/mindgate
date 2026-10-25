import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { localBroadcasts, sendMagicPacket, type MagicTarget } from './wol.js';

/**
 * Sends Wake-on-LAN packets for the hub. It runs on the host's own network (network_mode: host), because a container on a
 * Docker bridge cannot broadcast onto the LAN. It only ever sends to this machine's own broadcast addresses, and only for
 * a caller with the shared token, so it cannot be used to fire UDP at arbitrary hosts.
 *
 *   POST /wake   Authorization: Bearer <token>   { "mac": "AA:BB:CC:DD:EE:FF", "broadcast": "192.168.1.255", "port": 9 }
 */

const MAC = /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i;

export interface RelayDeps {
  token: string;
  broadcasts?: () => Set<string>;
  send?: (t: MagicTarget) => Promise<void>;
  log?: (o: object) => void;
}

const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRelay({ token, broadcasts = localBroadcasts, send = sendMagicPacket, log = () => undefined }: RelayDeps): Server {
  return createServer((req, res) => {
    const reply = (status: number, body?: object) => {
      res.writeHead(status, body ? { 'content-type': 'application/json' } : {});
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const fail = (status: number, code: string, message: string) => reply(status, { error: { code, message } });

    if (req.method !== 'POST' || req.url !== '/wake') return fail(404, 'not_found', 'POST /wake is the only endpoint');
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!m || !safeEqual(m[1]!.trim(), token)) return fail(401, 'unauthorized', 'missing or wrong token');

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2048) {
        fail(413, 'too_large', 'the request body is larger than 2 KiB');
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (res.writableEnded) return;
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        return fail(400, 'invalid_json', 'the body is not valid JSON');
      }
      const mac = body['mac'];
      const broadcast = body['broadcast'];
      const port = body['port'] === undefined ? 9 : body['port'];
      if (typeof mac !== 'string' || !MAC.test(mac)) return fail(400, 'invalid_mac', 'mac must look like AA:BB:CC:DD:EE:FF');
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return fail(400, 'invalid_port', 'port must be 1-65535');
      const allowed = broadcasts();
      if (typeof broadcast !== 'string' || !allowed.has(broadcast)) {
        return fail(400, 'invalid_broadcast', `broadcast must be a broadcast address of this machine's networks: ${[...allowed].join(', ')}`);
      }
      send({ mac, broadcast, port }).then(
        () => {
          log({ msg: 'magic packet sent', mac, broadcast, port });
          reply(204);
        },
        (e: unknown) => {
          log({ msg: 'magic packet failed', mac, broadcast, port, error: e instanceof Error ? e.message : String(e) });
          fail(502, 'send_failed', e instanceof Error ? e.message : String(e));
        },
      );
    });
  });
}

function main(): void {
  const token = process.env['MINDGATE_WOL_RELAY_TOKEN'] ?? '';
  if (token.length < 16) {
    console.error('[wol-relay] MINDGATE_WOL_RELAY_TOKEN is required (at least 16 characters; openssl rand -hex 24)');
    process.exit(1);
  }
  const host = process.env['MINDGATE_WOL_RELAY_BIND'] || '127.0.0.1';
  const port = Number(process.env['MINDGATE_WOL_RELAY_PORT'] || 7009);
  const log = (o: object) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));
  const server = createRelay({ token, log });
  server.listen(port, host, () => log({ msg: 'wol relay listening', host, port, broadcasts: [...localBroadcasts()] }));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
