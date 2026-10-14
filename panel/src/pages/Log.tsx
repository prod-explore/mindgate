import { useEffect, useState, type ReactNode } from 'react';
import { useApi } from '../api/context';
import type { LogRow } from '../api/types';
import { useT } from '../i18n';
import { describeError } from '../lib/errors';
import { dash, dateTime, ms, num, relative } from '../lib/format';
import { mergeLog, statusTone } from '../lib/log';
import { useQuery } from '../lib/query';
import { replaceQuery, useRoute } from '../lib/router';
import { Button } from '../ui/Button';
import { Badge, Empty, ErrorNote, Loading, ModelId, PageHeader } from '../ui/bits';
import { SelectField, SwitchField } from '../ui/fields';

const PAGE = 100;

export function Log() {
  const t = useT();
  const api = useApi();
  const route = useRoute();
  const errorsOnly = route.query.get('errors') === '1';
  const key = route.query.get('key') ?? '';
  const setFilter = (patch: { errors?: boolean; key?: string }) =>
    replaceQuery(['log'], {
      errors: (patch.errors ?? errorsOnly) ? '1' : undefined,
      key: (patch.key ?? key) || undefined,
    });

  const [auto, setAuto] = useState(true);
  const keys = useQuery(s => api.keys.list(s), []);
  // The newest page refreshes by itself; older pages are fetched on request. Everything seen stays in one list, newest
  // first, so requests that slip out of the newest page while someone is reading further down are not lost.
  const filterKey = `${errorsOnly}|${key}`;
  const head = useQuery(s => api.log({ limit: PAGE, errors: errorsOnly, key: key || undefined }, s).then(rows => ({ filterKey, rows })), [filterKey], { every: auto ? 5000 : undefined });
  const [seen, setSeen] = useState<{ filterKey: string; rows: LogRow[]; exhausted: boolean }>({ filterKey, rows: [], exhausted: false });
  const [more, setMore] = useState<{ loading: boolean; error: string | null }>({ loading: false, error: null });
  const [open, setOpen] = useState<number | null>(null);

  const fresh = head.data && head.data.filterKey === filterKey ? head.data.rows : null;
  useEffect(() => {
    if (fresh) setSeen(prev => ({ filterKey, rows: mergeLog(prev.filterKey === filterKey ? prev.rows : [], fresh), exhausted: prev.filterKey === filterKey && prev.exhausted }));
  }, [fresh, filterKey]);
  // a new filter starts the list over
  useEffect(() => {
    setMore({ loading: false, error: null });
    setOpen(null);
  }, [filterKey]);

  const rows = seen.filterKey === filterKey ? seen.rows : [];
  const last = rows[rows.length - 1];

  const loadOlder = async () => {
    if (!last || more.loading) return;
    setMore({ loading: true, error: null });
    try {
      const page = await api.log({ limit: PAGE, before: last.id, errors: errorsOnly, key: key || undefined });
      setSeen(prev => (prev.filterKey === filterKey ? { filterKey, rows: mergeLog(prev.rows, page), exhausted: page.length < PAGE } : prev));
      setMore({ loading: false, error: null });
    } catch (e) {
      setMore({ loading: false, error: describeError(e) });
    }
  };

  const canMore = !(seen.filterKey === filterKey && seen.exhausted) && rows.length >= PAGE;

  return (
    <>
      <PageHeader title={t('nav.log')} sub={t('log.sub')}>
        <Button onClick={() => void head.reload()} pending={head.refreshing && !!head.data}>
          {t('common.refresh')}
        </Button>
      </PageHeader>

      <div className="filters">
        <SelectField label={t('log.f.key')} value={key} onChange={e => setFilter({ key: e.target.value })}>
          <option value="">{t('common.all')}</option>
          {(keys.data ?? []).map(k => (
            <option key={k.id} value={k.id}>
              {k.name}
            </option>
          ))}
        </SelectField>
        <SwitchField label={t('log.f.errors')} checked={errorsOnly} onChange={v => setFilter({ errors: v })} />
        <SwitchField label={t('log.f.auto')} checked={auto} onChange={setAuto} />
      </div>

      {head.loading && !fresh ? (
        <Loading />
      ) : head.error && !fresh && rows.length === 0 ? (
        <ErrorNote error={head.error} onRetry={() => void head.reload()} />
      ) : rows.length === 0 ? (
        <Empty title={errorsOnly ? t('log.empty_errors') : t('log.empty')}>{errorsOnly ? null : t('log.empty_hint')}</Empty>
      ) : (
        <>
          {head.error ? <ErrorNote error={head.error} onRetry={() => void head.reload()} /> : null}
          <div className="table-wrap">
            <table className="table table-log">
              <thead>
                <tr>
                  <th>{t('log.col.when')}</th>
                  <th>{t('log.col.key')}</th>
                  <th>{t('log.col.model')}</th>
                  <th>{t('log.col.result')}</th>
                  <th className="num">{t('log.col.tokens')}</th>
                  <th className="num">{t('log.col.time')}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <LogLine key={r.id} row={r} open={open === r.id} onToggle={() => setOpen(open === r.id ? null : r.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="more">
            {more.error ? (
              <p className="field-error" role="alert">
                {more.error}
              </p>
            ) : null}
            {canMore ? (
              <Button onClick={() => void loadOlder()} pending={more.loading}>
                {t('log.older')}
              </Button>
            ) : (
              <p className="section-sub">{t('log.end', { n: rows.length })}</p>
            )}
          </div>
        </>
      )}
    </>
  );
}

function LogLine({ row: r, open, onToggle }: { row: LogRow; open: boolean; onToggle: () => void }) {
  const t = useT();
  const tokens = r.input_tokens === null && r.output_tokens === null ? null : (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
  const rerouted = r.requested_model && r.model && r.requested_model !== r.model;
  const detailId = `log-${r.id}`;
  return (
    <>
      <tr className={open ? 'is-open' : undefined}>
        <td title={r.ts}>{relative(r.ts)}</td>
        <td>{r.key ?? dash}</td>
        <td>
          {r.model ? <ModelId id={r.model} /> : r.requested_model ? <span className="mono">{r.requested_model}</span> : <span className="cell-sub">{r.endpoint}</span>}
          {rerouted ? <div className="cell-sub">{t('log.via', { name: r.requested_model ?? '' })}</div> : null}
        </td>
        <td>
          <Badge tone={statusTone(r.status)}>{r.status}</Badge> {r.error_code ? <span className="mono">{r.error_code}</span> : null}
          {r.attempts > 1 ? <span className="cell-sub"> {t('log.attempts', { n: r.attempts })}</span> : null}
        </td>
        <td className="num">
          {num(tokens)}
          {r.estimated && tokens !== null ? <span className="cell-sub" title={t('log.estimated_hint')}> ~</span> : null}
        </td>
        <td className="num">{ms(r.latency_ms)}</td>
        <td className="actions">
          <Button size="sm" variant="ghost" aria-expanded={open} aria-controls={detailId} onClick={onToggle}>
            {open ? t('log.hide') : t('log.details')}
          </Button>
        </td>
      </tr>
      {open ? (
        <tr id={detailId} className="row-detail">
          <td colSpan={7}>
            <dl className="facts">
              <Fact label={t('log.d.time')}>{dateTime(r.ts)}</Fact>
              <Fact label={t('log.d.request_id')}>
                <span className="mono">{r.request_id}</span>
              </Fact>
              <Fact label={t('log.d.endpoint')}>
                <span className="mono">{r.endpoint}</span>
                {r.stream ? <> · {t('log.d.stream')}</> : null}
              </Fact>
              <Fact label={t('log.d.asked')}>{r.requested_model ? <span className="mono">{r.requested_model}</span> : dash}</Fact>
              <Fact label={t('log.d.answered')}>{r.model ? <ModelId id={r.model} /> : dash}</Fact>
              <Fact label={t('log.d.provider')}>{r.provider ?? dash}</Fact>
              <Fact label={t('log.d.priority')}>
                {r.priority}
                {r.local_only ? <> · {t('log.d.local_only')}</> : null}
                {r.tag ? <> · {t('log.d.tag', { tag: r.tag })}</> : null}
              </Fact>
              <Fact label={t('log.d.attempts')}>{r.attempts}</Fact>
              <Fact label={t('log.d.queue')}>{ms(r.queue_ms)}</Fact>
              <Fact label={t('log.d.ttfb')}>{ms(r.ttfb_ms)}</Fact>
              <Fact label={t('log.d.latency')}>{ms(r.latency_ms)}</Fact>
              <Fact label={t('log.d.tokens')}>
                {r.input_tokens === null && r.output_tokens === null
                  ? dash
                  : t('log.d.tokens_value', { input: num(r.input_tokens), output: num(r.output_tokens) }) + (r.estimated ? ` (${t('log.d.estimated')})` : '')}
              </Fact>
            </dl>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
