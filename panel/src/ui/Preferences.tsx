import { LANGS, useLang, useT, type Lang } from '../i18n';
import { useTheme, type ThemeChoice } from '../lib/theme';

const LANG_NAME: Record<Lang, string> = { en: 'English', pl: 'Polski' };

/** Language and theme: two small selects, used on the login screen and in the sidebar. */
export function Preferences() {
  const t = useT();
  const [lang, setLang] = useLang();
  const [theme, setTheme] = useTheme();
  return (
    <div className="prefs">
      <label>
        <span className="visually-hidden">{t('app.language')}</span>
        <select value={lang} onChange={e => setLang(e.target.value as Lang)} aria-label={t('app.language')}>
          {LANGS.map(l => (
            <option key={l} value={l}>
              {LANG_NAME[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="visually-hidden">{t('app.theme')}</span>
        <select value={theme} onChange={e => setTheme(e.target.value as ThemeChoice)} aria-label={t('app.theme')}>
          <option value="system">{t('app.theme.system')}</option>
          <option value="light">{t('app.theme.light')}</option>
          <option value="dark">{t('app.theme.dark')}</option>
        </select>
      </label>
    </div>
  );
}
