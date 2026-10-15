import { useT } from '../i18n';
import { useTheme, type ThemeChoice } from '../lib/theme';

/** Colour theme: one small select, used on the login screen and in the sidebar. */
export function Preferences() {
  const t = useT();
  const [theme, setTheme] = useTheme();
  return (
    <div className="prefs">
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
