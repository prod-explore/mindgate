import { useApi } from '../api/context';
import { useT } from '../i18n';
import { compact, dash, ms, num, percent, relative } from '../lib/format';
import { hubTimeZone, useHub } from '../lib/hub';
import { statusTone } from '../lib/log';
import { useQuery } from '../lib/query';
import { href } from '../lib/router';
import { byDay, dayInZone, daysBetween, localityResolver, totals } from '../lib/usage';
import { Button } from '../ui/Button';
import { Badge, Empty, ErrorNote, Loading, LocalityBadge, ModelId, PageHeader, Status } from '../ui/bits';
import { DailyColumns, Figure } from '../ui/charts';

const DAYS = 14;

export function Overview() {
  const t = useT();
  const api = useApi();
  const hub = useHub();
  const zone = hubTimeZone(hub);

  const providers = useQuery(s => api.providers.list(s), [], { every: 5000 });
  const today = dayInZone(new Date(), zone);
  const from = dayInZone(new Date(), zone, DAYS - 1);
  const usage = useQuery(s => api.usage({ from, to: today }, s), [from, today], { every: 60_000 });
  const errors = useQuery(s => api.log({ limit: 6, errors: true }, s), [], { every: 15_000 });

  if (providers.loading) return <Loading />;
  if (providers.error && !providers.data) return <ErrorNote error={providers.error} onRetry={() => void providers.reload()} />;
  const list = providers.data ?? [];

  const localityOf = localityResolver(list);
  const rows = usage.data?.data ?? [];
  const todayRows = rows.filter(r => r.day === today);
  const tt = totals(todayRows);
  const tokensToday = tt.inputTokens + tt.outputTokens;
  const localTokens = todayRows.filter(r => localityOf(r.model) === 'local').reduce((a, r) => a + r.input_tokens + r.output_tokens, 0);
  const days = daysBetween(from, today);
  const points = byDay(rows, days, 'requests', localityOf);

  return (
    <>
      <PageHeader title={t('nav.overview')} />

      {list.length === 0 ? (
        <Empty title={t('overview.no_providers')}>
          <p>{t('overview.no_providers_hint')}</p>
          <p style={{ marginTop: 12 }}>
            <a href={href(['providers'], { add: '1' })}>
              <Button variant="primary">{t('providers.add')}</Button>
            </a>
          </p>
        </Empty>
      ) : (
        <section aria-labelledby="ov-providers">
          <div className="section-head">
            <h2 id="ov-providers">{t('nav.providers')}</h2>
            <a href={href(['providers'])}>{t('overview.manage')}</a>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('overview.col.provider')}</th>
                  <th>{t('overview.col.runs')}</th>
                  <th>{t('overview.col.state')}</th>
                  <th className="num">{t('overview.col.queue')}</th>
                  <th className="num">{t('overview.col.models')}</th>
                  <th>{t('overview.col.problem')}</th>
                </tr>
              </thead>
              <tbody>
                {list.map(p => {
                  const problem = p.last_error ?? p.last_sync_error ?? (p.api_key_unreadable ? t('providers.key_unreadable') : null);
                  return (
                    <tr key={p.id} className={p.enabled ? undefined : 'is-off'}>
                      <td>
                        <a className="cell-main" href={p.node ? href(['nodes', p.id]) : href(['providers'])}>
                          {p.name}
                        </a>
                        <div className="cell-sub mono">{p.id}</div>
                      </td>
                      <td>
                        <LocalityBadge locality={p.locality} /> {p.node ? <Badge>{t('providers.kind.node')}</Badge> : null}
                      </td>
                      <td>
                        <Status status={p.status} />
                      </td>
                      <td className="num">{p.max_concurrency === null && p.queue.running + p.queue.queued === 0 ? dash : `${p.queue.running} / ${p.queue.queued}`}</td>
                      <td className="num">
                        {p.models_enabled} / {p.model_count}
                      </td>
                      <td className="cell-problem">{problem ?? dash}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="section-sub" style={{ marginTop: 6 }}>
            {t('overview.queue_hint')}
          </p>
        </section>
      )}

      <section className="section" aria-labelledby="ov-today">
        <div className="section-head">
          <h2 id="ov-today">{t('overview.today')}</h2>
          <a href={href(['usage'])}>{t('overview.details')}</a>
        </div>
        {usage.error && !usage.data ? (
          <ErrorNote error={usage.error} onRetry={() => void usage.reload()} />
        ) : (
          <>
            <dl className="figures">
              <Figure label={t('overview.requests')} value={num(tt.requests)} />
              <Figure label={t('overview.tokens')} value={compact(tokensToday)} sub={t('overview.tokens_split', { input: compact(tt.inputTokens), output: compact(tt.outputTokens) })} />
              <Figure label={t('overview.errors')} value={num(tt.errors)} sub={tt.requests ? percent((tt.errors / tt.requests) * 100, 1) : undefined} />
              <Figure label={t('overview.local_share')} value={tokensToday ? percent((localTokens / tokensToday) * 100) : dash} sub={t('overview.local_share_hint')} />
            </dl>
            <div style={{ marginTop: 18 }}>
              <h3 className="chart-title">{t('overview.chart_title', { days: DAYS })}</h3>
              <DailyColumns
                points={points}
                title={t('overview.chart_title', { days: DAYS })}
                series={[
                  { key: 'local', label: t('locality.local'), color: 'var(--series-local)' },
                  { key: 'cloud', label: t('locality.cloud'), color: 'var(--series-cloud)' },
                ]}
                stale={usage.refreshing && !!usage.data}
              />
            </div>
          </>
        )}
      </section>

      <section className="section" aria-labelledby="ov-errors">
        <div className="section-head">
          <h2 id="ov-errors">{t('overview.recent_errors')}</h2>
          <a href={href(['log'], { errors: '1' })}>{t('overview.open_log')}</a>
        </div>
        {errors.error && !errors.data ? (
          <ErrorNote error={errors.error} onRetry={() => void errors.reload()} />
        ) : !errors.data ? (
          <Loading />
        ) : errors.data.length === 0 ? (
          <Empty title={t('overview.no_errors')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('log.col.when')}</th>
                  <th>{t('log.col.key')}</th>
                  <th>{t('log.col.model')}</th>
                  <th>{t('log.col.result')}</th>
                  <th className="num">{t('log.col.time')}</th>
                </tr>
              </thead>
              <tbody>
                {errors.data.map(r => (
                  <tr key={r.id}>
                    <td title={r.ts}>{relative(r.ts)}</td>
                    <td>{r.key ?? dash}</td>
                    <td>{r.model ? <ModelId id={r.model} /> : r.requested_model ? <span className="mono">{r.requested_model}</span> : dash}</td>
                    <td>
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge> <span className="mono">{r.error_code ?? ''}</span>
                    </td>
                    <td className="num">{ms(r.latency_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
