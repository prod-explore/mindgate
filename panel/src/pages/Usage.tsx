import { useMemo } from 'react';
import { useApi } from '../api/context';
import type { UsageRow } from '../api/types';
import { useT, type Key } from '../i18n';
import { compact, dash, num, percent } from '../lib/format';
import { hubTimeZone, useHub } from '../lib/hub';
import { useQuery } from '../lib/query';
import { replaceQuery, useRoute } from '../lib/router';
import { byDay, dayInZone, daysBetween, groupBy, localityResolver, totals, type Metric } from '../lib/usage';
import { cx } from '../lib/cx';
import { Empty, ErrorNote, Loading, LocalityBadge, Meter, ModelId, PageHeader } from '../ui/bits';
import { DailyColumns, Figure } from '../ui/charts';
import { SelectField } from '../ui/fields';

const RANGES = [7, 30, 90] as const;
const METRICS: Array<{ id: Metric; label: Key }> = [
  { id: 'requests', label: 'usage.metric.requests' },
  { id: 'tokens', label: 'usage.metric.tokens' },
  { id: 'errors', label: 'usage.metric.errors' },
];

function parseQuery(q: URLSearchParams) {
  const days = Number(q.get('days'));
  const metric = q.get('metric');
  return {
    days: (RANGES as readonly number[]).includes(days) ? days : 30,
    metric: (metric === 'tokens' || metric === 'errors' ? metric : 'requests') as Metric,
    key: q.get('key') ?? '',
    model: q.get('model') ?? '',
  };
}

