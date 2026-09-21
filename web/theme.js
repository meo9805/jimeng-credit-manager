const THEME_KEY = 'jimeng-manager-theme';
const THEME_EVENT = 'jimeng-theme-change';
const normalizeTheme = value => value === 'dark' ? 'dark' : 'light';

export function getTheme() { return normalizeTheme(document.documentElement.dataset.theme); }

export function setTheme(value, { persist = true } = {}) {
  const theme = normalizeTheme(value);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.documentElement.style.backgroundColor = theme === 'dark' ? '#101722' : '#f5f7fa';
  if (theme === 'dark') document.body.setAttribute('theme-mode', 'dark');
  else document.body.removeAttribute('theme-mode');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101722' : '#f5f7fa');
  if (persist) { try { localStorage.setItem(THEME_KEY, theme); } catch {} }
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeTheme(callback) {
  const onStorage = event => { if (event.key === THEME_KEY || event.key === null) setTheme(event.newValue, { persist: false }); };
  window.addEventListener(THEME_EVENT, callback);
  window.addEventListener('storage', onStorage);
  return () => { window.removeEventListener(THEME_EVENT, callback); window.removeEventListener('storage', onStorage); };
}
