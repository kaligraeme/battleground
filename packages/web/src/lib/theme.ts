import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'battleground.theme';
const listeners = new Set<() => void>();

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function currentTheme(): Theme {
  const explicit = document.documentElement.dataset.theme;
  return explicit === 'light' || explicit === 'dark' ? explicit : systemTheme();
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); the theme still applies for this visit.
  }
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', fn);
  return () => {
    listeners.delete(fn);
    media.removeEventListener('change', fn);
  };
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  return [theme, setTheme];
}
