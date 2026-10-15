import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Activity } from '../activity.js';
import { PullManager } from '../pulls.js';
import type { PullProgress, Runtime } from '../runtime.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** A runtime whose download reports what the test tells it to, and ends only when told to or when aborted. */
function stubRuntime(onPull: (report: (p: PullProgress) => void, signal: AbortSignal) => Promise<void>): Runtime {
  return { ensureRunning: async () => undefined, pull: async (_n: string, report: (p: PullProgress) => void, signal: AbortSignal) => onPull(report, signal) } as unknown as Runtime;
}
const hangsUntilAborted = (report?: (p: PullProgress) => void) =>
  stubRuntime((r, signal) => new Promise<void>((_res, rej) => {
    report?.(r as never);
    signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
  }));

describe('download stall guard', () => {
  it('gives up on a download that reports nothing, so the machine does not stay busy forever', async () => {
    const activity = new Activity();
    const pulls = new PullManager(hangsUntilAborted(), activity, undefined, 40);
    const job = pulls.start('qwen3:4b');
    assert.equal(pulls.active, 1);
    await sleep(120);
    assert.equal(job.status, 'failed');
    assert.match(job.error ?? '', /no progress/);
    assert.equal(pulls.active, 0);
  });

  it('keeps going while progress keeps arriving', async () => {
    const pulls = new PullManager(
      stubRuntime(async (report) => {
        for (let i = 1; i <= 5; i++) {
          await sleep(25);
          report({ phase: 'pulling', total: 100, completed: i * 20 });
        }
      }),
      new Activity(), undefined, 60,
    );
    const job = pulls.start('qwen3:4b');
    await sleep(250);
    assert.equal(job.status, 'succeeded');
  });

  it('a cancel is still a cancel, not a stall', async () => {
    const pulls = new PullManager(hangsUntilAborted(), new Activity(), undefined, 1000);
    const job = pulls.start('qwen3:4b');
    await sleep(10);
    pulls.cancel(job.id);
    await sleep(30);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.error, null);
  });

  it('the next queued download still runs after one stalls', async () => {
    let calls = 0;
    const pulls = new PullManager(
      stubRuntime((_r, signal) => (++calls === 1
        ? new Promise<void>((_res, rej) => signal.addEventListener('abort', () => rej(new Error('aborted')), { once: true }))
        : Promise.resolve())),
      new Activity(), undefined, 40,
    );
    const first = pulls.start('a:1b');
    const second = pulls.start('b:1b');
    await sleep(150);
    assert.equal(first.status, 'failed');
    assert.equal(second.status, 'succeeded');
  });
});