export function Usage() {
  const t = useT();
  const api = useApi();
  const hub = useHub();
  const route = useRoute();
  const zone = hubTimeZone(hub);
  const f = parseQuery(route.query);
  const set = (patch: Partial<typeof f>) => {
    const next = { ...f, ...patch };
    replaceQuery(['usage'], {
      days: next.days === 30 ? undefined : String(next.days),
      metric: next.metric === 'requests' ? undefined : next.metric,
      key: next.key || undefined,
      model: next.model || undefined,
    });
  };

  const today = dayInZone(new Date(), zone);
  const from = dayInZone(new Date(), zone, f.days - 1);
  // The whole range is fetched once; the key and model filters work on it in the browser, so a filter never reloads the chart.
  const usage = useQuery(s => api.usage({ from, to: today }, s), [from, today], { every: 60_000 });
  const keys = useQuery(s => api.keys.list(s), []);
  const providers = useQuery(s => api.providers.list(s), []);

  const all = usage.data?.data ?? [];
  const keyName = useMemo(() => new Map((keys.data ?? []).map(k => [k.id, k.name])), [keys.data]);
  const nameOf = (id: string) => keyName.get(id) ?? t('usage.deleted_key');
  const localityOf = useMemo(() => localityResolver(providers.data ?? []), [providers.data]);

  const keyOptions = useMemo(() => [...new Set(all.map(r => r.key_id))].sort((a, b) => nameOf(a).localeCompare(nameOf(b))), [all, keyName]); // eslint-disable-line react-hooks/exhaustive-deps
  const modelOptions = useMemo(() => [...new Set(all.map(r => r.model))].sort(), [all]);

  const rows = useMemo(() => all.filter((r: UsageRow) => (!f.key || r.key_id === f.key) && (!f.model || r.model === f.model)), [all, f.key, f.model]);
  const tt = totals(rows);
  const tokens = tt.inputTokens + tt.outputTokens;
  const localTokens = rows.filter(r => localityOf(r.model) === 'local').reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
  const days = daysBetween(from, today);
  const points = byDay(rows, days, f.metric, localityOf);

  const byModel = groupBy(rows, r => r.model);
  const byKey = groupBy(rows, r => r.key_id);
  const maxModel = Math.max(1, ...byModel.map(m => m.inputTokens + m.outputTokens));
  const maxKey = Math.max(1, ...byKey.map(m => m.inputTokens + m.outputTokens));

  const metricLabel = t(METRICS.find(m => m.id === f.metric)!.label);
  const title = t('usage.chart_title', { metric: metricLabel, days: f.days });

  return (
    <>
      <PageHeader title={t('nav.usage')} sub={t('usage.sub', { zone })} />

      <div className="filters">
        <div className="field">
          <span className="field-label" id="usage-range">
            {t('usage.f.range')}
          </span>
          <div className="segmented" role="group" aria-labelledby="usage-range">
            {RANGES.map(d => (
              <button key={d} type="button" className={cx('segment', f.days === d && 'is-on')} aria-pressed={f.days === d} onClick={() => set({ days: d })}>
                {t('usage.days', { n: d })}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span className="field-label" id="usage-metric">
            {t('usage.f.metric')}
          </span>
          <div className="segmented" role="group" aria-labelledby="usage-metric">
            {METRICS.map(m => (
              <button key={m.id} type="button" className={cx('segment', f.metric === m.id && 'is-on')} aria-pressed={f.metric === m.id} onClick={() => set({ metric: m.id })}>
                {t(m.label)}
              </button>
            ))}
          </div>
        </div>
        <SelectField label={t('usage.f.key')} value={f.key} onChange={e => set({ key: e.target.value })}>
          <option value="">{t('common.all')}</option>
          {keyOptions.map(id => (
            <option key={id} value={id}>
              {nameOf(id)}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('usage.f.model')} value={f.model} onChange={e => set({ model: e.target.value })}>
          <option value="">{t('common.all')}</option>
          {modelOptions.map(id => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </SelectField>
      </div>

      {usage.loading ? (
        <Loading />
      ) : usage.error && !usage.data ? (
        <ErrorNote error={usage.error} onRetry={() => void usage.reload()} />
      ) : (
        <>
          <dl className="figures">
            <Figure label={t('overview.requests')} value={num(tt.requests)} />
            <Figure label={t('overview.tokens')} value={compact(tokens)} sub={t('overview.tokens_split', { input: compact(tt.inputTokens), output: compact(tt.outputTokens) })} />
            <Figure label={t('overview.errors')} value={num(tt.errors)} sub={tt.requests ? percent((tt.errors / tt.requests) * 100, 1) : undefined} />
            <Figure label={t('overview.local_share')} value={tokens ? percent((localTokens / tokens) * 100) : dash} sub={t('usage.local_share_hint')} />
          </dl>

          <section className="section" aria-labelledby="usage-chart">
            <h2 id="usage-chart" className="chart-title">
              {title}
            </h2>
            <DailyColumns
              points={points}
              title={title}
              series={[
                { key: 'local', label: t('locality.local'), color: 'var(--series-local)' },
                { key: 'cloud', label: t('locality.cloud'), color: 'var(--series-cloud)' },
              ]}
              stale={usage.refreshing && !!usage.data}
            />
          </section>

          {rows.length === 0 ? (
            <Empty title={t('usage.empty')}>{t('usage.empty_hint')}</Empty>
          ) : (
            <>
              <section className="section" aria-labelledby="usage-models">
                <h2 id="usage-models">{t('usage.by_model')}</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('usage.col.model')}</th>
                        <th>{t('usage.col.runs')}</th>
                        <th className="num">{t('usage.col.requests')}</th>
                        <th className="num">{t('usage.col.input')}</th>
                        <th className="num">{t('usage.col.output')}</th>
                        <th className="num">{t('usage.col.errors')}</th>
                        <th>{t('usage.col.share')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byModel.map(m => {
                        const loc = localityOf(m.id);
                        return (
                          <tr key={m.id}>
                            <td>
                              <ModelId id={m.id} />
                            </td>
                            <td>
                              <LocalityBadge locality={loc} />
                            </td>
                            <td className="num">{num(m.requests)}</td>
                            <td className="num">{compact(m.inputTokens)}</td>
                            <td className="num">{compact(m.outputTokens)}</td>
                            <td className="num">{m.errors ? num(m.errors) : dash}</td>
                            <td className="meter-cell">
                              <Meter value={m.inputTokens + m.outputTokens} max={maxModel} label={t('usage.share_label', { name: m.id })} tone={loc} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="section" aria-labelledby="usage-keys">
                <h2 id="usage-keys">{t('usage.by_key')}</h2>
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('usage.col.key')}</th>
                        <th className="num">{t('usage.col.requests')}</th>
                        <th className="num">{t('usage.col.input')}</th>
                        <th className="num">{t('usage.col.output')}</th>
                        <th className="num">{t('usage.col.errors')}</th>
                        <th>{t('usage.col.share')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byKey.map(k => (
                        <tr key={k.id}>
                          <td>{nameOf(k.id)}</td>
                          <td className="num">{num(k.requests)}</td>
                          <td className="num">{compact(k.inputTokens)}</td>
                          <td className="num">{compact(k.outputTokens)}</td>
                          <td className="num">{k.errors ? num(k.errors) : dash}</td>
                          <td className="meter-cell">
                            <Meter value={k.inputTokens + k.outputTokens} max={maxKey} label={t('usage.share_label', { name: nameOf(k.id) })} tone="neutral" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
