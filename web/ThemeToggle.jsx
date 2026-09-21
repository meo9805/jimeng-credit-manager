import { useSyncExternalStore } from 'react';
import { Sun, Moon } from 'lucide-react';
import { getTheme, setTheme, subscribeTheme } from './theme.js';
import './theme-control.css';

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribeTheme, getTheme, () => 'light');
  return <div className="theme-toggle" role="group" aria-label="界面主题">
    <span className="theme-toggle-indicator" style={{ transform: `translateX(${theme === 'dark' ? 100 : 0}%)` }} aria-hidden="true" />
    {[{ value: 'light', label: '浅色', icon: Sun }, { value: 'dark', label: '暗色', icon: Moon }].map(({ value, label, icon: Icon }) => <button key={value} type="button" className={theme === value ? 'active' : ''} aria-pressed={theme === value} aria-label={`${label}主题`} onClick={() => setTheme(value)}><Icon size={14} aria-hidden="true" /><span>{label}</span></button>)}
  </div>;
}
