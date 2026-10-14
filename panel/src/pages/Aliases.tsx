import { useMemo, useState } from 'react';
import { useApi } from '../api/context';
import type { Alias, Model } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { useQuery } from '../lib/query';
import { toast } from '../lib/toast';
import { Button } from '../ui/Button';
import { Chain } from '../ui/Chain';
import { useConfirm } from '../ui/Confirm';
import { Dialog } from '../ui/Dialog';
import { Badge, Empty, ErrorNote, Loading, LocalityBadge, ModelId, Note, PageHeader } from '../ui/bits';
import { RowSwitch, SwitchField, TagsField, TextAreaField, TextField } from '../ui/fields';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;

export function Aliases() {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();
  const aliases = useQuery(s => api.aliases.list(s), [], { every: 15_000 });
  const models = useQuery(s => api.models.list(undefined, s), [], { every: 30_000 });
  const [editing, setEditing] = useState<Alias | 'new' | null>(null);

  const byId = useMemo(() => new Map((models.data ?? []).map(m => [m.id, m])), [models.data]);
  const toggle = useAction(async (a: Alias, enabled: boolean) => api.aliases.update(a.name, { enabled }));

  const askDelete = async (a: Alias) => {
    const ok = await confirm({ title: t('aliases.delete_title', { name: a.name }), body: <p>{t('aliases.delete_body')}</p>, confirmLabel: t('common.delete'), danger: true });
    if (!ok) return;
    try {
      await api.aliases.remove(a.name);
      toast.ok(t('aliases.deleted'));
      void aliases.reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <PageHeader title={t('nav.aliases')} sub={t('aliases.sub')}>
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('aliases.add')}
        </Button>
      </PageHeader>

      {aliases.loading ? (
        <Loading />
      ) : aliases.error && !aliases.data ? (
        <ErrorNote error={aliases.error} onRetry={() => void aliases.reload()} />
      ) : aliases.data && aliases.data.length === 0 ? (
        <Empty title={t('aliases.empty')}>
          <p>{t('aliases.empty_hint')}</p>
        </Empty>
      ) : (
        <ul className="alias-list">
          {aliases.data?.map(a => (
            <li key={a.name} className={`alias${a.enabled ? '' : ' is-off'}`}>
              <div className="alias-head">
                <div className="alias-name">
                  <span className="mono alias-title">{a.name}</span>
                  <LocalityBadge locality={a.locality} />
                  {a.tags.map(x => (
                    <span key={x} className="chip">
                      {x}
                    </span>
                  ))}
                  {a.missing_targets.length ? <Badge tone="warn">{t('aliases.missing', { n: a.missing_targets.length })}</Badge> : null}
                </div>
                <div className="row">
                  <RowSwitch label={t('aliases.enabled')} checked={a.enabled} disabled={toggle.pending} onChange={v => void toggle.run(a, v).then(r => r && aliases.reload())} />
                  <Button size="sm" onClick={() => setEditing(a)}>
                    {t('common.edit')}
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => void askDelete(a)}>
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
              {a.description ? <p className="alias-desc">{a.description}</p> : null}
              <Chain targets={a.targets} models={byId} name={a.name} />
            </li>
          ))}
        </ul>
      )}
      <p className="section-sub fallback-note">{t('aliases.fallback_note')}</p>

      {editing ? (
        <AliasEditor
          alias={editing === 'new' ? null : editing}
          models={models.data ?? []}
          existing={(aliases.data ?? []).map(a => a.name)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void aliases.reload();
          }}
        />
      ) : null}
    </>
  );
}

