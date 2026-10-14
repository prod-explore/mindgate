import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { cx } from '../lib/cx';
import { Button } from './Button';

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons at the bottom. */
  footer?: ReactNode;
  /** Makes the whole dialog a form that calls this on submit. */
  onSubmit?: () => void;
  size?: 'md' | 'lg';
  /** Closing while something is saving would lose the answer. */
  locked?: boolean;
}

/** A modal on the browser's own <dialog>: focus stays inside, Escape closes it, the page behind is inert. */
export function Dialog({ title, onClose, children, footer, onSubmit, size = 'md', locked }: DialogProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof el.showModal === 'function') {
      if (!el.open) el.showModal();
    } else {
      el.setAttribute('open', '');
    }
    return () => {
      if (el.open && typeof el.close === 'function') el.close();
    };
  }, []);

  const body = (
    <>
      <header className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <Button variant="ghost" size="sm" onClick={onClose} disabled={locked} aria-label={t('common.close')}>
          ×
        </Button>
      </header>
      <div className="dialog-body">{children}</div>
      {footer ? <footer className="dialog-foot">{footer}</footer> : null}
    </>
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit?.();
  };

  return createPortal(
    <dialog
      ref={ref}
      className={cx('dialog', size === 'lg' && 'dialog-lg')}
      aria-labelledby={titleId}
      onCancel={e => {
        e.preventDefault();
        if (!locked) onClose();
      }}
      onMouseDown={e => {
        // a click on the dimmed area (the dialog element itself, not its content) closes it
        if (e.target === e.currentTarget && !locked) onClose();
      }}
    >
      {onSubmit ? (
        <form onSubmit={submit} className="dialog-form">
          {body}
        </form>
      ) : (
        <div className="dialog-form">{body}</div>
      )}
    </dialog>,
    document.body,
  );
}
