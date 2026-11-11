import { ChevronDown, Download, ScrollText, TriangleAlert } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Button, Segmented, cx, downloadBlob } from '../components/ui';

const ERROR_RE = /^(fatal:|failed:|ERROR! |\[ERROR\])/;

function lineClass(line: string): string | undefined {
  if (line.startsWith('PLAY RECAP')) return 'log__play';
  if (line.startsWith('PLAY [')) return 'log__play';
  if (line.startsWith('TASK [')) return 'log__task';
  if (line.startsWith('ok:')) return 'log__ok';
  if (line.startsWith('changed:')) return 'log__changed';
  if (line.startsWith('skipping:')) return 'log__skip';
  if (line.startsWith('included:')) return 'log__skip';
  if (ERROR_RE.test(line)) return 'log__err';
  if (line === '...ignoring') return 'log__skip';
  if (/^\S+\s+: ok=\d+/.test(line)) return /failed=[1-9]/.test(line) ? 'log__err' : 'log__ok';
  return undefined;
}

const LogLines = memo(function LogLines({ text, errorsOnly }: { text: string; errorsOnly: boolean }) {
  const lines = useMemo(() => {
    const all = text.split('\n');
    if (!errorsOnly) return all.map((line, i) => ({ line, i }));
    // Failures that ansible was told to ignore are not errors.
    return all.map((line, i) => ({ line, i })).filter(({ line, i }) => ERROR_RE.test(line) && all[i + 1] !== '...ignoring');
  }, [text, errorsOnly]);
  if (errorsOnly && lines.length === 0) return <span className="log__skip">No errors in this log.</span>;
  return (
    <>
      {lines.map(({ line, i }) => (
        <span key={i} className={lineClass(line)}>
          {line}
          {'\n'}
        </span>
      ))}
    </>
  );
});

/**
 * The range's Ansible log, followed live the way `ludus range logs -f` does:
 * poll with a cursor and append what is new.
 */
export function LogDrawer({ rangeId, open, onToggle, live }: { rangeId: string; open: boolean; onToggle: () => void; live: boolean }) {
  const [text, setText] = useState('');
  const [missing, setMissing] = useState(false);
  const [mode, setMode] = useState<'all' | 'errors'>('all');
  const [follow, setFollow] = useState(true);
  const cursor = useRef<number | undefined>(undefined);
  const scroller = useRef<HTMLPreElement>(null);

  useEffect(() => {
    cursor.current = undefined;
    setText('');
  }, [rangeId]);

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const previous = cursor.current;
        const res = await api.logs(rangeId, previous);
        if (stopped) return;
        setMissing(false);
        // A cursor past the end means a new run replaced the log: the server sends it whole.
        if (previous === undefined || res.cursor < previous) setText(res.result);
        else if (res.result) setText((current) => current + res.result);
        cursor.current = res.cursor;
      } catch {
        if (!stopped) setMissing(true);
      }
      if (!stopped) timer = setTimeout(tick, live ? 900 : 5000);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, rangeId, live]);

  useEffect(() => {
    const el = scroller.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [text, follow, mode, open]);

  const errorCount = useMemo(() => {
    const lines = text.split('\n');
    return lines.filter((line, i) => ERROR_RE.test(line) && lines[i + 1] !== '...ignoring').length;
  }, [text]);

  return (
    <section className={cx('logdrawer', open && 'logdrawer--open')} aria-label="Deployment log">
      <div className="logdrawer__head">
        <button type="button" className="logdrawer__toggle" onClick={onToggle} aria-expanded={open}>
          <ScrollText size={15} />
          <span>Logs</span>
          {live ? <span className="dot dot--warn dot--pulse" /> : null}
          {errorCount > 0 ? (
            <span className="badge badge--err">
              <TriangleAlert />
              {errorCount}
            </span>
          ) : null}
          <ChevronDown size={15} className="logdrawer__chevron" />
        </button>
        {open ? (
          <div className="row">
            <Segmented
              label="Show"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'all', label: 'Everything' },
                { value: 'errors', label: 'Errors' },
              ]}
            />
            <label className="row text-sm muted">
              <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
            </label>
            <Button size="sm" variant="ghost" icon tip="Download log" tipPos="left" disabled={!text} onClick={() => downloadBlob(`${rangeId}-ansible.log`, text)}>
              <Download />
            </Button>
          </div>
        ) : null}
      </div>
      {open ? (
        <pre
          ref={scroller}
          className="log"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
            if (atBottom !== follow) setFollow(atBottom);
          }}
        >
          {missing && !text ? <span className="log__skip">Nothing has run in this range yet. Deploy it to see the log here.</span> : <LogLines text={text} errorsOnly={mode === 'errors'} />}
        </pre>
      ) : null}
    </section>
  );
}
