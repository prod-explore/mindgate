import { useEffect, useState } from 'react';
import { useApi } from '../api/context';
import type { Preset, Provider } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { dash, ms, relative } from '../lib/format';
import { blankDraft, draftFromPreset, draftFromProvider, type ProviderDraft } from '../lib/provider-form';
import { useQuery } from '../lib/query';
import { href, replaceQuery, useRoute } from '../lib/router';
import { toast } from '../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/Confirm';
import { Dialog } from '../ui/Dialog';
import { Badge, Empty, ErrorNote, Loading, LocalityBadge, PageHeader, Status } from '../ui/bits';
import { RowSwitch } from '../ui/fields';
import { ProviderForm } from './ProviderForm';

type Editing = { mode: 'create'; draft: ProviderDraft } | { mode: 'edit'; draft: ProviderDraft; provider: Provider } | null;

export function Providers() {
  const t = useT();
  const api = useApi();
  const route = useRoute();
  const list = useQuery(s => api.providers.list(s), [], { every: 5000 });
  const presets = useQuery(s => api.presets(s), []);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState<Editing>(null);

  // `#/providers?add=1` (from the overview) opens the picker straight away
  const wantsAdd = route.query.get('add') === '1';
  useEffect(() => {
    if (wantsAdd) {
      setPicking(true);
      replaceQuery(['providers'], {});
    }
  }, [wantsAdd]);

  const pick = (preset: Preset | null) => {
    setPicking(false);
    setEditing({ mode: 'create', draft: preset ? draftFromPreset(preset) : blankDraft() });
  };

  return (
    <>
      <PageHeader title={t('nav.providers')} sub={t('providers.sub')}>
        <Button variant="primary" onClick={() => setPicking(true)}>
          {t('providers.add')}
        </Button>
      </PageHeader>

      {list.loading ? (
        <Loading />
      ) : list.error && !list.data ? (
        <ErrorNote error={list.error} onRetry={() => void list.reload()} />
      ) : list.data && list.data.length === 0 ? (
        <Empty title={t('providers.empty')}>{t('providers.empty_hint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('providers.col.provider')}</th>
                <th>{t('providers.col.runs')}</th>
                <th>{t('providers.col.state')}</th>
                <th>{t('providers.col.key')}</th>
                <th className="num">{t('providers.col.slots')}</th>
                <th className="num">{t('providers.col.models')}</th>
                <th>{t('providers.col.on')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.data?.map(p => (
                <ProviderRow key={p.id} provider={p} onChanged={() => void list.reload()} onEdit={() => setEditing({ mode: 'edit', draft: draftFromProvider(p), provider: p })} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {picking ? (
        <Dialog title={t('providers.pick_title')} onClose={() => setPicking(false)}>
          <p className="field-hint">{t('providers.pick_hint')}</p>
          <ul className="presets">
            {(presets.data ?? []).map(p => (
              <li key={p.id}>
                <button type="button" className="preset" onClick={() => pick(p)}>
                  <span className="preset-name">
                    {p.name} <LocalityBadge locality={p.locality} />
                  </span>
                  {p.note ? <span className="preset-note">{p.note}</span> : null}
                </button>
              </li>
            ))}
            <li>
              <button type="button" className="preset" onClick={() => pick(null)}>
                <span className="preset-name">{t('providers.pick_blank')}</span>
                <span className="preset-note">{t('providers.pick_blank_hint')}</span>
              </button>
            </li>
          </ul>
          {presets.error && !presets.data ? <ErrorNote error={presets.error} /> : null}
        </Dialog>
      ) : null}

      {editing ? (
        <ProviderForm
          mode={editing.mode}
          initial={editing.draft}
          {...(editing.mode === 'edit' ? { provider: editing.provider } : {})}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function ProviderRow({ provider: p, onChanged, onEdit }: { provider: Provider; onChanged: () => void; onEdit: () => void }) {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();

  const test = useAction(async () => api.providers.test(p.id));
  const sync = useAction(async () => api.providers.sync(p.id), {
    ok: r => t('providers.synced', { added: r.added, updated: r.updated, absent: r.absent }),
  });
  const wake = useAction(async () => api.providers.wake(p.id), { ok: r => t('providers.woken', { status: r.status }) });
  const toggle = useAction(async (enabled: boolean) => api.providers.update(p.id, { enabled }));
  const remove = useAction(async () => api.providers.remove(p.id));

  const runTest = async () => {
    const r = await test.run();
    if (!r) return;
    if (r.ok) toast.ok(t('providers.test_ok', { ms: ms(r.latency_ms), models: r.models ?? 0 }));
    else toast.error(t('providers.test_failed', { error: r.error ?? r.code ?? '' }));
  };

  const askDelete = async () => {
    const ok = await confirm({
      title: t('providers.delete_title', { name: p.name }),
      body: <p>{t('providers.delete_body', { count: p.model_count })}</p>,
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    const r = await remove.run();
    if (r) {
      toast.ok(r.aliases_affected.length ? t('providers.deleted_aliases', { aliases: r.aliases_affected.join(', ') }) : t('providers.deleted'));
      onChanged();
    }
  };

  const problem = p.last_error ?? p.last_sync_error;
  const keyText = !p.has_api_key ? (p.auth_scheme === 'none' ? t('providers.no_auth') : t('providers.no_key')) : p.api_key_unreadable ? t('providers.key_unreadable') : `…${p.api_key_hint ?? ''}`;

  return (
    <tr className={p.enabled ? undefined : 'is-off'}>
      <td>
        <div className="cell-main">{p.name}</div>
        <div className="cell-sub mono">{p.id}</div>
        <div className="cell-sub mono url">{p.base_url}</div>
      </td>
      <td>
        <div className="chips">
          <LocalityBadge locality={p.locality} />
          {p.node ? <Badge>{t('providers.kind.node')}</Badge> : <Badge>{p.type}</Badge>}
        </div>
      </td>
      <td>
        <Status status={p.status} />
        {problem ? (
          <div className="cell-sub problem" title={problem}>
            {problem}
          </div>
        ) : null}
      </td>
      <td className="nowrap">
        {p.api_key_unreadable ? <Badge tone="bad">{keyText}</Badge> : <span className="mono">{keyText}</span>}
      </td>
      <td className="num">{p.max_concurrency ?? dash}</td>
      <td className="num">
        <div>
          {p.models_enabled} / {p.model_count}
        </div>
        <div className="cell-sub">{p.models_synced_at ? relative(p.models_synced_at) : t('common.never')}</div>
      </td>
      <td>
        <RowSwitch label={t('providers.f.enabled')} checked={p.enabled} disabled={toggle.pending} onChange={v => void toggle.run(v).then(r => r && onChanged())} />
      </td>
      <td className="actions">
        {p.node ? (
          <a href={href(['nodes', p.id])} className="btn btn-sm">
            {t('providers.open_node')}
          </a>
        ) : null}
        <Button size="sm" pending={test.pending} onClick={() => void runTest()}>
          {t('providers.test')}
        </Button>
        <Button size="sm" pending={sync.pending} onClick={() => void sync.run().then(r => r && onChanged())}>
          {t('providers.sync')}
        </Button>
        {p.node && p.status !== 'online' ? (
          <Button size="sm" pending={wake.pending} onClick={() => void wake.run().then(() => onChanged())}>
            {t('providers.wake')}
          </Button>
        ) : null}
        <Button size="sm" onClick={onEdit}>
          {t('common.edit')}
        </Button>
        <Button size="sm" variant="danger" pending={remove.pending} onClick={() => void askDelete()}>
          {t('common.delete')}
        </Button>
      </td>
    </tr>
  );
}
