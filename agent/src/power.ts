import { execFile } from 'node:child_process';
import type { Activity } from './activity.js';
import type { PullManager } from './pulls.js';

export interface ShutdownAnswer {
  allow: boolean;
  reason: string;
}

export interface PowerOptions {
  trayUrl: string | null;
  delaySeconds: number;
  /** Runs the operating system's shutdown. Replaced in tests. */
  exec?: (command: string, args: string[]) => Promise<void>;
  fetch?: typeof fetch;
  log?: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
}

const run = (command: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 15_000 }, err => (err ? reject(err) : resolve()));
  });

/**
 * Switching the machine off, and the guards in front of it.
 *
 * The hub asks after the node sat idle for a while. The answer is "no" while a request or a download is running,
 * and — when a tray app is installed — while the tray says someone is using the PC. With no tray (a headless
 * server) nobody can be sitting there, so the agent's own checks are enough.
 */
export class Power {
  userActive = false;
  lastInputSecondsAgo = 0;
  userActiveAt: string | null = null;
  shuttingDown = false;
  private readonly exec: NonNullable<PowerOptions['exec']>;
  private readonly fetchImpl: typeof fetch;
  private readonly log: NonNullable<PowerOptions['log']>;

  constructor(
    private readonly opts: PowerOptions,
    private readonly activity: Activity,
    private readonly pulls: PullManager,
  ) {
    this.exec = opts.exec ?? run;
    this.fetchImpl = opts.fetch ?? fetch;
    this.log = opts.log ?? { info: () => undefined, warn: () => undefined };
  }

  get trayConfigured(): boolean {
    return this.opts.trayUrl !== null;
  }

  /** What the tray last told us. */
  setUserActive(active: boolean, lastInputSecondsAgo: number): void {
    this.userActive = active;
    this.lastInputSecondsAgo = Math.max(0, Math.floor(lastInputSecondsAgo) || 0);
    this.userActiveAt = new Date().toISOString();
  }

  get busy(): string | null {
    if (this.activity.inFlight > 0) return 'requests_in_flight';
    if (this.pulls.active > 0) return 'download_in_progress';
    return null;
  }

  get safeToShutdown(): boolean {
    return !this.shuttingDown && this.busy === null && !this.userActive;
  }

  /**
   * Shuts the machine down if nothing speaks against it. `force` is a person's explicit decision (the hub's panel):
   * it skips the guards, because the guards exist to stop a *timer* from switching the machine off.
   */
  async shutdown(opts: { idleMinutes?: number; force?: boolean } = {}): Promise<ShutdownAnswer> {
    if (this.shuttingDown) return { allow: true, reason: 'shutdown_in_progress' };

    if (!opts.force) {
      const busy = this.busy;
      if (busy) {
        this.log.info({ busy }, 'refused a shutdown request');
        return { allow: false, reason: busy };
      }
      if (this.opts.trayUrl) {
        const verdict = await this.askTray(opts.idleMinutes ?? 0);
        if (!verdict.allow) {
          this.log.info({ reason: verdict.reason }, 'the tray refused a shutdown');
          return verdict;
        }
      } else if (this.userActive) {
        return { allow: false, reason: 'user_active' };
      }
    }

    try {
      await this.executeShutdown();
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the shutdown command failed');
      return { allow: false, reason: 'shutdown_failed' };
    }
    this.shuttingDown = true;
    this.log.info({ force: opts.force === true }, 'the machine is shutting down');
    return { allow: true, reason: opts.force ? 'forced' : 'shutdown_initiated' };
  }

  private async askTray(idleMinutes: number): Promise<ShutdownAnswer> {
    try {
      const res = await this.fetchImpl(`${this.opts.trayUrl}/shutdown-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idle_minutes: idleMinutes }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const j = (await res.json()) as { allow?: unknown; reason?: unknown };
        return { allow: j.allow === true, reason: typeof j.reason === 'string' ? j.reason : j.allow === true ? 'all_checks_passed' : 'refused_by_tray' };
      }
      this.log.warn({ status: res.status }, 'the tray answered with an error');
    } catch (e) {
      this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'the tray does not answer');
    }
    // A machine that someone might be using is never switched off on a guess.
    return { allow: false, reason: 'tray_unreachable' };
  }

  private executeShutdown(): Promise<void> {
    const delay = this.opts.delaySeconds;
    const message = 'MindGate: automatic shutdown after a period of inactivity';
    if (process.platform === 'win32') return this.exec('shutdown', ['/s', '/t', String(delay), '/c', message]);
    const args = ['shutdown', '-h', delay > 0 ? `+${Math.ceil(delay / 60)}` : 'now', message];
    // root needs no sudo; anyone else needs a sudoers rule for `shutdown` (docs/02-agent.md)
    return process.getuid?.() === 0 ? this.exec(args[0]!, args.slice(1)) : this.exec('sudo', ['-n', ...args]);
  }
}
