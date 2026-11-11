import { useEffect } from 'react';
import { create } from 'zustand';
import { HttpError, type Meta, type RangeDetail, type Session, api, hasToken, onUnauthorized, setToken } from './api';
import { navigate } from './router';

interface AppState {
  /** `undefined` while the first session check runs. */
  session: Session | null | undefined;
  meta: Meta | null;
  detail: RangeDetail | null;
  detailFor: string | null;
  detailError: string | null;
  signIn: (login: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  loadSession: () => Promise<void>;
  loadMeta: () => Promise<void>;
  loadDetail: (rangeID: string) => Promise<void>;
  /** Re-reads everything that a change to a range can affect. */
  refresh: (rangeID: string | null) => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  session: hasToken() ? undefined : null,
  meta: null,
  detail: null,
  detailFor: null,
  detailError: null,

  signIn: async (login, password) => {
    const result = await api.login(login, password);
    setToken(result.token);
    set({ session: { user: result.user, defaultRangeID: result.defaultRangeID, ranges: result.ranges } });
    await get().loadMeta();
  },

  signOut: async () => {
    try {
      await api.logout();
    } catch {
      // The session ends locally either way.
    }
    setToken(null);
    set({ session: null, meta: null, detail: null, detailFor: null });
  },

  loadSession: async () => {
    if (!hasToken()) {
      set({ session: null });
      return;
    }
    try {
      set({ session: await api.session() });
    } catch (err) {
      if (err instanceof HttpError && err.status === 401) set({ session: null });
      else throw err;
    }
  },

  loadMeta: async () => {
    set({ meta: await api.meta() });
  },

  loadDetail: async (rangeID) => {
    try {
      const detail = await api.detail(rangeID);
      set({ detail, detailFor: rangeID, detailError: null });
    } catch (err) {
      set({ detailError: err instanceof Error ? err.message : String(err), detailFor: rangeID, detail: get().detailFor === rangeID ? get().detail : null });
    }
  },

  refresh: async (rangeID) => {
    await Promise.all([get().loadSession(), rangeID ? get().loadDetail(rangeID) : Promise.resolve()]);
  },
}));

onUnauthorized(() => useApp.setState({ session: null, meta: null, detail: null, detailFor: null }));

/** The range the UI is looking at: the one in the URL, else the user's default, else the first. */
export function useCurrentRangeId(routeRange: string | undefined): string | null {
  const session = useApp((s) => s.session);
  if (!session) return null;
  const ids = session.ranges.map((range) => range.rangeID);
  if (routeRange && ids.includes(routeRange)) return routeRange;
  if (session.defaultRangeID && ids.includes(session.defaultRangeID)) return session.defaultRangeID;
  return ids[0] ?? null;
}

/** Polls the range: fast while something is running, slower otherwise, paused while the tab is hidden. */
export function useRangePolling(rangeID: string | null): void {
  const loadDetail = useApp((s) => s.loadDetail);
  const loadSession = useApp((s) => s.loadSession);
  const busy = useApp((s) => Boolean(s.detail?.deploying) || s.detail?.range.rangeState === 'DESTROYING');
  useEffect(() => {
    if (!rangeID) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let ticks = 0;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') {
        await loadDetail(rangeID);
        if (++ticks % 5 === 0) await loadSession().catch(() => undefined);
      }
      if (!stopped) timer = setTimeout(tick, busy ? 900 : 4000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [rangeID, busy, loadDetail, loadSession]);
}

export function selectRange(rangeID: string): void {
  navigate({ rangeId: rangeID });
}
