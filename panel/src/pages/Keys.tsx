import { useState } from 'react';
import { useApi } from '../api/context';
import type { ApiKey, KeyInput } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { compact, limit, num, relative } from '../lib/format';
import { useQuery } from '../lib/query';
import { Button } from '../ui/Button';
import { useConfirm } from '../ui/Confirm';
import { Dialog } from '../ui/Dialog';
import { Badge, CopyButton, Empty, ErrorNote, Loading, Meter, Note, PageHeader } from '../ui/bits';
import { NumberField, SelectField, SwitchField, TagsField, TextField } from '../ui/fields';

const KEY_NAME = /^[\w .@-]{1,64}$/;

export function Keys() {
  const t = useT();
  const api = useApi();
  const confirm = useConfirm();
  const keys = useQuery(s => api.keys.list(s), [], { every: 10_000 });
  const aliases = useQuery(s => api.aliases.list(s), []);
  const providers = useQuery(s => api.providers.list(s), []);
  const [editing, setEditing] = useState<ApiKey | 'new' | null>(null);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);

  const revoke = useAction(async (k: ApiKey) => api.keys.revoke(k.id), { ok: t('keys.revoked_done') });
  const remove = useAction(async (k: ApiKey) => api.keys.remove(k.id), { ok: t('keys.deleted') });

  const askRevoke = async (k: ApiKey) => {
    const ok = await confirm({ title: t('keys.revoke_title', { name: k.name }), body: <p>{t('keys.revoke_body')}</p>, confirmLabel: t('keys.revoke'), danger: true });
    if (ok && (await revoke.run(k))) void keys.reload();
  };
  const askDelete = async (k: ApiKey) => {
    const ok = await confirm({ title: t('keys.delete_title', { name: k.name }), body: <p>{t('keys.delete_body')}</p>, confirmLabel: t('common.delete'), danger: true });
    if (ok && (await remove.run(k))) void keys.reload();
  };

  const suggestions = [...(aliases.data ?? []).map(a => a.name), ...(providers.data ?? []).map(p => `${p.id}/*`)];

  return (
    <>
      <PageHeader title={t('nav.keys')} sub={t('keys.sub')}>
        <Button variant="primary" onClick={() => setEditing('new')}>
          {t('keys.add')}
        </Button>
      </PageHeader>

      {keys.loading ? (
        <Loading />
      ) : keys.error && !keys.data ? (
        <ErrorNote error={keys.error} onRetry={() => void keys.reload()} />
      ) : keys.data && keys.data.length === 0 ? (
        <Empty title={t('keys.empty')}>{t('keys.empty_hint')}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('keys.col.name')}</th>
                <th>{t('keys.col.scope')}</th>
                <th>{t('keys.col.priority')}</th>
                <th>{t('keys.col.requests')}</th>
                <th>{t('keys.col.tokens_day')}</th>
                <th>{t('keys.col.tokens_month')}</th>
                <th>{t('keys.col.last_used')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {keys.data?.map(k => (
                <tr key={k.id} className={k.revoked_at ? 'is-off' : undefined}>
                  <td className="cell-key">
                    <div className="cell-main">{k.name}</div>
                    <div className="cell-sub mono">{k.prefix}…</div>
                    {k.revoked_at ? <Badge tone="bad">{t('keys.revoked')}</Badge> : null}
                  </td>
                  <td>
                    <div className="chips">
                      {k.local_only ? <Badge tone="local">{t('keys.local_only')}</Badge> : null}
                      {k.allowed_models === null ? <span className="cell-sub">{t('keys.all_models')}</span> : k.allowed_models.map(m => <span key={m} className="chip mono">{m}</span>)}
                    </div>
                  </td>
                  <td className="num">
                    {k.default_priority}
                    <div className="cell-sub">
                      {k.min_priority}–{k.max_priority}
                    </div>
                  </td>
                  <td>
                    <Usage value={k.usage.requests_today} max={k.rpd} label={t('keys.col.requests')} perMinute={k.rpm} />
                  </td>
                  <td>
                    <Usage value={k.usage.tokens_today} max={k.tokens_per_day} label={t('keys.col.tokens_day')} compactNumbers />
                  </td>
                  <td>
                    <Usage value={k.usage.tokens_month} max={k.tokens_per_month} label={t('keys.col.tokens_month')} compactNumbers />
                  </td>
                  <td>{k.last_used_at ? relative(k.last_used_at) : t('common.never')}</td>
                  <td className="actions">
                    {!k.revoked_at ? (
                      <Button size="sm" onClick={() => setEditing(k)}>
                        {t('common.edit')}
                      </Button>
                    ) : null}
                    {!k.revoked_at ? (
                      <Button size="sm" onClick={() => void askRevoke(k)}>
                        {t('keys.revoke')}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="danger" onClick={() => void askDelete(k)}>
                      {t('common.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing ? (
        <KeyEditor
          existing={editing === 'new' ? null : editing}
          suggestions={suggestions}
          onClose={() => setEditing(null)}
          onSaved={result => {
            setEditing(null);
            void keys.reload();
            if (result) setCreated(result);
          }}
        />
      ) : null}
      {created ? <NewKey {...created} onClose={() => setCreated(null)} /> : null}
    </>
  );
}

function Usage({ value, max, label, perMinute, compactNumbers }: { value: number; max: number | null; label: string; perMinute?: number | null; compactNumbers?: boolean }) {
  const t = useT();
  const f = compactNumbers ? compact : num;
  return (
    <div className="usage-cell">
      <div className="usage-text">
        <b>{f(value)}</b>
        <span className="cell-sub"> / {max === null ? '∞' : f(max)}</span>
      </div>
      {max !== null ? <Meter value={value} max={max} label={t('keys.usage_meter', { what: label })} /> : null}
      {perMinute != null ? <div className="cell-sub">{t('keys.per_minute', { n: perMinute })}</div> : null}
    </div>
  );
}

function KeyEditor({ existing, suggestions, onClose, onSaved }: { existing: ApiKey | null; suggestions: string[]; onClose: () => void; onSaved: (created: { name: string; secret: string } | null) => void }) {
  const t = useT();
  const api = useApi();
  const [name, setName] = useState(existing?.name ?? '');
  const [defPriority, setDef] = useState(existing?.default_priority ?? 3);
  const [minPriority, setMin] = useState(existing?.min_priority ?? 1);
  const [maxPriority, setMax] = useState(existing?.max_priority ?? 5);
  const [localOnly, setLocalOnly] = useState(existing?.local_only ?? false);
  const [restrict, setRestrict] = useState(existing ? existing.allowed_models !== null : false);
  const [allowed, setAllowed] = useState<string[]>(existing?.allowed_models ?? []);
  const [rpm, setRpm] = useState<number | null>(existing?.rpm ?? null);
  const [rpd, setRpd] = useState<number | null>(existing?.rpd ?? null);
  const [tpd, setTpd] = useState<number | null>(existing?.tokens_per_day ?? null);
  const [tpm, setTpm] = useState<number | null>(existing?.tokens_per_month ?? null);
  const [tried, setTried] = useState(false);

  const nameError = !KEY_NAME.test(name.trim()) ? t('keys.f.name_error') : null;
  const priorityError = minPriority > defPriority || defPriority > maxPriority ? t('keys.f.priority_error') : null;
  const allowedError = restrict && allowed.length === 0 ? t('keys.f.allowed_error') : null;

  const save = useAction(
    async () => {
      const body: KeyInput = {
        name: name.trim(),
        default_priority: defPriority,
        min_priority: minPriority,
        max_priority: maxPriority,
        local_only: localOnly,
        allowed_models: restrict ? allowed : null,
        rpm,
        rpd,
        tokens_per_day: tpd,
        tokens_per_month: tpm,
      };
      if (existing) return { created: null, saved: await api.keys.update(existing.id, body) };
      const made = await api.keys.create({ ...body, name: name.trim() });
      return { created: { name: made.name, secret: made.key }, saved: made };
    },
    { inline: true, ok: existing ? t('keys.saved') : undefined },
  );

  const prio = (value: number, set: (n: number) => void, label: string) => (
    <SelectField label={label} value={String(value)} onChange={e => set(Number(e.target.value))}>
      {[1, 2, 3, 4, 5].map(n => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
    </SelectField>
  );

  return (
    <Dialog
      title={existing ? t('keys.edit_title', { name: existing.name }) : t('keys.add')}
      size="lg"
      onClose={onClose}
      locked={save.pending}
      onSubmit={() => {
        setTried(true);
        if (nameError || priorityError || allowedError) return;
        void save.run().then(r => r && onSaved(r.created));
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={save.pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" pending={save.pending}>
            {existing ? t('common.save') : t('common.create')}
          </Button>
        </>
      }
    >
      {save.error ? <Note tone="bad">{save.error}</Note> : null}
      <div className="form-grid">
        <TextField className="span-2" label={t('keys.f.name')} hint={t('keys.f.name_hint')} value={name} onChange={e => setName(e.target.value)} error={tried ? nameError : null} autoFocus spellCheck={false} />

        <div className="form-sep span-2">
          <h3>{t('keys.s.priority')}</h3>
          <p className="field-hint">{t('keys.s.priority_hint')}</p>
        </div>
        {prio(defPriority, setDef, t('keys.f.default_priority'))}
        <div className="row two">
          {prio(minPriority, setMin, t('keys.f.min_priority'))}
          {prio(maxPriority, setMax, t('keys.f.max_priority'))}
        </div>
        {tried && priorityError ? <p className="field-error span-2">{priorityError}</p> : null}

        <div className="form-sep span-2">
          <h3>{t('keys.s.scope')}</h3>
        </div>
        <SwitchField className="span-2" label={t('keys.f.local_only')} hint={t('keys.f.local_only_hint')} checked={localOnly} onChange={setLocalOnly} />
        <SwitchField className="span-2" label={t('keys.f.restrict')} hint={t('keys.f.restrict_hint')} checked={restrict} onChange={setRestrict} />
        {restrict ? <TagsField className="span-2" label={t('keys.f.allowed')} hint={t('keys.f.allowed_hint')} value={allowed} onChange={setAllowed} suggestions={suggestions} error={tried ? allowedError : null} /> : null}

        <div className="form-sep span-2">
          <h3>{t('keys.s.limits')}</h3>
          <p className="field-hint">{t('keys.s.limits_hint')}</p>
        </div>
        <NumberField label={t('keys.f.rpm')} value={rpm} onChange={setRpm} placeholder={t('common.unlimited')} />
        <NumberField label={t('keys.f.rpd')} value={rpd} onChange={setRpd} placeholder={t('common.unlimited')} />
        <NumberField label={t('keys.f.tpd')} value={tpd} onChange={setTpd} placeholder={t('common.unlimited')} />
        <NumberField label={t('keys.f.tpm')} value={tpm} onChange={setTpm} placeholder={t('common.unlimited')} />
      </div>
      {existing ? <p className="field-hint">{t('keys.current_limits', { rpm: limit(existing.rpm), rpd: limit(existing.rpd) })}</p> : null}
    </Dialog>
  );
}

/** The one moment the full key exists in the browser: shown once, with a way to copy it. */
/** (the prop is not called `key`: React keeps that name for itself and would never hand it on) */
function NewKey({ name, secret, onClose }: { name: string; secret: string; onClose: () => void }) {
  const t = useT();
  return (
    <Dialog title={t('keys.new_title', { name })} onClose={onClose} footer={<Button variant="primary" onClick={onClose}>{t('keys.new_done')}</Button>}>
      <Note tone="warn">{t('keys.new_warning')}</Note>
      <div className="secret">
        <code className="secret-value" data-testid="new-key">
          {secret}
        </code>
        <CopyButton text={secret} />
      </div>
      <p className="field-hint">{t('keys.new_usage')}</p>
      <pre className="snippet">{`curl ${globalThis.location?.origin ?? ''}/v1/chat/completions \\
  -H "Authorization: Bearer ${secret}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"…","messages":[{"role":"user","content":"Hello"}]}'`}</pre>
    </Dialog>
  );
}
