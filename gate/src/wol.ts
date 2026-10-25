import dgram from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

export interface MagicTarget {
  mac: string;
  broadcast: string;
  port: number;
}

/** Six 0xFF bytes followed by the MAC address sixteen times. */
export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac.split(/[:-]/).map(h => parseInt(h, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** Sends the packet from this process's own network stack. */
export function sendMagicPacket(cfg: MagicTarget): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', err => {
      socket.close();
      reject(err);
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* unicast targets do not need it */
      }
      socket.send(magicPacket(cfg.mac), cfg.port, cfg.broadcast, err => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

/** The directed broadcast addresses of this machine's IPv4 networks (192.168.1.255 for 192.168.1.43/24), and the limited broadcast. */
export function localBroadcasts(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): Set<string> {
  const out = new Set<string>(['255.255.255.255']);
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((o, i) => (o & mask[i]!) | (~mask[i]! & 255)).join('.'));
    }
  }
  return out;
}

/**
 * A sender that asks the Wake-on-LAN relay (wol-relay.ts) to send the packet. A hub inside a Docker bridge network cannot
 * put a broadcast on the LAN, and a unicast packet to a switched-off machine is dropped because nobody answers the ARP request
 * for its address; the relay runs on the host's own network and sends the real broadcast.
 */
export function relaySender(url: string, token: string, fetchImpl: typeof fetch = fetch): (cfg: MagicTarget) => Promise<void> {
  const endpoint = new URL('/wake', url).toString();
  return async cfg => {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mac: cfg.mac, broadcast: cfg.broadcast, port: cfg.port }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`the Wake-on-LAN relay answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
}
