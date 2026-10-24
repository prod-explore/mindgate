import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useApi } from '../api/context';
import { isApiError } from '../api/client';
import type { AgentStatus, NodeInfo, NodeModel, PullJob, PullStatus, ShutdownVerdict } from '../api/types';
import { useT, type Key } from '../i18n';
import { useAction } from '../lib/action';
import { describeCode } from '../lib/errors';
import { bytes, dash, duration, num, percent, relative } from '../lib/format';
import { fit, isActivePull, SHUTDOWN_REASONS, sortPulls, validPullName } from '../lib/nodes';
import { useQuery, type QueryResult } from '../lib/query';
import { href } from '../lib/router';
import { toast } from '../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/Confirm';
import { Badge, Empty, ErrorNote, Loading, LocalityBadge, Meter, ModelId, Note, PageHeader, Status, type BadgeTone } from '../ui/bits';
import { TextField } from '../ui/fields';
import { ModelsView } from './Models';

// ── one machine ───────────────────────────────────────────────────────────

/** One machine: what it has, what runs on it, and its models in the hub. Reached from the provider's page. */
export function NodeDetail({ id }: { id: string }) {
  const t = useT();
  const api = useApi();
  const providers = useQuery(s => api.providers.list(s), [], { every: 5000 });
  const info = useQuery(s => api.nodes.get(id, s), [id], { every: 5000 });
  const provider = providers.data?.find(p => p.id === id);
  const agent = info.data?.agent ?? null;
  const reachable = agent !== null;

  const models = useQuery(s => api.nodes.models(id, s), [id], { every: 20_000, enabled: reachable });
  const [fast, setFast] = useState(false);
  const pulls = useQuery(s => api.nodes.pulls(id, s), [id], { every: fast ? 1000 : 8000, enabled: reachable });

  // while something downloads, ask every second; and when a download finishes, the model list and the hardware change
  const primed = useRef(false);
  const finished = useRef(new Set<string>());
  useEffect(() => {
    const jobs = pulls.data;
    if (!jobs) return;
    setFast(jobs.some(isActivePull));
    let news = false;
    for (const j of jobs) {
      if (j.status === 'succeeded' && !finished.current.has(j.id)) {
        finished.current.add(j.id);
        news = true;
      }
    }
    if (news && primed.current) {
      void models.reload();
      void info.reload();
    }
    primed.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the job list changes; models and info are new objects on every render and only their reload is used
  }, [pulls.data]);

  const reloadAll = () => {
    void info.reload();
    void models.reload();
    void pulls.reload();
    void providers.reload();
  };

  const wake = useAction(async () => api.providers.wake(id), { ok: r => t('providers.woken', { status: r.status }) });
  const title = provider?.name ?? id;

  if (info.loading) return <Loading />;
  if (info.error && !info.data) {
    const missing = isApiError(info.error) && info.error.status === 404;
    return (
      <>
        <PageHeader title={title}>
          <a className="btn" href={href(['providers'])}>
            {t('provider.all')}
          </a>
        </PageHeader>
        {missing ? <Empty title={t('nodes.not_found')}>{t('nodes.not_found_hint')}</Empty> : <ErrorNote error={info.error} onRetry={() => void info.reload()} />}
      </>
    );
  }
  const data = info.data!;

  return (
    <>
      <PageHeader
        title={title}
        sub={
          <>
            <span className="mono">{id}</span> {provider ? <LocalityBadge locality={provider.locality} /> : null} <Status status={data.status} />
          </>
        }
      >
        <a className="btn" href={href(['providers'])}>
          {t('provider.all')}
        </a>
        <Button onClick={reloadAll} pending={info.refreshing && !!info.data}>
          {t('common.refresh')}
        </Button>
      </PageHeader>

      <Connection info={data} waking={wake.pending} onWake={() => void wake.run().then(reloadAll)} />

      {agent ? (
        <>
          <Hardware agent={agent} />
          <Loaded id={id} agent={agent} onChanged={reloadAll} />
          <Installed id={id} agent={agent} models={models} onChanged={reloadAll} />
          <Downloads id={id} pulls={pulls} onChanged={() => void pulls.reload()} />
          <Power id={id} agent={agent} onChanged={reloadAll} />
        </>
      ) : null}

      <section className="section" aria-labelledby="node-hub-models">
        <div className="section-head">
          <h2 id="node-hub-models">{t('provider.hub_models')}</h2>
          <p className="section-sub">{t('provider.hub_models_sub')}</p>
        </div>
        <ModelsView scope={id} />
      </section>
    </>
  );
}

