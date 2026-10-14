import { useState } from 'react';
import { useApi } from '../api/context';
import type { Model, Support } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { num } from '../lib/format';
import { draftFromModel, hasOverride, patchFrom, RESETTABLE, type ModelDraft } from '../lib/models';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { ModelId, Note } from '../ui/bits';
import { NumberField, SelectField, SwitchField, TagsField, TextAreaField, TextField } from '../ui/fields';

const SUPPORTS: Support[] = ['tools', 'vision', 'reasoning_effort'];

interface Props {
  model: Model;
  tagSuggestions: string[];
  onClose: () => void;
  onSaved: () => void;
}

/** Edit what clients see about a model. Anything left alone keeps following the provider. */
export function ModelEditor({ model, tagSuggestions, onClose, onSaved }: Props) {
  const t = useT();
  const api = useApi();
  const [d, setD] = useState<ModelDraft>(() => draftFromModel(model));
  const [reset, setReset] = useState<Set<(typeof RESETTABLE)[number]>>(new Set());
  const set = <K extends keyof ModelDraft>(key: K, value: ModelDraft[K]) => {
    setD(prev => ({ ...prev, [key]: value }));
    setReset(prev => {
      if (!prev.has(key as never)) return prev;
      const next = new Set(prev);
      next.delete(key as never);
      return next;
    });
  };

  const save = useAction(async () => api.models.update(model.id, patchFrom(model, d, reset)), { inline: true, ok: t('models.saved') });

  const reported = model.reported ?? {};
  const resetBtn = (field: (typeof RESETTABLE)[number]) => {
    if (!hasOverride(model, field) || reset.has(field)) return null;
    const rep = reported[field];
    return (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setReset(prev => new Set(prev).add(field));
          const base = draftFromModel({ ...model, ...resolvedFromReported(model) });
          setD(prev => ({ ...prev, [field]: base[field] }));
        }}
      >
        {t('models.use_reported', { value: rep === undefined ? t('models.unknown') : Array.isArray(rep) ? rep.join(', ') : String(rep) })}
      </Button>
    );
  };

  return (
    <Dialog
      title={t('models.edit_title')}
      size="lg"
      onClose={onClose}
      onSubmit={() => void save.run().then(r => r && onSaved())}
      locked={save.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={save.pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" pending={save.pending}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ gap: 4 }}>
        <ModelId id={model.id} />
        <span className="field-hint">{model.source === 'manual' ? t('models.source_manual') : t('models.source_synced')}</span>
      </div>
      {save.error ? <Note tone="bad">{save.error}</Note> : null}
      {!model.present && model.source === 'synced' ? <Note tone="warn">{t('models.not_listed_hint')}</Note> : null}

      <div className="form-grid">
        <div className="stack" style={{ gap: 2 }}>
          <TextField label={t('models.f.name')} value={d.name} onChange={e => set('name', e.target.value)} />
          {resetBtn('name')}
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <SelectField label={t('models.f.kind')} value={d.kind} onChange={e => set('kind', e.target.value as ModelDraft['kind'])}>
            <option value="chat">chat</option>
            <option value="embedding">embedding</option>
            <option value="image">image</option>
            <option value="tts">tts</option>
            <option value="stt">stt</option>
          </SelectField>
          {resetBtn('kind')}
        </div>
        <div className="span-2 stack" style={{ gap: 2 }}>
          <TextAreaField label={t('models.f.description')} value={d.description} onChange={e => set('description', e.target.value)} />
          {resetBtn('description')}
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <NumberField label={t('models.f.context')} hint={t('models.f.context_hint')} value={d.context_length} onChange={v => set('context_length', v)} placeholder={t('models.unknown')} />
          {resetBtn('context_length')}
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <NumberField label={t('models.f.max_output')} value={d.max_output_tokens} onChange={v => set('max_output_tokens', v)} placeholder={t('models.unknown')} />
          {resetBtn('max_output_tokens')}
        </div>
        <div className="stack" style={{ gap: 2 }}>
          <SelectField label={t('models.f.locality')} hint={d.locality === 'local' ? t('locality.local_title') : t('locality.cloud_title')} value={d.locality} onChange={e => set('locality', e.target.value as ModelDraft['locality'])}>
            <option value="cloud">{t('locality.cloud')}</option>
            <option value="local">{t('locality.local')}</option>
          </SelectField>
          {resetBtn('locality')}
        </div>
        <fieldset className="field supports" aria-describedby="supports-hint">
          <legend>{t('models.f.supports')}</legend>
          {d.supports === null ? <p className="field-hint">{t('models.supports_unknown')}</p> : null}
          <div className="row">
            {SUPPORTS.map(s => (
              <label key={s} className="check">
                <input
                  type="checkbox"
                  checked={d.supports?.includes(s) ?? false}
                  onChange={e => {
                    const cur = d.supports ?? [];
                    set('supports', e.target.checked ? [...cur, s] : cur.filter(x => x !== s));
                  }}
                />
                {t(`models.support.${s}` as 'models.support.tools')}
              </label>
            ))}
          </div>
          <p id="supports-hint" className="field-hint">
            {t('models.f.supports_hint')}
          </p>
          {resetBtn('supports')}
        </fieldset>
        <div className="span-2 stack" style={{ gap: 2 }}>
          <TagsField label={t('models.f.tags')} hint={t('models.f.tags_hint')} value={d.tags} onChange={v => set('tags', v)} suggestions={tagSuggestions} />
          {resetBtn('tags')}
        </div>
        <SwitchField className="span-2" label={t('models.f.enabled')} hint={t('models.f.enabled_hint')} checked={d.enabled} onChange={v => setD(prev => ({ ...prev, enabled: v }))} />
      </div>
      {model.context_length ? <p className="field-hint">{t('models.current_context', { n: num(model.context_length) })}</p> : null}
    </Dialog>
  );
}

/** The model as it would look with no owner overrides: used to refill a field when it is reset. */
function resolvedFromReported(m: Model): Partial<Model> {
  const r = m.reported ?? {};
  return {
    name: r.name ?? m.upstream_id,
    description: r.description ?? '',
    kind: r.kind ?? 'chat',
    tags: r.tags ?? [],
    context_length: r.context_length ?? null,
    max_output_tokens: r.max_output_tokens ?? null,
    supports: r.supports ?? null,
    locality: r.locality ?? m.locality,
  };
}
