import { BUILTIN_BLUEPRINTS } from '@battleground/core';
import { Ban, Download, Hammer, KeyRound, Plus, RefreshCw, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type UserView, api } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../lib/store';
import { toast } from '../lib/toast';
import { OsGlyph } from './OsGlyph';
import { Badge, Button, CopyButton, Dialog, Field, Switch, downloadBlob } from './ui';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// New range
// ---------------------------------------------------------------------------

export function CreateRangeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useApp((s) => s.session);
  const refresh = useApp((s) => s.refresh);
  const [rangeID, setRangeID] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [blueprint, setBlueprint] = useState('basic-ad');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[A-Za-z][A-Za-z0-9_-]*$/.test(rangeID);

  const create = async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRange({ rangeID, name: name || rangeID, description, userIDs: [session.user.userID] });
      const chosen = BUILTIN_BLUEPRINTS.find((b) => b.id === blueprint);
      if (chosen) await api.setConfig(rangeID, chosen.config);
      await refresh(rangeID);
      toast.ok('Range created', `${rangeID} is ready to edit in the Build tab.`);
      navigate({ rangeId: rangeID, tab: 'build' });
      onClose();
      setRangeID('');
      setName('');
      setDescription('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New range"
      subtitle="A range is an isolated network with its own router, VLANs and machines."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} busy={busy} onClick={create}>
            <Plus />
            Create range
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="grid-2">
          <Field label="Range ID" hint="Letters, digits, - and _; starts with a letter. Used in machine names." htmlFor="new-range-id" error={rangeID && !valid ? 'Not a valid range ID' : undefined}>
            <input id="new-range-id" className="input input--mono" value={rangeID} onChange={(e) => setRangeID(e.target.value)} placeholder="LAB1" autoFocus />
          </Field>
          <Field label="Name" htmlFor="new-range-name">
            <input id="new-range-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Red team lab" />
          </Field>
        </div>
        <Field label="Description" htmlFor="new-range-desc">
          <input id="new-range-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="field">
          <span className="field__label">Start from</span>
          <div className="choice-grid">
            {BUILTIN_BLUEPRINTS.map((b) => (
              <button key={b.id} type="button" className="choice" aria-pressed={blueprint === b.id} onClick={() => setBlueprint(b.id)}>
                <span className="choice__title">{b.name}</span>
                <span className="choice__body">{b.description}</span>
              </button>
            ))}
          </div>
        </div>
        {error ? <div className="callout callout--err">{error}</div> : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function TemplatesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const meta = useApp((s) => s.meta);
  const loadMeta = useApp((s) => s.loadMeta);
  const [log, setLog] = useState('');
  const [name, setName] = useState('');
  const [os, setOs] = useState('linux');
  const cursor = useRef<number | undefined>(undefined);
  const logRef = useRef<HTMLPreElement>(null);
  const building = (meta?.buildStatus.length ?? 0) > 0 || meta?.templates.some((t) => t.status === 'building');

  useEffect(() => {
    if (!open) return;
    let stopped = false;
    cursor.current = undefined;
    setLog('');
    // Like Ludus, the server answers 500 until a first build has written a packer log; don't ask before then.
    let hasLog = false;
    const tick = async () => {
      await loadMeta().catch(() => undefined);
      if (!hasLog) {
        hasLog = (await api.templateHistory().catch(() => [])).length > 0;
        if (!hasLog) return;
      }
      try {
        const res = await api.templateLogs(cursor.current);
        if (!stopped && res.result) setLog((prev) => (cursor.current === undefined ? res.result : prev + res.result));
        cursor.current = res.cursor;
      } catch {
        // No build has run yet.
      }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, loadMeta]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  const run = async (fn: () => Promise<{ result: string }>) => {
    try {
      toast.info((await fn()).result);
      await loadMeta();
    } catch (err) {
      toast.err('Templates', errorText(err));
    }
  };

  const available = meta?.templates.filter((t) => t.available) ?? [];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      title="Templates"
      subtitle="Every machine is cloned from a template. Templates must be built before a range that uses them can be saved or deployed."
      flush
    >
      <div className="templates">
        <div className="templates__list">
          <div className="row row--wrap section">
            <Button variant="primary" size="sm" disabled={available.every((t) => t.built)} onClick={() => run(() => api.buildTemplates(['all']))}>
              <Hammer />
              Build all missing
            </Button>
            <Button size="sm" variant="danger" disabled={!building} onClick={() => run(() => api.abortBuilds())}>
              <Ban />
              Stop builds
            </Button>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Template</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {available.map((t) => (
                <tr key={t.name}>
                  <td>
                    <div className="row">
                      <OsGlyph os={t.os === 'other' ? undefined : t.os} />
                      <div className="grow">
                        <div className="truncate">{t.label}</div>
                        <div className="mono faint text-xs truncate">{t.name}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    {t.status === 'building' ? (
                      <Badge tone="warn">
                        <span className="dot dot--warn dot--pulse" />
                        Building
                      </Badge>
                    ) : t.built ? (
                      <Badge tone="ok">Built</Badge>
                    ) : (
                      <Badge>Not built</Badge>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!t.built && t.status !== 'building' ? (
                      <Button size="sm" onClick={() => run(() => api.buildTemplates([t.name]))}>
                        Build
                      </Button>
                    ) : null}{' '}
                    {t.built || !t.builtin ? (
                      <Button size="sm" variant="ghost" icon tip={t.builtin ? 'Remove the built image' : 'Delete template'} tipPos="left" onClick={() => run(() => api.deleteTemplate(t.name))}>
                        <Trash2 />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="section">
            <div className="section__title">Add a template</div>
            <div className="row row--wrap">
              <input className="input input--mono grow" style={{ minWidth: 180 }} placeholder="ubuntu-22.04-x64-server-template" value={name} onChange={(e) => setName(e.target.value)} />
              <select className="select" style={{ width: 120 }} value={os} onChange={(e) => setOs(e.target.value)} aria-label="Operating system">
                <option value="linux">Linux</option>
                <option value="windows">Windows</option>
                <option value="macos">macOS</option>
              </select>
              <Button
                disabled={!name.trim()}
                onClick={() =>
                  run(async () => {
                    const res = await api.addTemplate(name.trim(), os);
                    setName('');
                    return res;
                  })
                }
              >
                <Plus />
                Add
              </Button>
            </div>
            <p className="field__hint" style={{ marginTop: 6 }}>
              With the Ludus CLI you can also upload a Packer directory: <code>ludus templates add -d ./my-template</code>.
            </p>
          </div>
        </div>
        <div className="templates__log">
          <div className="panel__head">
            <span className="panel__title">Build log</span>
            {building ? <span className="spinner" /> : null}
          </div>
          <pre ref={logRef} className="log log--packer">
            {log || 'No template has been built yet.'}
          </pre>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Users (admin)
// ---------------------------------------------------------------------------

export function UsersDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useApp((s) => s.session);
  const refresh = useApp((s) => s.refresh);
  const [users, setUsers] = useState<UserView[]>([]);
  const [form, setForm] = useState({ userID: '', name: '', email: '', isAdmin: false });
  const [created, setCreated] = useState<{ userID: string; apiKey: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setUsers(await api.users());
    } catch (err) {
      toast.err('Users', errorText(err));
    }
  };
  useEffect(() => {
    if (open) {
      setCreated(null);
      void load();
    }
  }, [open]);

  const add = async () => {
    setBusy(true);
    try {
      const password = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[b % 57]).join('');
      const user = await api.addUser({ ...form, password });
      setCreated({ userID: user.userID, apiKey: user.apiKey, password });
      setForm({ userID: '', name: '', email: '', isAdmin: false });
      await load();
      await refresh(null);
    } catch (err) {
      toast.err('Could not add user', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} size="wide" title="Users" subtitle="Each user gets a VPN address, an API key and a default range of their own.">
      <div className="stack">
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>VPN address</th>
              <th>Last active</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.userID}>
                <td>
                  <div className="row">
                    <span className="mono">{u.userID}</span>
                    <span className="muted truncate">{u.name}</span>
                    {u.isAdmin ? <Badge tone="accent">Admin</Badge> : null}
                  </div>
                </td>
                <td className="mono">198.51.100.{u.userNumber}</td>
                <td className="faint">{new Date(u.dateLastActive).toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>
                  {u.userID !== session?.user.userID ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon
                      tip="Delete user and their default range"
                      tipPos="left"
                      onClick={async () => {
                        if (!window.confirm(`Delete ${u.userID} and their default range?`)) return;
                        try {
                          await api.deleteUser(u.userID, true);
                          await load();
                          await refresh(null);
                        } catch (err) {
                          toast.err('Could not delete user', errorText(err));
                        }
                      }}
                    >
                      <Trash2 />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="section__title">Add a user</div>
        <div className="grid-2">
          <Field label="User ID" hint="Up to 20 letters and digits, starting with a letter" htmlFor="u-id">
            <input id="u-id" className="input input--mono" value={form.userID} onChange={(e) => setForm({ ...form, userID: e.target.value })} placeholder="JS" />
          </Field>
          <Field label="Full name" htmlFor="u-name">
            <input id="u-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="John Smith" />
          </Field>
          <Field label="Email" htmlFor="u-email">
            <input id="u-email" className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </Field>
          <Field label="Administrator" row htmlFor="u-admin">
            <Switch id="u-admin" checked={form.isAdmin} onChange={(isAdmin) => setForm({ ...form, isAdmin })} />
          </Field>
        </div>
        <div className="row">
          <Button variant="primary" busy={busy} disabled={!form.userID || !form.name || !form.email} onClick={add}>
            <UserPlus />
            Add user
          </Button>
        </div>
        {created ? (
          <div className="callout callout--info">
            <KeyRound />
            <div className="stack stack--tight grow">
              <strong>{created.userID} was created. Share these now; they are not shown again.</strong>
              <div className="row">
                <span className="faint">Password</span>
                <code className="grow">{created.password}</code>
                <CopyButton text={created.password} iconOnly label="Copy password" />
              </div>
              <div className="row">
                <span className="faint">API key</span>
                <code className="grow truncate">{created.apiKey}</code>
                <CopyButton text={created.apiKey} iconOnly label="Copy API key" />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SPEEDS = [
  { value: 0, label: 'Instant' },
  { value: 600, label: '600×' },
  { value: 120, label: '120×' },
  { value: 60, label: '60×' },
  { value: 10, label: '10×' },
  { value: 1, label: 'Real time' },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const meta = useApp((s) => s.meta);
  const loadMeta = useApp((s) => s.loadMeta);
  const session = useApp((s) => s.session);
  const set = async (speed: number) => {
    try {
      await api.setSpeed(speed);
      await loadMeta();
    } catch (err) {
      toast.err('Settings', errorText(err));
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Settings">
      <div className="stack">
        <Field
          label="Simulation speed"
          hint="How much faster than reality simulated work runs. A full deploy of the starter range takes about an hour for real, one minute at 60×."
        >
          <div className="segmented" role="group" aria-label="Simulation speed">
            {SPEEDS.map((s) => (
              <button key={s.value} type="button" className="segmented__item" aria-pressed={meta?.speed === s.value} disabled={!session?.user.isAdmin} onClick={() => set(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </Field>
        {!session?.user.isAdmin ? <p className="faint text-sm">Only administrators can change the speed.</p> : null}
        <p className="faint text-sm">Battleground {meta?.version} · node {meta?.node}</p>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Account: API key, VPN profile, password
// ---------------------------------------------------------------------------

export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useApp((s) => s.session);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [wireguard, setWireguard] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  useEffect(() => {
    if (!open) return;
    setApiKey(null);
    api
      .wireguard()
      .then((res) => setWireguard(res.result.wireGuardConfig))
      .catch(() => setWireguard(null));
  }, [open]);
  if (!session) return null;
  const origin = window.location.origin;
  return (
    <Dialog open={open} onClose={onClose} size="wide" title="Account & access" subtitle={`${session.user.name} (${session.user.userID})`}>
      <div className="stack">
        <div className="section__title">Ludus CLI</div>
        <p className="muted text-sm">
          Battleground speaks the Ludus API, so the regular <code>ludus</code> command-line client works against it. Point it at this server and use your API key:
        </p>
        <pre className="codeblock">{`export LUDUS_URL=${origin}\nexport LUDUS_API_KEY='${apiKey ?? '<your API key>'}'\nludus range status`}</pre>
        <div className="row row--wrap">
          <Button
            onClick={async () => {
              if (apiKey === null && !window.confirm('Create a new API key? The current key stops working immediately.')) return;
              try {
                setApiKey((await api.rotateApiKey()).result.apiKey);
              } catch (err) {
                toast.err('API key', errorText(err));
              }
            }}
          >
            <RefreshCw />
            {apiKey ? 'Create another key' : 'Create a new API key'}
          </Button>
          {apiKey ? <CopyButton text={apiKey} label="Copy key" size="md" /> : null}
        </div>
        <div className="section__title">VPN profile</div>
        <p className="muted text-sm">
          On a real Ludus server this WireGuard profile connects you to your ranges. Battleground simulates the ranges, so the profile is for reference and for
          testing tooling that consumes it.
        </p>
        {wireguard ? (
          <>
            <pre className="codeblock">{wireguard}</pre>
            <div className="row">
              <CopyButton text={wireguard} size="md" />
              <Button onClick={() => downloadBlob(`${session.user.userID}-wireguard.conf`, wireguard)}>
                <Download />
                Download
              </Button>
            </div>
          </>
        ) : null}
        <div className="section__title">Password</div>
        <div className="row row--wrap">
          <input className="input grow" style={{ minWidth: 200 }} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button
            disabled={password.length < 8}
            onClick={async () => {
              try {
                toast.ok((await api.setPassword(session.user.userID, password)).result);
                setPassword('');
              } catch (err) {
                toast.err('Password', errorText(err));
              }
            }}
          >
            Change password
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

