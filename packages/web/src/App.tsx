import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react';
import { useEffect } from 'react';
import { BuildTab } from './build/BuildTab';
import { Login } from './components/Login';
import { TopBar } from './components/TopBar';
import { cx } from './components/ui';
import { navigate, useRoute } from './lib/router';
import { useApp, useCurrentRangeId, useRangePolling } from './lib/store';
import { useToasts } from './lib/toast';
import { ViewTab } from './view/ViewTab';

function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone !== 'info' && `toast--${t.tone}`)}>
          {t.tone === 'ok' ? <CircleCheck className="text-ok" size={16} /> : t.tone === 'err' ? <CircleX className="text-err" size={16} /> : t.tone === 'warn' ? <TriangleAlert className="text-warn" size={16} /> : <Info size={16} />}
          <div className="grow">
            <div className="toast__title">{t.title}</div>
            {t.body ? <div className="toast__body">{t.body}</div> : null}
          </div>
          <button type="button" className="btn btn--ghost btn--icon btn--sm" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X />
          </button>
        </div>
      ))}
    </div>
  );
}

export function App() {
  const session = useApp((s) => s.session);
  const meta = useApp((s) => s.meta);
  const loadSession = useApp((s) => s.loadSession);
  const loadMeta = useApp((s) => s.loadMeta);
  const route = useRoute();
  const rangeId = useCurrentRangeId(route.rangeId);

  useEffect(() => {
    void loadSession().catch(() => undefined);
  }, [loadSession]);
  useEffect(() => {
    if (session && !meta) void loadMeta().catch(() => undefined);
  }, [session, meta, loadMeta]);
  useEffect(() => {
    // Keep the URL pointing at the range being shown, so it can be bookmarked.
    if (session && rangeId && route.rangeId !== rangeId) navigate({ rangeId }, { replace: true });
  }, [session, rangeId, route.rangeId]);

  useRangePolling(session ? rangeId : null);

  if (session === undefined) {
    return (
      <div className="splash">
        <span className="spinner" />
      </div>
    );
  }
  if (session === null) {
    return (
      <>
        <Login />
        <Toasts />
      </>
    );
  }
  return (
    <div className="shell">
      <TopBar rangeId={rangeId} tab={route.tab} />
      <main className="shell__main">
        {!rangeId ? (
          <div className="empty">
            <div className="empty__title">No ranges yet</div>
            <p>Create a range from the range menu at the top to get started.</p>
          </div>
        ) : route.tab === 'build' ? (
          <BuildTab key={rangeId} rangeId={rangeId} />
        ) : (
          <ViewTab key={rangeId} rangeId={rangeId} />
        )}
      </main>
      <Toasts />
    </div>
  );
}