function Connection({ info, waking, onWake }: { info: NodeInfo; waking: boolean; onWake: () => void }) {
  const t = useT();
  const asleep = info.status === 'asleep' || info.status === 'unknown';
  if (info.agent) return null;
  if (!info.agent_configured) {
    return (
      <Note tone="warn">
        <strong>{t('nodes.no_agent_title')}</strong> {t('err.no_agent')}
      </Note>
    );
  }
  return (
    <Note tone={info.agent_error && !asleep ? 'bad' : 'neutral'}>
      <strong>{asleep ? t('nodes.asleep_title') : info.status === 'waking' ? t('nodes.waking_title') : t('nodes.unreachable_title')}</strong>{' '}
      {asleep ? t('nodes.asleep_body') : info.agent_error ? describeCode(info.agent_error.code, info.agent_error.message) : t('nodes.waking_body')}
      {asleep ? (
        <div style={{ marginTop: 8 }}>
          <Button size="sm" variant="primary" pending={waking} onClick={onWake}>
            {t('providers.wake')}
          </Button>
        </div>
      ) : null}
    </Note>
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

function Hardware({ agent }: { agent: AgentStatus }) {
  const t = useT();
  const { memory, gpus, disk, cpu_count: cpus } = agent.system;
  const ramUsed = memory.total_bytes - memory.free_bytes;
  return (
    <section className="section" aria-labelledby="node-hw">
      <h2 id="node-hw">{t('nodes.hw')}</h2>
      <div className="resources">
        <Resource title={t('nodes.hw.ram')} detail={t('nodes.hw.of', { used: bytes(ramUsed), total: bytes(memory.total_bytes) })} value={ramUsed} max={memory.total_bytes} />
        {gpus.length === 0 ? (
          <div className="resource">
            <h3>{t('nodes.hw.gpu')}</h3>
            <p className="cell-sub">{t('nodes.hw.no_gpu')}</p>
          </div>
        ) : (
          gpus.map((g, i) => (
            <Resource
              key={`${g.name}-${i}`}
              title={`${t('nodes.hw.vram')} · ${g.name}`}
              detail={t('nodes.hw.of', { used: bytes(g.memory_used_bytes), total: bytes(g.memory_total_bytes) })}
              value={g.memory_used_bytes}
              max={g.memory_total_bytes}
              extra={g.utilization_percent !== null ? t('nodes.hw.gpu_load', { percent: percent(g.utilization_percent) }) : undefined}
            />
          ))
        )}
        {disk ? <Resource title={t('nodes.hw.disk')} detail={t('nodes.hw.disk_free', { free: bytes(disk.free_bytes), total: bytes(disk.total_bytes) })} value={disk.total_bytes - disk.free_bytes} max={disk.total_bytes} extra={disk.path} /> : null}
      </div>
      <dl className="facts">
        <Fact label={t('nodes.f.host')}>
          {agent.hostname} <span className="cell-sub">{agent.platform}</span>
        </Fact>
        <Fact label={t('nodes.f.cpu')}>{t('nodes.f.threads', { n: cpus })}</Fact>
        <Fact label={t('nodes.f.agent')}>{t('nodes.f.agent_value', { version: agent.version, uptime: duration(agent.uptime_seconds) })}</Fact>
        <Fact label={t('nodes.f.runtime')}>
          {agent.runtime.name} {agent.runtime.version ?? ''}{' '}
          {agent.runtime.ok ? <Badge tone="ok">{agent.runtime.managed ? t('nodes.f.runtime_managed') : t('nodes.f.runtime_adopted')}</Badge> : <Badge tone="bad">{agent.runtime.error ?? t('nodes.f.runtime_down')}</Badge>}
        </Fact>
        <Fact label={t('nodes.f.work')}>{t('nodes.f.work_value', { requests: agent.in_flight, downloads: agent.downloads })}</Fact>
        <Fact label={t('nodes.f.user')}>
          {agent.tray_configured ? (agent.user_active ? <Badge tone="warn">{t('nodes.f.user_active')}</Badge> : <Badge>{t('nodes.f.user_idle')}</Badge>) : <span className="cell-sub">{t('nodes.f.no_tray')}</span>}
        </Fact>
      </dl>
    </section>
  );
}

function Resource({ title, detail, value, max, extra }: { title: string; detail: string; value: number; max: number; extra?: string | undefined }) {
  return (
    <div className="resource">
      <h3>{title}</h3>
      <Meter value={value} max={max} label={`${title}: ${detail}`} />
      <p className="resource-detail">{detail}</p>
      {extra ? <p className="cell-sub">{extra}</p> : null}
    </div>
  );
}

function Loaded({ id, agent, onChanged }: { id: string; agent: AgentStatus; onChanged: () => void }) {
  const t = useT();
  const api = useApi();
  const unload = useAction(async (name: string) => api.nodes.unload(id, name), { ok: t('nodes.unloaded') });
  return (
    <section className="section" aria-labelledby="node-loaded">
      <h2 id="node-loaded">{t('nodes.loaded')}</h2>
      {agent.loaded.length === 0 ? (
        <p className="section-sub">{t('nodes.loaded_none')}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('nodes.col.model')}</th>
                <th className="num">{t('nodes.col.vram')}</th>
                <th className="num">{t('nodes.col.size')}</th>
                <th>{t('nodes.col.until')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agent.loaded.map(m => (
                <tr key={m.id}>
                  <td>
                    <span className="mono">{m.id}</span>
                  </td>
                  <td className="num">{bytes(m.vram_bytes)}</td>
                  <td className="num">{bytes(m.size_bytes)}</td>
                  <td>{m.expires_at ? relative(m.expires_at) : t('nodes.until_never')}</td>
                  <td className="actions">
                    <Button size="sm" pending={unload.pending} onClick={() => void unload.run(m.id).then(r => r !== undefined && onChanged())}>
                      {t('nodes.unload')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Installed({ id, agent, models, onChanged }: { id: string; agent: AgentStatus; models: QueryResult<NodeModel[]>; onChanged: () => void }) {
  const t = useT();
  const list = models.data ?? [];
  return (
    <section className="section" aria-labelledby="node-models">
      <div className="section-head">
        <h2 id="node-models">{t('nodes.models')}</h2>
      </div>
      {models.loading ? (
        <Loading />
      ) : models.error && !models.data ? (
        <ErrorNote error={models.error} onRetry={() => void models.reload()} />
      ) : list.length === 0 ? (
        <Empty title={t('nodes.models_none')}>{t('nodes.models_none_hint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('nodes.col.model')}</th>
                <th className="num">{t('nodes.col.size')}</th>
                <th>{t('nodes.col.abilities')}</th>
                <th>{t('nodes.col.in_hub')}</th>
                <th>{t('nodes.col.memory')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map(m => (
                <ModelRow key={m.id} id={id} model={m} agent={agent} onChanged={onChanged} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ModelRow({ id, model: m, agent, onChanged }: { id: string; model: NodeModel; agent: AgentStatus; onChanged: () => void }) {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();
  const load = useAction(async () => api.nodes.load(id, m.id), { ok: t('nodes.loaded_done', { name: m.id }) });
  const unload = useAction(async () => api.nodes.unload(id, m.id), { ok: t('nodes.unloaded') });
  const remove = useAction(async () => api.nodes.remove(id, m.id));

  const askDelete = async () => {
    const ok = await confirm({ title: t('nodes.delete_title', { name: m.id }), body: <p>{t('nodes.delete_body', { size: bytes(m.size_bytes) })}</p>, confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    const r = await remove.run();
    if (!r) return;
    toast.ok(t('nodes.deleted', { name: m.id }));
    onChanged();
  };

  const f = fit(m, agent.system.gpus);
  const fitText =
    f.kind === 'fits' ? t('nodes.fit.fits') : f.kind === 'spills' ? t('nodes.fit.spills', { vram: bytes(f.vram) }) : f.kind === 'no_gpu' ? t('nodes.fit.no_gpu') : null;
  const detail = [m.family, m.parameter_size, m.quantization].filter(Boolean).join(' · ');
  const abilities = [...m.capabilities.filter(c => c !== 'completion'), ...m.tags];

  return (
    <tr>
      <td>
        <div className="cell-main mono">{m.id}</div>
        <div className="cell-sub">{[m.kind !== 'chat' ? m.kind : null, detail, m.context_length ? t('nodes.ctx', { n: num(m.context_length) }) : null].filter(Boolean).join(' · ') || dash}</div>
      </td>
      <td className="num">
        {bytes(m.size_bytes)}
        {fitText ? <div className={`cell-sub fit-note${f.kind === 'spills' || f.kind === 'no_gpu' ? ' is-warn' : ''}`}>{fitText}</div> : null}
      </td>
      <td>
        <div className="chips">
          {abilities.length === 0 ? <span className="cell-sub">{dash}</span> : abilities.map(a => <span key={a} className={`chip${a === 'uncensored' ? ' chip-tag' : ''}`}>{a}</span>)}
        </div>
      </td>
      <td>
        {m.hub === null ? (
          <Badge tone="warn" title={t('nodes.hub.missing_hint')}>
            {t('nodes.hub.missing')}
          </Badge>
        ) : m.hub.enabled ? (
          <Badge tone="ok">{t('nodes.hub.on')}</Badge>
        ) : (
          <Badge>{t('nodes.hub.off')}</Badge>
        )}
        {m.hub ? <div className="cell-sub"><ModelId id={m.hub_id} /></div> : null}
      </td>
      <td>{m.loaded ? <Badge tone="local">{t('nodes.in_memory', { vram: bytes(m.loaded.vram_bytes) })}</Badge> : <span className="cell-sub">{dash}</span>}</td>
      <td className="actions">
        {m.loaded ? (
          <Button size="sm" pending={unload.pending} onClick={() => void unload.run().then(r => r !== undefined && onChanged())}>
            {t('nodes.unload')}
          </Button>
        ) : (
          <Button size="sm" pending={load.pending} onClick={() => void load.run().then(r => r !== undefined && onChanged())}>
            {t('nodes.load')}
          </Button>
        )}
        <Button size="sm" variant="danger" pending={remove.pending} disabled={!!m.loaded} title={m.loaded ? t('nodes.delete_loaded') : undefined} onClick={() => void askDelete()}>
          {t('common.delete')}
        </Button>
      </td>
    </tr>
  );
}

const PULL_STATUS: Record<PullStatus, { label: Key; tone: BadgeTone }> = {
  queued: { label: 'nodes.pull.queued', tone: 'neutral' },
  running: { label: 'nodes.pull.running', tone: 'neutral' },
  succeeded: { label: 'nodes.pull.succeeded', tone: 'ok' },
  failed: { label: 'nodes.pull.failed', tone: 'bad' },
  cancelled: { label: 'nodes.pull.cancelled', tone: 'warn' },
};

function Downloads({ id, pulls, onChanged }: { id: string; pulls: QueryResult<PullJob[]>; onChanged: () => void }) {
  const t = useT();
  const api = useApi();
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const start = useAction(async (n: string) => api.nodes.pull(id, n.trim()), { inline: true });
  const valid = validPullName(name);

  const submit = async () => {
    setTouched(true);
    if (!valid) return;
    const job = await start.run(name);
    if (job) {
      setName('');
      setTouched(false);
      onChanged();
    }
  };

  const jobs = sortPulls(pulls.data ?? []);
  const busy = jobs.some(isActivePull);

  return (
    <section className="section" aria-labelledby="node-pull">
      <h2 id="node-pull">{t('nodes.pull')}</h2>
      <form
        className="pull-form"
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextField
          className="field-grow"
          label={t('nodes.pull_name')}
          value={name}
          onChange={e => {
            setName(e.target.value);
            start.clearError();
          }}
          placeholder="qwen3:4b"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          hint={t('nodes.pull_hint')}
          error={touched && !valid ? t('nodes.pull_invalid') : start.error}
        />
        <Button type="submit" variant="primary" pending={start.pending}>
          {t('nodes.pull_start')}
        </Button>
      </form>
      {busy ? <p className="section-sub">{t('nodes.pull_one_at_a_time')}</p> : null}

      {jobs.length > 0 ? (
        <ul className="pulls" aria-label={t('nodes.pull_list')}>
          {jobs.map(j => (
            <PullItem key={j.id} id={id} job={j} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function PullItem({ id, job: j, onChanged }: { id: string; job: PullJob; onChanged: () => void }) {
  const t = useT();
  const api = useApi();
  const active = isActivePull(j);
  const stop = useAction(async () => api.nodes.cancelPull(id, j.id));
  const s = PULL_STATUS[j.status];
  return (
    <li className="pull">
      <div className="pull-head">
        <span className="mono pull-name">{j.name}</span>
        <Badge tone={s.tone}>{t(s.label)}</Badge>
        <Button size="sm" variant={active ? 'default' : 'ghost'} pending={stop.pending} onClick={() => void stop.run().then(r => r !== undefined && onChanged())}>
          {active ? t('common.cancel') : t('nodes.pull_clear')}
        </Button>
      </div>
      {active && j.percent !== null ? <Meter value={j.percent} max={100} tone="neutral" label={t('nodes.pull_progress', { name: j.name })} /> : null}
      <p className="cell-sub">
        {[j.phase && j.status !== 'succeeded' ? j.phase : null, j.total ? `${bytes(j.completed ?? 0)} / ${bytes(j.total)}` : null, active && j.percent !== null ? percent(j.percent) : null].filter(Boolean).join(' · ')}
      </p>
      {j.error ? <p className="field-error">{j.error}</p> : null}
    </li>
  );
}

function Power({ id, agent, onChanged }: { id: string; agent: AgentStatus; onChanged: () => void }) {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();
  const [verdict, setVerdict] = useState<ShutdownVerdict | null>(null);
  const shutdown = useAction(async (force: boolean) => api.nodes.shutdown(id, force));

  const run = async (force: boolean) => {
    if (force) {
      const ok = await confirm({ title: t('nodes.force_title'), body: <p>{t('nodes.force_body')}</p>, confirmLabel: t('nodes.force'), danger: true });
      if (!ok) return;
    }
    const v = await shutdown.run(force);
    if (!v) return;
    setVerdict(v);
    if (v.allow) {
      toast.ok(t('nodes.shutdown_ok'));
      onChanged();
    }
  };

  const reasonText = (code: string) => {
    const key = SHUTDOWN_REASONS[code];
    return key ? t(key) : code;
  };

  const blockers: string[] = [];
  if (agent.in_flight > 0) blockers.push(t('nodes.reason.requests_in_flight'));
  if (agent.downloads > 0) blockers.push(t('nodes.reason.download_in_progress'));
  if (agent.user_active) blockers.push(t('nodes.reason.user_active'));

  return (
    <section className="section" aria-labelledby="node-power">
      <h2 id="node-power">{t('nodes.power')}</h2>
      <p className="section-sub">{agent.shutting_down ? t('nodes.power_going_down') : agent.safe_to_shutdown ? t('nodes.power_safe') : t('nodes.power_blocked', { why: blockers.join(', ') || dash })}</p>
      <div className="row-actions">
        <Button pending={shutdown.pending} disabled={agent.shutting_down} onClick={() => void run(false)}>
          {t('nodes.shutdown')}
        </Button>
        <Button variant="danger" pending={shutdown.pending} disabled={agent.shutting_down} onClick={() => void run(true)}>
          {t('nodes.force')}
        </Button>
      </div>
      {verdict && !verdict.allow ? (
        <Note tone="warn">
          <strong>{t('nodes.shutdown_refused')}</strong> {reasonText(verdict.reason)}
        </Note>
      ) : null}
      {verdict?.allow ? <Note tone="ok">{reasonText(verdict.reason)}</Note> : null}
    </section>
  );
}
