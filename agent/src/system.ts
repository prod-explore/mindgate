import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus, freemem, homedir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';

export interface Gpu {
  name: string;
  memory_total_bytes: number;
  memory_used_bytes: number;
  utilization_percent: number | null;
}

export interface SystemInfo {
  cpu_count: number;
  memory: { total_bytes: number; free_bytes: number };
  gpus: Gpu[];
  disk: { path: string; total_bytes: number; free_bytes: number } | null;
}

const MIB = 1024 * 1024;

/** NVIDIA cards, through nvidia-smi. Anything else (or no driver) simply shows no GPU: this is information, not a requirement. */
export function readGpus(): Promise<Gpu[]> {
  return new Promise(resolve => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve([]);
        const gpus: Gpu[] = [];
        for (const line of stdout.split(/\r?\n/)) {
          const [name, total, used, util] = line.split(',').map(s => s.trim());
          if (!name || !Number.isFinite(Number(total))) continue;
          gpus.push({
            name,
            memory_total_bytes: Number(total) * MIB,
            memory_used_bytes: Number(used) * MIB,
            utilization_percent: Number.isFinite(Number(util)) ? Number(util) : null,
          });
        }
        resolve(gpus);
      },
    );
  });
}

/** Free space where the models are stored (the nearest folder that exists, since the first pull creates it). */
export async function readDisk(modelsDir: string | undefined): Promise<SystemInfo['disk']> {
  let path = modelsDir ?? join(homedir(), '.ollama', 'models');
  for (let i = 0; i < 8; i++) {
    try {
      const s = await statfs(path);
      return { path, total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize };
    } catch {
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  return null;
}

let cache: { at: number; value: Pick<SystemInfo, 'gpus' | 'disk'> } | null = null;

export async function readSystem(modelsDir: string | undefined, now = Date.now()): Promise<SystemInfo> {
  // nvidia-smi takes a moment; a panel refreshing every few seconds should not run it every time
  if (!cache || now - cache.at > 5000) {
    const [gpus, disk] = await Promise.all([readGpus(), readDisk(modelsDir)]);
    cache = { at: now, value: { gpus, disk } };
  }
  return { cpu_count: cpus().length, memory: { total_bytes: totalmem(), free_bytes: freemem() }, ...cache.value };
}
