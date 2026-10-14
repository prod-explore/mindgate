import { useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { useT } from '../i18n';
import { cx } from '../lib/cx';

interface FieldFrameProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
  children: (id: string, describedBy: string | undefined) => ReactNode;
}

/** A label, the control, an optional hint, an optional error: wired together for screen readers. */
export function FieldFrame({ label, hint, error, className, children }: FieldFrameProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={cx('field', error && 'has-error', className)}>
      <label htmlFor={id}>{label}</label>
      {children(id, hintId)}
      {error ? (
        <p id={hintId} className="field-error">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

interface CommonProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  className?: string;
}

export function TextField({ label, hint, error, className, ...rest }: CommonProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'className'>) {
  return <FieldFrame label={label} hint={hint} error={error} className={className}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={error ? true : undefined} {...rest} />}</FieldFrame>;
}

interface NumberFieldProps extends CommonProps {
  value: number | null;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
}

/** Empty means "not set" (`null`): no limit, the provider's default, … */
export function NumberField({ label, hint, error, className, value, onChange, min, max, placeholder, disabled }: NumberFieldProps) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [last, setLast] = useState(value);
  // follow changes made from outside (a reset button), but not our own typing
  if (last !== value) {
    setLast(value);
    if ((text === '' ? null : Number(text)) !== value) setText(value === null ? '' : String(value));
  }
  return (
    <FieldFrame label={label} hint={hint} error={error} className={className}>
      {(id, d) => (
        <input
          id={id}
          aria-describedby={d}
          aria-invalid={error ? true : undefined}
          inputMode="numeric"
          value={text}
          min={min}
          max={max}
          placeholder={placeholder}
          disabled={disabled}
          onChange={e => {
            const v = e.target.value.trim();
            setText(e.target.value);
            if (v === '') {
              setLast(null);
              onChange(null);
              return;
            }
            const n = Number(v);
            if (Number.isFinite(n)) {
              setLast(n);
              onChange(n);
            }
          }}
        />
      )}
    </FieldFrame>
  );
}

export function SelectField({ label, hint, error, className, children, ...rest }: CommonProps & Omit<SelectHTMLAttributes<HTMLSelectElement>, 'className'>) {
  return <FieldFrame label={label} hint={hint} error={error} className={className}>{(id, d) => <select id={id} aria-describedby={d} {...rest}>{children}</select>}</FieldFrame>;
}

export function TextAreaField({ label, hint, error, className, ...rest }: CommonProps & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'className'>) {
  return <FieldFrame label={label} hint={hint} error={error} className={className}>{(id, d) => <textarea id={id} aria-describedby={d} rows={3} {...rest} />}</FieldFrame>;
}

interface SwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function SwitchField({ label, checked, onChange, hint, disabled, className }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx('field field-switch', className)}>
      <label className="switch" htmlFor={id}>
        <input id={id} type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
        <span className="switch-track" aria-hidden="true" />
        <span className="switch-label">{label}</span>
      </label>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

/** A switch without a text label, for table rows (the label is for screen readers). */
export function RowSwitch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <label className="switch switch-bare">
      <input type="checkbox" role="switch" aria-label={label} title={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="switch-track" aria-hidden="true" />
    </label>
  );
}

interface TagsFieldProps extends CommonProps {
  value: string[];
  onChange: (tags: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
}

const clean = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

/** Type a tag, press Enter or comma. */
export function TagsField({ label, hint, error, className, value, onChange, suggestions = [], placeholder }: TagsFieldProps) {
  const t = useT();
  const [draft, setDraft] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const tag = clean(raw);
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && draft === '' && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <FieldFrame label={label} hint={hint} error={error} className={className}>
      {(id, d) => (
        <div className="tags-input">
          {value.map(tag => (
            <span key={tag} className="chip">
              {tag}
              <button type="button" onClick={() => onChange(value.filter(x => x !== tag))} aria-label={t('common.remove_item', { item: tag })}>
                ×
              </button>
            </span>
          ))}
          <input id={id} aria-describedby={d} list={suggestions.length ? listId : undefined} value={draft} placeholder={value.length ? '' : placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={onKey} onBlur={() => add(draft)} />
          {suggestions.length ? (
            <datalist id={listId}>
              {suggestions.filter(s => !value.includes(s)).map(s => (
                <option key={s} value={s} />
              ))}
            </datalist>
          ) : null}
        </div>
      )}
    </FieldFrame>
  );
}
