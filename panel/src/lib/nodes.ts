import type { GpuInfo, NodeModel, PullJob } from '../api/types';
import type { Key } from '../i18n';

export const isActivePull = (job: PullJob): boolean => job.status === 'queued' || job.status === 'running';

/** The pulls that are still going come first, then the newest. */
export function sortPulls(jobs: PullJob[]): PullJob[] {
  return [...jobs].sort((a, b) => Number(isActivePull(b)) - Number(isActivePull(a)) || Date.parse(b.created_at) - Date.parse(a.created_at));
}

export type Fit = { kind: 'unknown' } | { kind: 'no_gpu' } | { kind: 'fits'; vram: number } | { kind: 'spills'; vram: number };

/** Weights need room next to the context cache; 90% of the card is the most a model file should take. */
const HEADROOM = 0.9;

/** Will this model file sit entirely in the graphics memory of the machine? (A rough guide, not a promise.) */
export function fit(model: Pick<NodeModel, 'size_bytes' | 'kind'>, gpus: GpuInfo[] | undefined): Fit {
  if (model.size_bytes === null || model.size_bytes <= 0) return { kind: 'unknown' };
  if (!gpus) return { kind: 'unknown' };
  const vram = Math.max(0, ...gpus.map(g => g.memory_total_bytes));
  if (vram <= 0) return { kind: 'no_gpu' };
  return model.size_bytes <= vram * HEADROOM ? { kind: 'fits', vram } : { kind: 'spills', vram };
}

/** Why a machine said no to a shutdown (or why it went down). Unknown reasons are shown as they are. */
export const SHUTDOWN_REASONS: Record<string, Key> = {
  requests_in_flight: 'nodes.reason.requests_in_flight',
  download_in_progress: 'nodes.reason.download_in_progress',
  user_active: 'nodes.reason.user_active',
  tray_unreachable: 'nodes.reason.tray_unreachable',
  refused_by_tray: 'nodes.reason.refused_by_tray',
  shutdown_failed: 'nodes.reason.shutdown_failed',
  shutdown_in_progress: 'nodes.reason.shutdown_in_progress',
  forced: 'nodes.reason.forced',
  shutdown_initiated: 'nodes.reason.shutdown_initiated',
  all_checks_passed: 'nodes.reason.shutdown_initiated',
};

/** Ollama names: lower case, digits, `.`, `_`, `-`, `:` and `/` (for `hf.co/user/repo:Q4_K_M`), no spaces. */
export const validPullName = (name: string): boolean => /^[A-Za-z0-9][\w.\-:/]{0,199}$/.test(name.trim());
