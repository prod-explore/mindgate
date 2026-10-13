import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Finds and runs the Ollama binary.
 *
 * Search order: OLLAMA_PATH, the system PATH, then the places the installers use.
 */

export function findOllamaBinary(explicit?: string, log?: (m: string, o?: object) => void): string | null {
  if (explicit) {
    if (existsSync(explicit)) return explicit;
    log?.('OLLAMA_PATH does not exist, searching elsewhere', { path: explicit });
  }

  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ollama'], { encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {
    /* not on PATH */
  }

  const known: string[] = [];
  if (process.platform === 'win32') {
    known.push('C:\\Program Files\\Ollama\\ollama.exe', 'C:\\Program Files (x86)\\Ollama\\ollama.exe');
    // the per-user installer puts it in the profile of whoever installed it
    try {
      for (const user of readdirSync('C:\\Users')) {
        if (['Public', 'All Users', 'Default', 'Default User'].includes(user)) continue;
        known.push(join('C:\\Users', user, 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'));
      }
    } catch {
      /* no access to C:\Users */
    }
  } else {
    known.push('/usr/local/bin/ollama', '/usr/bin/ollama', '/opt/homebrew/bin/ollama');
  }
  return known.find(p => existsSync(p)) ?? null;
}

/** The environment Ollama gets: ours, minus the agent's own secrets. */
export function childEnv(base: NodeJS.ProcessEnv, host: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('MINDGATE_')) env[k] = v;
  env['OLLAMA_HOST'] = host;
  return env;
}

export interface OllamaProcess {
  child: ChildProcess;
  /** Resolves with the exit description when the process ends. */
  exited: Promise<string>;
}

export function spawnOllama(binary: string, host: string, env: NodeJS.ProcessEnv, onLine: (line: string) => void): OllamaProcess {
  const child = spawn(binary, ['serve'], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(env, host), windowsHide: true, detached: false });
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream?.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
  }
  const exited = new Promise<string>(resolve => {
    child.once('error', err => resolve(`could not run ${binary}: ${err.message}`));
    child.once('exit', (code, signal) => resolve(signal ? `killed by ${signal}` : `exited with code ${code}`));
  });
  return { child, exited };
}

export function killProcess(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}
