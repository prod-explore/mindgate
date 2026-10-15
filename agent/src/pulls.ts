import { randomUUID } from 'node:crypto';
import type { Activity } from './activity.js';
import { AgentError, isAgentError } from './errors.js';
import { MODEL_NAME, type PullProgress, type Runtime } from './runtime.js';

export type PullStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface PullJob {
  id: string;
  name: string;
  status: PullStatus;
  phase: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const KEEP_FINISHED = 50;
/** A download that reports no progress for this long is given up on (a dead connection would otherwise keep the machine "busy" forever). */
export const DEFAULT_STALL_MS = 10 * 60_000;

/**
 * Model downloads run in the background: the hub starts one, then watches it. A download is a job with an id, so a
 * panel can close and reopen and still see it; one runs at a time (a second one would only slow the first).
 */
export class PullManager {
  private readonly jobs = new Map<string, PullJob>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly waiting: string[] = [];
  private running = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly activity: Activity,
    private readonly log: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void } = { info: () => undefined, warn: () => undefined },
    private readonly stallMs: number = DEFAULT_STALL_MS,
  ) {}

  /** Downloads in progress or waiting. */
  get active(): number {
    return [...this.jobs.values()].filter(j => j.status === 'queued' || j.status === 'running').length;
  }

  list(): PullJob[] {
    return [...this.jobs.values()].reverse();
  }

  get(id: string): PullJob | undefined {
    return this.jobs.get(id);
  }

  /** Starts a download; asking again for a model that is already on its way returns the same job. */
  start(name: string): PullJob {
    if (!MODEL_NAME.test(name)) throw new AgentError(400, 'invalid_model_name', `"${name.slice(0, 80)}" is not a model name (letters, digits and . _ - : / @ + only)`);
    const existing = [...this.jobs.values()].find(j => j.name === name && (j.status === 'queued' || j.status === 'running'));
    if (existing) return existing;

    const job: PullJob = {
      id: randomUUID(),
      name,
      status: 'queued',
      phase: 'queued',
      completed: null,
      total: null,
      percent: null,
      error: null,
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
    };
    this.jobs.set(job.id, job);
    this.aborts.set(job.id, new AbortController());
    this.waiting.push(job.id);
    this.prune();
    void this.pump();
    return job;
  }

  /** Cancels a download that is waiting or running; a finished one is just removed from the list. */
  cancel(id: string): PullJob {
    const job = this.jobs.get(id);
    if (!job) throw new AgentError(404, 'pull_not_found', `There is no download ${id}`);
    if (job.status === 'queued' || job.status === 'running') {
      this.aborts.get(id)?.abort();
      if (job.status === 'queued') {
        this.waiting.splice(this.waiting.indexOf(id), 1);
        this.finish(job, 'cancelled', null);
      }
    } else {
      this.jobs.delete(id);
    }
    return job;
  }

  /** Stops everything (the agent is shutting down). */
  abortAll(): void {
    for (const c of this.aborts.values()) c.abort();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let id = this.waiting.shift(); id; id = this.waiting.shift()) {
        const job = this.jobs.get(id);
        if (job) await this.run(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async run(job: PullJob): Promise<void> {
    const abort = this.aborts.get(job.id)!;
    if (abort.signal.aborted) return void this.finish(job, 'cancelled', null);
    job.status = 'running';
    job.started_at = new Date().toISOString();
    job.phase = 'starting';
    this.activity.touch();
    this.log.info({ model: job.name }, 'download started');
    // No progress for stallMs: abort, and report why (a user's cancel is told apart by `stalled`).
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        abort.abort();
      }, this.stallMs);
    };
    arm();
    try {
      await this.runtime.ensureRunning();
      await this.runtime.pull(job.name, p => { arm(); this.progress(job, p); }, abort.signal);
      job.phase = 'success';
      if (job.total) job.completed = job.total;
      job.percent = 100;
      this.finish(job, 'succeeded', null);
      this.log.info({ model: job.name }, 'download finished');
    } catch (e) {
      if (stalled) {
        const message = `no progress for ${Math.round(this.stallMs / 60_000)} min; the download was given up (start it again to resume)`;
        this.log.warn({ model: job.name }, 'download stalled');
        this.finish(job, 'failed', message);
      } else if (abort.signal.aborted) this.finish(job, 'cancelled', null);
      else {
        const message = isAgentError(e) ? e.message : e instanceof Error ? e.message : String(e);
        this.log.warn({ model: job.name, err: message }, 'download failed');
        this.finish(job, 'failed', message);
      }
    } finally {
      clearTimeout(timer);
      this.activity.touch();
    }
  }

  private progress(job: PullJob, p: PullProgress): void {
    this.activity.touch();
    job.phase = p.phase || job.phase;
    if (p.total) {
      job.total = p.total;
      job.completed = p.completed ?? 0;
      job.percent = Math.min(99, Math.floor((job.completed / p.total) * 100));
    }
  }

  private finish(job: PullJob, status: PullStatus, error: string | null): void {
    job.status = status;
    job.error = error;
    job.finished_at = new Date().toISOString();
    if (status === 'cancelled') job.phase = 'cancelled';
    this.aborts.delete(job.id);
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter(j => j.status !== 'queued' && j.status !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(j.id);
  }
}
