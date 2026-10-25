import type { Db } from '../db.js';
import type { Usage } from '../types.js';

export interface LogEntry {
  ts: string;
  requestId: string;
  keyId: string | null;
  keyName: string | null;
  endpoint: string;
  requestedModel: string | null;
  modelId: string | null;
  providerId: string | null;
  status: number;
  errorCode: string | null;
  stream: boolean;
  priority: number | null;
  localOnly: boolean;
  tag: string | null;
  attempts: Array<{ model: string; outcome: string }>;
  queueMs: number | null;
  ttfbMs: number | null;
  latencyMs: number | null;
  usage: Usage | null;
}

export interface Totals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
}

export interface UsageRow extends Totals {
  day: string;
  keyId: string;
  modelId: string;
}

export interface LogRow {
  id: number;
  ts: string;
  requestId: string;
  keyId: string | null;
  keyName: string | null;
  endpoint: string;
  requestedModel: string | null;
  modelId: string | null;
  providerId: string | null;
  status: number;
  errorCode: string | null;
  stream: boolean;
  priority: number | null;
  localOnly: boolean;
  tag: string | null;
  attempts: Array<{ model: string; outcome: string }>;
  queueMs: number | null;
  ttfbMs: number | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimated: boolean;
}

export class UsageStore {
  constructor(private readonly db: Db) {}

  /** Adds one finished request to the day's totals of its key and of the model it was routed to. */
  record(day: string, keyId: string, modelId: string, add: { requests: number; errors: number; inputTokens: number; outputTokens: number }): void {
    this.db
      .prepare(
        `INSERT INTO usage_daily (day, key_id, model_id, requests, errors, input_tokens, output_tokens)
         VALUES (@day, @keyId, @modelId, @requests, @errors, @inputTokens, @outputTokens)
         ON CONFLICT (day, key_id, model_id) DO UPDATE SET
           requests = requests + excluded.requests, errors = errors + excluded.errors,
           input_tokens = input_tokens + excluded.input_tokens, output_tokens = output_tokens + excluded.output_tokens`,
      )
      .run({ day, keyId, modelId, ...add });
  }

  /** Totals for one key over [fromDay, toDay] (inclusive day keys). */
  totals(keyId: string, fromDay: string, toDay: string): Totals {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(requests),0) AS requests, COALESCE(SUM(errors),0) AS errors,
                COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens
         FROM usage_daily WHERE key_id = ? AND day >= ? AND day <= ?`,
      )
      .get(keyId, fromDay, toDay) as Totals;
    return r;
  }

  byModel(keyId: string, fromDay: string, toDay: string): Array<Totals & { modelId: string }> {
    return this.db
      .prepare(
        `SELECT model_id AS modelId, SUM(requests) AS requests, SUM(errors) AS errors,
                SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens
         FROM usage_daily WHERE key_id = ? AND day >= ? AND day <= ? GROUP BY model_id ORDER BY requests DESC`,
      )
      .all(keyId, fromDay, toDay) as Array<Totals & { modelId: string }>;
  }

  rows(opts: { fromDay: string; toDay: string; keyId?: string; modelId?: string }): UsageRow[] {
    const where = ['day >= @fromDay', 'day <= @toDay'];
    if (opts.keyId) where.push('key_id = @keyId');
    if (opts.modelId) where.push('model_id = @modelId');
    return this.db
      .prepare(
        `SELECT day, key_id AS keyId, model_id AS modelId, requests, errors, input_tokens AS inputTokens, output_tokens AS outputTokens
         FROM usage_daily WHERE ${where.join(' AND ')} ORDER BY day, key_id, model_id`,
      )
      .all(opts) as UsageRow[];
  }

  log(e: LogEntry): void {
    this.db
      .prepare(
        `INSERT INTO request_log (ts, request_id, key_id, key_name, endpoint, requested_model, model_id, provider_id, status, error_code,
                                  stream, priority, local_only, tag, attempts, queue_ms, ttfb_ms, latency_ms, input_tokens, output_tokens, estimated)
         VALUES (@ts, @requestId, @keyId, @keyName, @endpoint, @requestedModel, @modelId, @providerId, @status, @errorCode,
                 @stream, @priority, @localOnly, @tag, @attempts, @queueMs, @ttfbMs, @latencyMs, @inputTokens, @outputTokens, @estimated)`,
      )
      .run({
        ts: e.ts,
        requestId: e.requestId,
        keyId: e.keyId,
        keyName: e.keyName,
        endpoint: e.endpoint,
        requestedModel: e.requestedModel,
        modelId: e.modelId,
        providerId: e.providerId,
        status: e.status,
        errorCode: e.errorCode,
        stream: e.stream ? 1 : 0,
        priority: e.priority,
        localOnly: e.localOnly ? 1 : 0,
        tag: e.tag,
        attempts: JSON.stringify(e.attempts),
        queueMs: e.queueMs,
        ttfbMs: e.ttfbMs,
        latencyMs: e.latencyMs,
        inputTokens: e.usage?.inputTokens ?? null,
        outputTokens: e.usage?.outputTokens ?? null,
        estimated: e.usage?.estimated ? 1 : 0,
      });
  }

  recentLog(opts: { limit: number; beforeId?: number; keyId?: string; errorsOnly?: boolean }): LogRow[] {
    const where: string[] = [];
    const params: Record<string, unknown> = { limit: opts.limit };
    if (opts.beforeId !== undefined) {
      where.push('id < @beforeId');
      params['beforeId'] = opts.beforeId;
    }
    if (opts.keyId) {
      where.push('key_id = @keyId');
      params['keyId'] = opts.keyId;
    }
    if (opts.errorsOnly) where.push('status >= 400');
    const rows = this.db
      .prepare(`SELECT * FROM request_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT @limit`)
      .all(params) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r['id'] as number,
      ts: r['ts'] as string,
      requestId: r['request_id'] as string,
      keyId: r['key_id'] as string | null,
      keyName: r['key_name'] as string | null,
      endpoint: r['endpoint'] as string,
      requestedModel: r['requested_model'] as string | null,
      modelId: r['model_id'] as string | null,
      providerId: r['provider_id'] as string | null,
      status: r['status'] as number,
      errorCode: r['error_code'] as string | null,
      stream: r['stream'] === 1,
      priority: r['priority'] as number | null,
      localOnly: r['local_only'] === 1,
      tag: r['tag'] as string | null,
      attempts: JSON.parse((r['attempts'] as string) || '[]') as Array<{ model: string; outcome: string }>,
      queueMs: r['queue_ms'] as number | null,
      ttfbMs: r['ttfb_ms'] as number | null,
      latencyMs: r['latency_ms'] as number | null,
      inputTokens: r['input_tokens'] as number | null,
      outputTokens: r['output_tokens'] as number | null,
      estimated: r['estimated'] === 1,
    }));
  }

  /** Deletes log lines older than `days` (0 keeps everything). Daily usage totals are tiny and kept. */
  pruneLog(days: number, now = new Date()): number {
    if (days <= 0) return 0;
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM request_log WHERE ts < ?').run(cutoff).changes;
  }
}
