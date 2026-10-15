import { useState } from 'react';
import { useApi } from '../api/context';
import { useT } from '../i18n';
import { useQuery } from '../lib/query';
import { href } from '../lib/router';
import { Button } from '../ui/Button';
import { Empty, ErrorNote, Loading, LocalityBadge, PageHeader, Status } from '../ui/bits';
import { AddModel, ModelsView } from './Models';
import { NodeDetail } from './Nodes';

/** One provider: its models (and, for a machine with an agent, the machine itself). Managing the provider is on the list. */
export function ProviderPage({ id }: { id: string }) {
  const t = useT();
  const api = useApi();
  const list = useQuery(s => api.providers.list(s), [], { every: 5000 });
  const [adding, setAdding] = useState(false);
  const [rev, setRev] = useState(0);
  const provider = list.data?.find(p => p.id === id);

  if (list.loading) return <Loading />;
  if (list.error && !list.data) return <ErrorNote error={list.error} onRetry={() => void list.reload()} />;
  if (!provider) {
    return (
      <>
        <PageHeader title={id}>
          <a className="btn" href={href(['providers'])}>
            {t('provider.all')}
          </a>
        </PageHeader>
        <Empty title={t('provider.not_found')}>{t('provider.not_found_hint')}</Empty>
      </>
    );
  }
  if (provider.node) return <NodeDetail id={id} />;

  return (
    <>
      <PageHeader
        title={provider.name}
        sub={
          <>
            <span className="mono">{id}</span> <LocalityBadge locality={provider.locality} /> <Status status={provider.status} />
          </>
        }
      >
        <a className="btn" href={href(['providers'])}>
          {t('provider.all')}
        </a>
      </PageHeader>

      <ModelsView key={rev} scope={id} />

      <details className="advanced">
        <summary>{t('provider.advanced')}</summary>
        <p className="section-sub">{t('models.add_hint')}</p>
        <Button onClick={() => setAdding(true)}>{t('models.add')}</Button>
      </details>
      {adding ? (
        <AddModel
          providers={[provider]}
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setRev(n => n + 1);
          }}
        />
      ) : null}
    </>
  );
}
