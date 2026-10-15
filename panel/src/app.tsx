import { useEffect, useState, type ReactNode } from 'react';
import type { Provider } from './api/types';
import { useApi } from './api/context';
import { useT, type Key } from './i18n';
import { duration } from './lib/format';
import { HubContext } from './lib/hub';
import { href, replaceQuery, useRoute } from './lib/router';
import { useQuery } from './lib/query';
import { signOut, useSession } from './lib/session';
import { Aliases } from './pages/Aliases';
import { Keys } from './pages/Keys';
import { Log } from './pages/Log';
import { Login } from './pages/Login';
import { Models } from './pages/Models';
import { Overview } from './pages/Overview';
import { ProviderPage } from './pages/ProviderPage';
import { Providers } from './pages/Providers';
import { Usage } from './pages/Usage';
import { BrandMark } from './ui/Brand';
import { Button } from './ui/Button';
import { ConfirmProvider } from './ui/Confirm';
import { Preferences } from './ui/Preferences';
import { Toasts } from './ui/Toasts';
import { Empty } from './ui/bits';

interface NavItem {
  page: string;
  label: Key;
  count?: 'providers' | 'models' | 'aliases' | 'keys';
}

const NAV: Array<{ group: Key; items: NavItem[] }> = [
  { group: 'nav.group.setup', items: [
    { page: 'providers', label: 'nav.providers', count: 'providers' },
    { page: 'aliases', label: 'nav.aliases', count: 'aliases' },
    { page: 'keys', label: 'nav.keys', count: 'keys' },
  ] },
  { group: 'nav.group.traffic', items: [
    { page: 'usage', label: 'nav.usage' },
    { page: 'log', label: 'nav.log' },
  ] },
];

const PAGES: Record<string, () => ReactNode> = {
  '': () => <Overview />,
  providers: () => <ProvidersRoute />,
  nodes: () => <Moved />,
  models: () => <Models />,
  aliases: () => <Aliases />,
  keys: () => <Keys />,
  usage: () => <Usage />,
  log: () => <Log />,
};

const TITLE: Record<string, Key> = {
  '': 'nav.overview',
  providers: 'nav.providers',
  nodes: 'nav.providers',
  models: 'nav.models',
  aliases: 'nav.aliases',
  keys: 'nav.keys',
  usage: 'nav.usage',
  log: 'nav.log',
};

function ProvidersRoute() {
  const id = useRoute().segments[1];
  return id ? <ProviderPage id={id} /> : <Providers />;
}

/** Machines used to have a page of their own; old addresses go to the provider's page. */
function Moved() {
  const rest = useRoute().segments.slice(1);
  useEffect(() => replaceQuery(['providers', ...rest], {}));
  return null;
}

/** "Providers" in the menu opens into the list of them; each one's page holds its models. */
function ProvidersNav({ active, id, count, list }: { active: boolean; id: string | undefined; count: number | undefined; list: Provider[] }) {
  const t = useT();
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? active;
  return (
    <>
      <div className="nav-parent">
        <a href={href(['providers'])} aria-current={active && !id ? 'page' : undefined}>
          {t('nav.providers')}
          {count !== undefined ? <span className="nav-count">{count}</span> : null}
        </a>
        <button type="button" className="nav-toggle" aria-expanded={open} aria-label={t('nav.show_providers')} onClick={() => setManual(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        </button>
      </div>
      {open ? (
        <div className="nav-sub">
          {list.map(p => (
            <a key={p.id} href={href(['providers', p.id])} aria-current={id === p.id ? 'page' : undefined}>
              {p.name}
            </a>
          ))}
        </div>
      ) : null}
    </>
  );
}

export function App() {
  const session = useSession();
  if (!session.token) return <Login expired={session.expired} />;
  return (
    <ConfirmProvider>
      <Shell />
      <Toasts />
    </ConfirmProvider>
  );
}

function Shell() {
  const t = useT();
  const api = useApi();
  const route = useRoute();
  const page = route.segments[0] ?? '';
  const [open, setOpen] = useState(false);
  const status = useQuery(s => api.status(s), [], { every: 15_000 });
  const providers = useQuery(s => api.providers.list(s), [], { every: 15_000 });

  // close the mobile menu after navigating, and say where we are in the tab title
  useEffect(() => setOpen(false), [page]);
  const known = page in PAGES;
  const titleKey = TITLE[page];
  useEffect(() => {
    document.title = `${titleKey ? t(titleKey) : t('app.not_found')} – MindGate`;
  });

  const counts = status.data?.counts;
  const render = PAGES[page];

  return (
    <div className="app">
      <div className="topbar">
        <a className="brand" href={href([])}>
          <BrandMark />
          MindGate
        </a>
        <Button size="sm" aria-expanded={open} aria-controls="sidebar" onClick={() => setOpen(o => !o)}>
          {t('nav.menu')}
        </Button>
      </div>
      <aside id="sidebar" className={`side${open ? ' is-open' : ''}`}>
        <a className="brand" href={href([])}>
          <BrandMark />
          MindGate
        </a>
        <nav className="nav" aria-label="Main">
          <a href={href([])} aria-current={page === '' ? 'page' : undefined}>
            {t('nav.overview')}
          </a>
          {NAV.map(g => (
            <div key={g.group} className="stack" style={{ gap: 1 }}>
              <p className="nav-group">{t(g.group)}</p>
              {g.items.map(item =>
                item.page === 'providers' ? (
                  <ProvidersNav key={item.page} active={page === 'providers'} id={route.segments[1]} count={counts?.providers} list={providers.data ?? []} />
                ) : (
                  <a key={item.page} href={href([item.page])} aria-current={page === item.page ? 'page' : undefined}>
                    {t(item.label)}
                    {item.count && counts ? <span className="nav-count">{counts[item.count]}</span> : null}
                  </a>
                ),
              )}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <Preferences />
          <div className="side-controls">
            <Button size="sm" variant="ghost" onClick={() => signOut()}>
              {t('app.sign_out')}
            </Button>
          </div>
          {status.data ? <span>{t('app.version', { version: status.data.version, uptime: duration(status.data.uptime_seconds) })}</span> : null}
        </div>
      </aside>
      <main className="main">
        <HubContext.Provider value={status.data}>
          <div className="main-inner">{known && render ? render() : <Empty title={t('app.not_found')}>{t('app.not_found_hint')}</Empty>}</div>
        </HubContext.Provider>
      </main>
    </div>
  );
}
