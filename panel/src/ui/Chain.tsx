import type { Locality, Model } from '../api/types';
import { useT } from '../i18n';
import { cx } from '../lib/cx';

interface ChainProps {
  /** Canonical model ids in the order they are tried. */
  targets: string[];
  models: Map<string, Model>;
  /** Shown first, before the first hop. */
  name?: string;
}

/**
 * The picture of an alias: the request goes to the first model; if that fails, on to the next.
 * A hop is amber when the model runs on your own hardware and steel blue when it runs at a provider.
 */
export function Chain({ targets, models, name }: ChainProps) {
  const t = useT();
  if (targets.length === 0) return <p className="chain-empty">{t('aliases.no_targets')}</p>;
  return (
    <ol className="chain" aria-label={name ? t('aliases.chain_label', { name }) : undefined}>
      {targets.map((id, i) => {
        const m = models.get(id);
        const loc: Locality | 'missing' = m ? m.locality : 'missing';
        const off = m ? !m.enabled : false;
        const slash = id.indexOf('/');
        return (
          <li key={`${id}-${i}`} className="chain-item">
            {i > 0 ? (
              <span className="chain-link" aria-hidden="true" title={t('aliases.if_fails')}>
                <svg viewBox="0 0 28 12" width="28" height="12">
                  <path d="M1 6h22M19 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
                </svg>
              </span>
            ) : null}
            <span className={cx('hop', `hop-${loc}`, off && 'hop-off')} title={m ? (off ? t('aliases.hop_disabled') : t(loc === 'local' ? 'locality.local_title' : 'locality.cloud_title')) : t('aliases.hop_missing')}>
              <span className="hop-order">{i === 0 ? t('aliases.first') : t('aliases.then')}</span>
              <span className="hop-id mono">
                {slash > 0 ? <span className="mid-provider">{id.slice(0, slash + 1)}</span> : null}
                {slash > 0 ? id.slice(slash + 1) : id}
              </span>
              {!m ? <span className="hop-note">{t('aliases.hop_missing')}</span> : off ? <span className="hop-note">{t('aliases.hop_disabled')}</span> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
