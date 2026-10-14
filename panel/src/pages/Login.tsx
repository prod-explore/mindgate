import { useState } from 'react';
import { createApi } from '../api/client';
import { useT } from '../i18n';
import { describeError } from '../lib/errors';
import { signIn } from '../lib/session';
import { Button } from '../ui/Button';
import { TextField, SwitchField } from '../ui/fields';
import { Note } from '../ui/bits';
import { BrandMark } from '../ui/Brand';
import { Preferences } from '../ui/Preferences';

export function Login({ expired }: { expired: boolean }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const submit = async () => {
    const candidate = token.trim();
    if (!candidate) return;
    setChecking(true);
    setError(null);
    try {
      // ask with the candidate token without touching the app's own session yet
      await createApi({ token: () => candidate }).status();
      signIn(candidate, remember);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setChecking(false);
    }
  };

  return (
    <main className="login">
      <form
        className="login-card"
        onSubmit={e => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1>
          <BrandMark />
          {t('login.title')}
        </h1>
        {expired && !error ? <Note tone="warn">{t('login.expired')}</Note> : null}
        {error ? <Note tone="bad">{error}</Note> : null}
        <TextField label={t('login.token')} hint={t('login.token_hint')} type="password" autoComplete="current-password" autoFocus value={token} onChange={e => setToken(e.target.value)} spellCheck={false} />
        <SwitchField label={t('login.remember')} hint={t('login.remember_hint')} checked={remember} onChange={setRemember} />
        <Button type="submit" variant="primary" pending={checking} disabled={!token.trim()}>
          {checking ? t('login.checking') : t('login.submit')}
        </Button>
        <Preferences />
      </form>
    </main>
  );
}