function AliasEditor({ alias, models, existing, onClose, onSaved }: { alias: Alias | null; models: Model[]; existing: string[]; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const api = useApi();
  const [name, setName] = useState(alias?.name ?? '');
  const [description, setDescription] = useState(alias?.description ?? '');
  const [tags, setTags] = useState<string[]>(alias?.tags ?? []);
  const [targets, setTargets] = useState<string[]>(alias?.targets ?? []);
  const [enabled, setEnabled] = useState(alias?.enabled ?? true);
  const [pick, setPick] = useState('');
  const [tried, setTried] = useState(false);

  const byId = useMemo(() => new Map(models.map(m => [m.id, m])), [models]);
  const nameError = !alias && !NAME.test(name) ? t('aliases.f.name_error') : !alias && existing.includes(name) ? t('aliases.f.name_taken') : null;
  const choices = models.filter(m => m.kind === 'chat' && !targets.includes(m.id));

  // the data-protection warning from docs/04-models.md: an uncensored model with a cloud fallback can leak the same prompt to a provider
  const locals = targets.map(id => byId.get(id)).filter((m): m is Model => Boolean(m));
  const uncensoredWithCloud = locals.some(m => m.tags.includes('uncensored')) && locals.some(m => m.locality === 'cloud');

  const save = useAction(
    async () => {
      const body = { description, tags, targets, enabled };
      return alias ? api.aliases.update(alias.name, body) : api.aliases.create({ name, ...body });
    },
    { inline: true, ok: alias ? t('aliases.saved') : t('aliases.created') },
  );

  const add = (id: string) => {
    const trimmed = id.trim();
    if (!trimmed || targets.includes(trimmed)) return;
    setTargets(prev => [...prev, trimmed]);
    setPick('');
  };
  const move = (i: number, by: -1 | 1) =>
    setTargets(prev => {
      const next = [...prev];
      const j = i + by;
      if (j < 0 || j >= next.length) return prev;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <Dialog
      title={alias ? t('aliases.edit_title', { name: alias.name }) : t('aliases.add')}
      size="lg"
      onClose={onClose}
      locked={save.pending}
      onSubmit={() => {
        setTried(true);
        if (nameError || targets.length === 0) return;
        void save.run().then(r => r && onSaved());
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={save.pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" pending={save.pending}>
            {alias ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      {save.error ? <Note tone="bad">{save.error}</Note> : null}
      <div className="form-grid">
        <TextField label={t('aliases.f.name')} hint={t('aliases.f.name_hint')} value={name} disabled={Boolean(alias)} onChange={e => setName(e.target.value)} error={tried ? nameError : null} spellCheck={false} autoComplete="off" autoFocus={!alias} />
        <TagsField label={t('aliases.f.tags')} value={tags} onChange={setTags} />
        <TextAreaField className="span-2" label={t('aliases.f.description')} value={description} onChange={e => setDescription(e.target.value)} />
      </div>

      <div className="stack">
        <div>
          <h3>{t('aliases.f.targets')}</h3>
          <p className="field-hint">{t('aliases.f.targets_hint')}</p>
        </div>
        {targets.length === 0 ? <p className={tried ? 'field-error' : 'field-hint'}>{t('aliases.f.targets_empty')}</p> : null}
        <ol className="target-list">
          {targets.map((id, i) => {
            const m = byId.get(id);
            return (
              <li key={id} className="target">
                <span className="target-order">{i === 0 ? t('aliases.first') : t('aliases.then')}</span>
                <span className="target-id">
                  <ModelId id={id} />
                  <span className="target-meta">
                    {m ? <LocalityBadge locality={m.locality} /> : <Badge tone="warn">{t('aliases.hop_missing')}</Badge>}
                    {m && !m.enabled ? <Badge tone="warn">{t('aliases.hop_disabled')}</Badge> : null}
                  </span>
                </span>
                <span className="row">
                  <Button size="sm" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('aliases.move_up', { id })}>
                    ↑
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => move(i, 1)} disabled={i === targets.length - 1} aria-label={t('aliases.move_down', { id })}>
                    ↓
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setTargets(prev => prev.filter(x => x !== id))} aria-label={t('common.remove_item', { item: id })}>
                    ×
                  </Button>
                </span>
              </li>
            );
          })}
        </ol>
        <div className="row add-target">
          <input
            list="alias-model-choices"
            aria-label={t('aliases.f.add_target')}
            placeholder={t('aliases.f.add_target_placeholder')}
            value={pick}
            onChange={e => setPick(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add(pick);
              }
            }}
            spellCheck={false}
          />
          <datalist id="alias-model-choices">
            {choices.map(m => (
              <option key={m.id} value={m.id}>
                {m.enabled ? m.name : `${m.name} (${t('aliases.hop_disabled')})`}
              </option>
            ))}
          </datalist>
          <Button onClick={() => add(pick)} disabled={!pick.trim()}>
            {t('common.add')}
          </Button>
        </div>
        {uncensoredWithCloud ? <Note tone="warn">{t('aliases.uncensored_warning')}</Note> : null}
        {targets.length > 1 ? <Chain targets={targets} models={byId} /> : null}
      </div>
      <SwitchField label={t('aliases.enabled')} checked={enabled} onChange={setEnabled} />
    </Dialog>
  );
}
