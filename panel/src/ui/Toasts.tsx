import { useT } from '../i18n';
import { useStore } from '../lib/store';
import { dismiss, toasts } from '../lib/toast';

export function Toasts() {
  const t = useT();
  const list = useStore(toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map(item => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          <span>{item.text}</span>
          <button type="button" className="toast-x" onClick={() => dismiss(item.id)} aria-label={t('common.close')}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
