import { useMemo, useState } from 'react';
import { useApi } from '../api/context';
import type { Model, Provider } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { describeError } from '../lib/errors';
import { compact, dash } from '../lib/format';
import { allTags, filterModels, filtersFromQuery, filtersToQuery, NO_FILTERS, type ModelFilters } from '../lib/models';
import { useQuery } from '../lib/query';
import { replaceQuery, useRoute } from '../lib/router';
import { toast } from '../lib/toast';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/Confirm';
import { Dialog } from '../ui/Dialog';
import { Badge, Empty, ErrorNote, Loading, LocalityBadge, ModelId, Note, PageHeader } from '../ui/bits';
import { NumberField, RowSwitch, SelectField, TagsField, TextField } from '../ui/fields';
import { ModelEditor } from './ModelEditor';

const PAGE = 150;

/** Every model the hub can serve, across providers. A provider's own page shows the same list, narrowed to it (`scope`). */
export function Models() {
  const t = useT();
  return (
    <>
      <PageHeader title={t('nav.models')} sub={t('models.sub')} />
      <ModelsView />
    </>
  );
}

export function ModelsView({ scope }: { scope?: string }) {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();
  const route = useRoute();
  // on the global page the filters live in the address; on a provider's page they would fight with its own address
  const [local, setLocal] = useState<ModelFilters>(NO_FILTERS);
  const filters = scope ? { ...local, provider: scope } : filtersFromQuery(route.query);
  const setFilters = (patch: Partial<ModelFilters>) => (scope ? setLocal(f => ({ ...f, ...patch })) : replaceQuery(['models'], filtersToQuery({ ...filters, ...patch })));
  const noFilters: ModelFilters = scope ? { ...NO_FILTERS, provider: scope } : NO_FILTERS;

  const models = useQuery(s => api.models.list(scope, s), [scope], { every: 20_000 });
  const providers = useQuery(s => api.providers.list(s), [], { enabled: !scope });
  const [editing, setEditing] = useState<Model | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(PAGE);
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  const all = useMemo(() => models.data ?? [], [models.data]);
  const filtered = useMemo(() => filterModels(all, filters), [all, filters.q, filters.provider, filters.kind, filters.locality, filters.state, filters.tag]); // eslint-disable-line react-hooks/exhaustive-deps -- `filters` is a new object on every render; its fields are the inputs
  const tags = useMemo(() => allTags(all), [all]);
  const visible = filtered.slice(0, shown);
  const selectedHere = filtered.filter(m => selected.has(m.id));
  const filtering = JSON.stringify(filters) !== JSON.stringify(noFilters);

  const toggle = useAction(async (m: Model, enabled: boolean) => api.models.update(m.id, { enabled }));

  /** Enable or disable many at once, four requests at a time, so a catalog of hundreds is not a hundred clicks. */
  const setMany = async (list: Model[], enabled: boolean) => {
    const todo = list.filter(m => m.enabled !== enabled);
    if (!todo.length) return;
    if (todo.length > 20) {
      const ok = await confirm({
        title: enabled ? t('models.bulk_enable_title', { n: todo.length }) : t('models.bulk_disable_title', { n: todo.length }),
        body: <p>{t('models.bulk_body')}</p>,
        confirmLabel: enabled ? t('models.enable') : t('models.disable'),
      });
      if (!ok) return;
    }
    setBulk({ done: 0, total: todo.length });
    let failed = 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const m = todo[next++]!;
        try {
          await api.models.update(m.id, { enabled });
        } catch {
          failed++;
        }
        setBulk({ done: ++done, total: todo.length });
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    setBulk(null);
    setSelected(new Set());
    await models.reload();
    if (failed) toast.error(t('models.bulk_failed', { n: failed }));
    else toast.ok(t('models.bulk_done', { n: todo.length }));
  };

  const askDelete = async (m: Model) => {
    const ok = await confirm({
      title: t('models.delete_title'),
      body: <p>{m.source === 'manual' ? t('models.delete_manual') : t('models.delete_synced')}</p>,
      confirmLabel: m.source === 'manual' ? t('common.delete') : t('models.disable'),
      danger: m.source === 'manual',
    });
    if (!ok) return;
    try {
      await api.models.remove(m.id);
      toast.ok(t('models.deleted'));
      void models.reload();
    } catch (e) {
      toast.error(describeError(e));
    }
  };

  const allSelected = filtered.length > 0 && filtered.every(m => selected.has(m.id));

  return (
    <>
      <div className="filters">
        <TextField className="field-grow" label={t('common.search')} type="search" value={filters.q} onChange={e => setFilters({ q: e.target.value })} placeholder={t('models.search_placeholder')} spellCheck={false} />
        {scope ? null : (
          <SelectField label={t('models.f.provider')} value={filters.provider} onChange={e => setFilters({ provider: e.target.value })}>
            <option value="">{t('common.all')}</option>
            {(providers.data ?? []).map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        )}
        <SelectField label={t('models.f.kind')} value={filters.kind} onChange={e => setFilters({ kind: e.target.value as ModelFilters['kind'] })}>
          <option value="">{t('common.all')}</option>
          <option value="chat">chat</option>
          <option value="embedding">embedding</option>
          <option value="image">image</option>
          <option value="tts">tts</option>
          <option value="stt">stt</option>
        </SelectField>
        <SelectField label={t('models.f.locality')} value={filters.locality} onChange={e => setFilters({ locality: e.target.value as ModelFilters['locality'] })}>
          <option value="">{t('common.all')}</option>
          <option value="local">{t('locality.local')}</option>
          <option value="cloud">{t('locality.cloud')}</option>
        </SelectField>
        <SelectField label={t('models.f.state')} value={filters.state} onChange={e => setFilters({ state: e.target.value as ModelFilters['state'] })}>
          <option value="">{t('common.all')}</option>
          <option value="on">{t('models.state.on')}</option>
          <option value="off">{t('models.state.off')}</option>
        </SelectField>
        {tags.length ? (
          <SelectField label={t('models.f.tag')} value={filters.tag} onChange={e => setFilters({ tag: e.target.value })}>
            <option value="">{t('common.all')}</option>
            {tags.map(x => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </SelectField>
        ) : null}
        {filtering ? (
          <Button size="sm" variant="ghost" onClick={() => (scope ? setLocal(NO_FILTERS) : replaceQuery(['models'], {}))}>
            {t('models.clear_filters')}
          </Button>
        ) : null}
      </div>

      {models.loading ? (
        <Loading />
      ) : models.error && !models.data ? (
        <ErrorNote error={models.error} onRetry={() => void models.reload()} />
      ) : all.length === 0 ? (
        <Empty title={t('models.empty')}>{t('models.empty_hint')}</Empty>
      ) : (
        <>
          <div className="bulkbar" aria-live="polite">
            <span>{t('models.count', { shown: filtered.length, total: all.length })}</span>
            <span className="spacer" />
            {bulk ? (
              <span>{t('models.bulk_progress', { done: bulk.done, total: bulk.total })}</span>
            ) : selectedHere.length ? (
              <>
                <span>{t('models.selected', { n: selectedHere.length })}</span>
                <Button size="sm" onClick={() => void setMany(selectedHere, true)}>
                  {t('models.enable')}
                </Button>
                <Button size="sm" onClick={() => void setMany(selectedHere, false)}>
                  {t('models.disable')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  {t('models.clear_selection')}
                </Button>
              </>
            ) : filtering && filtered.length ? (
              <>
                <Button size="sm" onClick={() => void setMany(filtered, true)}>
                  {t('models.enable_shown', { n: filtered.length })}
                </Button>
                <Button size="sm" onClick={() => void setMany(filtered, false)}>
                  {t('models.disable_shown')}
                </Button>
              </>
            ) : null}
          </div>
          {filtered.length === 0 ? (
            <Empty title={t('models.no_match')} />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th className="check-col">
                      <input
                        type="checkbox"
                        aria-label={t('models.select_all')}
                        checked={allSelected}
                        onChange={e => setSelected(e.target.checked ? new Set(filtered.map(m => m.id)) : new Set())}
                      />
                    </th>
                    <th>{t('models.col.on')}</th>
                    <th>{t('models.col.model')}</th>
                    <th>{t('models.col.runs')}</th>
                    <th className="num">{t('models.col.context')}</th>
                    <th>{t('models.col.features')}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {visible.map(m => (
                    <tr key={m.id} className={m.enabled ? undefined : 'is-off'}>
                      <td className="check-col">
                        <input
                          type="checkbox"
                          aria-label={t('models.select_one', { id: m.id })}
                          checked={selected.has(m.id)}
                          onChange={e =>
                            setSelected(prev => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(m.id);
                              else next.delete(m.id);
                              return next;
                            })
                          }
                        />
                      </td>
                      <td>
                        <RowSwitch label={t('models.f.enabled')} checked={m.enabled} disabled={toggle.pending} onChange={v => void toggle.run(m, v).then(r => r && models.reload())} />
                      </td>
                      <td className="model-cell">
                        <ModelId id={m.id} short={!!scope} className="cell-main" />
                        {m.name && m.name !== m.upstream_id ? <div className="cell-sub">{m.name}</div> : null}
                      </td>
                      <td>
                        <div className="chips">
                          <LocalityBadge locality={m.locality} />
                          {m.kind !== 'chat' ? <Badge>{m.kind}</Badge> : null}
                          {m.source === 'manual' ? <Badge>{t('models.manual')}</Badge> : null}
                          {!m.present && m.source === 'synced' ? (
                            <Badge tone="warn" title={t('models.not_listed_hint')}>
                              {t('models.not_listed')}
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="num">{m.context_length ? compact(m.context_length) : dash}</td>
                      <td>
                        <div className="chips">
                          {(m.supports ?? []).map(s => (
                            <span key={s} className="chip">
                              {t(`models.support.${s}` as 'models.support.tools')}
                            </span>
                          ))}
                          {m.tags.map(x => (
                            <button key={x} type="button" className={x === 'uncensored' ? 'chip chip-button chip-tag' : 'chip chip-button'} onClick={() => setFilters({ tag: x })} title={t('models.filter_by_tag')}>
                              {x}
                            </button>
                          ))}
                        </div>
                      </td>
                      <td className="actions">
                        <Button size="sm" onClick={() => setEditing(m)}>
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void askDelete(m)} aria-label={t('common.delete')}>
                          ×
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {filtered.length > shown ? (
            <p className="more">
              <Button onClick={() => setShown(n => n + PAGE)}>{t('models.show_more', { n: Math.min(PAGE, filtered.length - shown) })}</Button>
            </p>
          ) : null}
        </>
      )}

      {editing ? (
        <ModelEditor
          model={editing}
          tagSuggestions={tags}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void models.reload();
          }}
        />
      ) : null}
    </>
  );
}

/** For a model the provider does not list. Lives on the provider's page, under Advanced. */
export function AddModel({ providers, onClose, onAdded }: { providers: Provider[]; onClose: () => void; onAdded: () => void }) {
  const t = useT();
  const api = useApi();
  const [provider, setProvider] = useState(providers[0]?.id ?? '');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Model['kind']>('chat');
  const [context, setContext] = useState<number | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const add = useAction(
    async () =>
      api.models.create({
        provider,
        id: id.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        kind,
        ...(context !== null ? { context_length: context } : {}),
        ...(tags.length ? { tags } : {}),
      }),
    { inline: true, ok: t('models.added') },
  );
  return (
    <Dialog
      title={t('models.add')}
      onClose={onClose}
      onSubmit={() => void add.run().then(r => r && onAdded())}
      locked={add.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={add.pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" pending={add.pending} disabled={!id.trim() || !provider}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <Note>{t('models.add_hint')}</Note>
      {add.error ? <Note tone="bad">{add.error}</Note> : null}
      <div className="form-grid">
        {providers.length > 1 ? (
          <SelectField label={t('models.f.provider')} value={provider} onChange={e => setProvider(e.target.value)}>
            {providers.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        <TextField label={t('models.f.upstream_id')} hint={t('models.f.upstream_id_hint')} value={id} onChange={e => setId(e.target.value)} spellCheck={false} autoFocus />
        <TextField label={t('models.f.name')} value={name} onChange={e => setName(e.target.value)} />
        <SelectField label={t('models.f.kind')} value={kind} onChange={e => setKind(e.target.value as Model['kind'])}>
          <option value="chat">chat</option>
          <option value="embedding">embedding</option>
        </SelectField>
        <NumberField label={t('models.f.context')} value={context} onChange={setContext} placeholder={t('models.unknown')} />
        <TagsField label={t('models.f.tags')} value={tags} onChange={setTags} />
      </div>
    </Dialog>
  );
}
