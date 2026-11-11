import { useSyncExternalStore } from 'react';

export type TabId = 'view' | 'build';

export interface Route {
  tab: TabId;
  /** Selected range, from `?range=` in the hash. */
  rangeId?: string;
}

function parse(hash: string): Route {
  const [pathPart = '', queryPart = ''] = hash.replace(/^#\/?/, '').split('?');
  const tab: TabId = pathPart === 'build' ? 'build' : 'view';
  const rangeId = new URLSearchParams(queryPart).get('range') ?? undefined;
  return { tab, rangeId };
}

function format(route: Route): string {
  const query = route.rangeId ? `?range=${encodeURIComponent(route.rangeId)}` : '';
  return `#/${route.tab}${query}`;
}

let cached: { hash: string; route: Route } | undefined;

function snapshot(): Route {
  const hash = window.location.hash;
  if (!cached || cached.hash !== hash) cached = { hash, route: parse(hash) };
  return cached.route;
}

function subscribe(fn: () => void): () => void {
  window.addEventListener('hashchange', fn);
  return () => window.removeEventListener('hashchange', fn);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, snapshot);
}

export function navigate(patch: Partial<Route>, options: { replace?: boolean } = {}): void {
  const next = format({ ...snapshot(), ...patch });
  if (next === window.location.hash) return;
  if (options.replace) {
    window.history.replaceState(null, '', next);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = next;
  }
}
