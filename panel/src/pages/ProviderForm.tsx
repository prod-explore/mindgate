import { useState } from 'react';
import { useApi } from '../api/context';
import type { Provider } from '../api/types';
import { useT } from '../i18n';
import { useAction } from '../lib/action';
import { toInput, validate, type ProviderDraft } from '../lib/provider-form';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Note } from '../ui/bits';
import { NumberField, SelectField, SwitchField, TextField } from '../ui/fields';

interface Props {
  mode: 'create' | 'edit';
  initial: ProviderDraft;
  /** The stored provider, when editing: tells the form whether a key exists. */
  provider?: Provider;
  onClose: () => void;
  onSaved: (provider: Provider) => void;
}

export function ProviderForm({ mode, initial, provider, onClose, onSaved }: Props) {
  const t = useT();
  const api = useApi();
  const [d, setD] = useState<ProviderDraft>(initial);
  const [tried, setTried] = useState(false);
  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) => setD(prev => ({ ...prev, [key]: value }));

  const save = useAction(
    async () => {
      const input = toInput(d, mode);
      return mode === 'create' ? ((await api.providers.create(input)) as Provider) : api.providers.update(initial.id, input);
    },
    { inline: true, ok: mode === 'create' ? t('providers.created') : t('providers.saved') },
  );

  const problems = validate(d, mode);
  const err = (k: keyof typeof problems, msg: string) => (tried && problems[k] ? msg : null);

  const submit = async () => {
    setTried(true);
    if (Object.keys(problems).length) return;
    const saved = await save.run();
    if (saved) onSaved(saved);
  };

  const hasKey = Boolean(provider?.has_api_key);

  return (
    <Dialog
      title={mode === 'create' ? t('providers.add') : t('providers.edit_title', { name: provider?.name ?? initial.id })}
      size="lg"
      onClose={onClose}
      onSubmit={() => void submit()}
      locked={save.pending}
      footer={
        <>
          <Button onClick={onClose} disabled={save.pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" pending={save.pending}>
            {mode === 'create' ? t('common.create') : t('common.save')}
          </Button>
        </>
      }
    >
      {save.error ? <Note tone="bad">{save.error}</Note> : null}
      {provider?.api_key_unreadable ? <Note tone="warn">{t('providers.key_unreadable_hint')}</Note> : null}

      <div className="form-grid">
        <TextField label={t('providers.f.id')} hint={t('providers.f.id_hint')} value={d.id} disabled={mode === 'edit'} onChange={e => set('id', e.target.value.toLowerCase())} error={err('id', t('providers.f.id_error'))} autoComplete="off" spellCheck={false} />
        <TextField label={t('providers.f.name')} value={d.name} onChange={e => set('name', e.target.value)} autoComplete="off" />
        <SelectField label={t('providers.f.type')} hint={d.type === 'anthropic' ? t('providers.f.type_anthropic') : t('providers.f.type_openai')} value={d.type} onChange={e => set('type', e.target.value as ProviderDraft['type'])}>
          <option value="openai">{t('providers.type.openai')}</option>
          <option value="anthropic">{t('providers.type.anthropic')}</option>
        </SelectField>
        <SelectField label={t('providers.f.locality')} hint={d.locality === 'local' ? t('locality.local_title') : t('locality.cloud_title')} value={d.locality} onChange={e => set('locality', e.target.value as ProviderDraft['locality'])}>
          <option value="cloud">{t('locality.cloud')}</option>
          <option value="local">{t('locality.local')}</option>
        </SelectField>
        <TextField className="span-2" label={t('providers.f.base_url')} hint={t('providers.f.base_url_hint')} value={d.base_url} onChange={e => set('base_url', e.target.value)} error={err('base_url', t('providers.f.base_url_error'))} placeholder="https://…/v1" autoComplete="off" spellCheck={false} />

        <div className="form-sep">
          <h3>{t('providers.s.access')}</h3>
        </div>
        <SelectField label={t('providers.f.auth')} value={d.auth_scheme} onChange={e => set('auth_scheme', e.target.value as ProviderDraft['auth_scheme'])}>
          <option value="bearer">{t('providers.auth.bearer')}</option>
          <option value="header">{t('providers.auth.header')}</option>
          <option value="none">{t('providers.auth.none')}</option>
        </SelectField>
        {d.auth_scheme === 'header' ? <TextField label={t('providers.f.auth_header')} value={d.auth_header} onChange={e => set('auth_header', e.target.value)} placeholder="x-api-key" error={err('auth_header', t('providers.f.auth_header_error'))} spellCheck={false} /> : <div />}
        {d.auth_scheme !== 'none' ? (
          <>
            <TextField
              className="span-2"
              label={d.is_node ? t('providers.f.node_secret') : t('providers.f.api_key')}
              hint={hasKey && !d.clear_key ? t('providers.f.api_key_stored', { hint: provider?.api_key_hint ?? '' }) : d.is_node ? t('providers.f.node_secret_hint') : t('providers.f.api_key_hint')}
              type="password"
              value={d.api_key}
              disabled={d.clear_key}
              onChange={e => set('api_key', e.target.value)}
              placeholder={hasKey ? '••••••••' : ''}
              autoComplete="new-password"
              spellCheck={false}
            />
            {hasKey ? <SwitchField className="span-2" label={t('providers.f.clear_key')} checked={d.clear_key} onChange={v => set('clear_key', v)} /> : null}
          </>
        ) : null}

        <div className="form-sep span-2">
          <h3>{t('providers.s.behaviour')}</h3>
        </div>
        <NumberField label={t('providers.f.concurrency')} hint={t('providers.f.concurrency_hint')} value={d.max_concurrency} onChange={v => set('max_concurrency', v)} placeholder={t('common.unlimited')} />
        <NumberField label={t('providers.f.first_byte')} hint={t('providers.f.first_byte_hint')} value={d.first_byte_timeout_ms} onChange={v => set('first_byte_timeout_ms', v)} placeholder="300000" />
        <NumberField label={t('providers.f.idle')} hint={t('providers.f.idle_hint')} value={d.idle_timeout_ms} onChange={v => set('idle_timeout_ms', v)} placeholder="120000" />
        {d.type === 'anthropic' ? <NumberField label={t('providers.f.default_max')} hint={t('providers.f.default_max_hint')} value={d.default_max_tokens} onChange={v => set('default_max_tokens', v)} placeholder="4096" /> : <div />}
        <SwitchField label={t('providers.f.auto_enable')} hint={t('providers.f.auto_enable_hint')} checked={d.auto_enable_models} onChange={v => set('auto_enable_models', v)} />
        {d.type === 'openai' ? <SwitchField label={t('providers.f.stream_usage')} hint={t('providers.f.stream_usage_hint')} checked={d.stream_usage} onChange={v => set('stream_usage', v)} /> : <div />}
        {mode === 'edit' ? <SwitchField label={t('providers.f.enabled')} hint={t('providers.f.enabled_hint')} checked={d.enabled} onChange={v => set('enabled', v)} /> : null}

        <div className="form-sep span-2">
          <h3>{t('providers.s.machine')}</h3>
          <p className="field-hint">{t('providers.s.machine_hint')}</p>
        </div>
        <SwitchField className="span-2" label={t('providers.f.is_node')} checked={d.is_node} onChange={v => set('is_node', v)} />
        {d.is_node ? (
          <>
            <TextField className="span-2" label={t('providers.f.control_url')} hint={t('providers.f.control_url_hint')} value={d.control_url} onChange={e => set('control_url', e.target.value)} placeholder="http://pc.lan:3001" spellCheck={false} />
            <TextField label={t('providers.f.mac')} value={d.mac} onChange={e => set('mac', e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" error={err('mac', t('providers.f.mac_error'))} spellCheck={false} />
            <TextField label={t('providers.f.broadcast')} hint={t('providers.f.broadcast_hint')} value={d.broadcast} onChange={e => set('broadcast', e.target.value)} placeholder="192.168.1.255" error={err('broadcast', t('providers.f.broadcast_error'))} spellCheck={false} />
            <NumberField label={t('providers.f.idle_shutdown')} hint={t('providers.f.idle_shutdown_hint')} value={d.idle_shutdown_minutes} onChange={v => set('idle_shutdown_minutes', v)} placeholder={t('common.off')} error={err('idle', t('providers.f.idle_shutdown_error'))} />
            <NumberField label={t('providers.f.min_wake')} hint={t('providers.f.min_wake_hint')} value={d.min_wake_priority} onChange={v => set('min_wake_priority', v)} min={1} max={5} />
            <NumberField label={t('providers.f.boot_timeout')} value={d.boot_timeout_ms} onChange={v => set('boot_timeout_ms', v)} />
            <NumberField label={t('providers.f.wol_port')} value={d.port} onChange={v => set('port', v)} />
          </>
        ) : null}
      </div>

      <details className="advanced">
        <summary>{t('providers.s.advanced')}</summary>
        <div className="form-grid">
          <TextField label={t('providers.f.models_path')} value={d.models_path} onChange={e => set('models_path', e.target.value)} placeholder="/models" spellCheck={false} />
          <TextField label={t('providers.f.chat_path')} value={d.chat_path} onChange={e => set('chat_path', e.target.value)} placeholder="/chat/completions" spellCheck={false} />
          <TextField label={t('providers.f.embeddings_path')} value={d.embeddings_path} onChange={e => set('embeddings_path', e.target.value)} placeholder="/embeddings" spellCheck={false} />
          {d.is_node ? (
            <>
              <TextField label={t('providers.f.health_url')} hint={t('providers.f.health_url_hint')} value={d.health_url} onChange={e => set('health_url', e.target.value)} spellCheck={false} />
              <TextField label={t('providers.f.shutdown_url')} hint={t('providers.f.shutdown_url_hint')} value={d.shutdown_url} onChange={e => set('shutdown_url', e.target.value)} spellCheck={false} />
              <NumberField label={t('providers.f.poll')} value={d.poll_interval_ms} onChange={v => set('poll_interval_ms', v)} />
            </>
          ) : null}
          <div className="span-2 stack">
            <h3>{t('providers.f.headers')}</h3>
            <p className="field-hint">{t('providers.f.headers_hint')}</p>
            {d.headers.map((h, i) => (
              <div key={i} className="row header-row">
                <input aria-label={t('providers.f.header_name')} placeholder="X-Title" value={h.name} onChange={e => set('headers', d.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} spellCheck={false} />
                <input aria-label={t('providers.f.header_value')} placeholder="MindGate" value={h.value} onChange={e => set('headers', d.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} spellCheck={false} />
                <Button size="sm" variant="ghost" onClick={() => set('headers', d.headers.filter((_, j) => j !== i))} aria-label={t('common.remove')}>
                  ×
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" onClick={() => set('headers', [...d.headers, { name: '', value: '' }])}>
                {t('providers.f.add_header')}
              </Button>
            </div>
          </div>
        </div>
      </details>
    </Dialog>
  );
}
