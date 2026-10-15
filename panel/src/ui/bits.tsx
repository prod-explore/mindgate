import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isApiError } from '../api/client';
import type { Locality, ProviderStatus } from '../api/types';
import { useT, type Key } from '../i18n';
import { cx } from '../lib/cx';
import { describeError } from '../lib/errors';
import { Button } from './Button';

export type BadgeTone = 'neutral' | 'local' | 'cloud' | 'ok' | 'warn' | 'bad';

export const Badge = ({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) => (
  <span className={cx('badge', `badge-${tone}`)} title={title}>
    {children}
  </span>
);

export function LocalityBadge({ locality }: { locality: Locality }) {
  const t = useT();
  return <Badge tone={locality}>{t(locality === 'local' ? 'locality.local' : 'locality.cloud')}</Badge>;
}

const STATUS_KEY: Record<ProviderStatus, Key> = {
  online: 'status.online',
  disabled: 'status.disabled',
  asleep: 'status.asleep',
  waking: 'status.waking',
  unknown: 'status.unknown',
};

/** A dot and a word: colour alone never carries the state. */
export function Status({ status, label }: { status: ProviderStatus; label?: string }) {
  const t = useT();
  const text = label ?? t(STATUS_KEY[status]);
  return (
    <span className={cx('status', `status-${status}`)}>
      <span className="status-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/** `openrouter/deepseek/deepseek-chat`, with the provider part set back a little. */
/** `short` leaves out the provider, for a list that is already about one provider. */
export function ModelId({ id, className, short }: { id: string; className?: string; short?: boolean }) {
  const i = id.indexOf('/');
  return (
    <span className={cx('mono mid', className)}>
      {i > 0 && !short ? <span className="mid-provider">{id.slice(0, i + 1)}</span> : null}
      {i > 0 ? id.slice(i + 1) : id}
    </span>
  );
}

export function Meter({ value, max, label, tone }: { value: number; max: number; label: string; tone?: 'ok' | 'warn' | 'bad' | 'local' | 'cloud' | 'neutral' }) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const auto = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : 'ok';
  return (
    <div className={cx('meter', `meter-${tone ?? auto}`)} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(value, max)}>
      <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
    </div>
  );
}

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="empty">
    <p className="empty-title">{title}</p>
    {children ? <div className="empty-body">{children}</div> : null}
  </div>
);

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="note note-bad" role="alert">
      <div>
        <strong>{t('common.something_failed')}</strong> {describeError(error)}
        {isApiError(error) && error.code !== 'network' ? <span className="mono note-code"> {error.code}</span> : null}
      </div>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}

export const Note = ({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'bad' | 'ok'; children: ReactNode }) => (
  <div className={cx('note', `note-${tone}`)} role={tone === 'bad' ? 'alert' : undefined}>
    <div>{children}</div>
  </div>
);

export const Loading = () => {
  const t = useT();
  return (
    <p className="loading" role="status">
      {t('common.loading')}
    </p>
  );
};

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const t = useT();
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1800);
  };
  return (
    <Button size="sm" onClick={() => void copy()}>
      {done ? t('common.copied') : (label ?? t('common.copy'))}
    </Button>
  );
}

export function PageHeader({ title, children, sub }: { title: string; children?: ReactNode; sub?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub ? <p className="page-sub">{sub}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}
