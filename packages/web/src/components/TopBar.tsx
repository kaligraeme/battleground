import { Blocks, Check, ChevronDown, Eye, Gauge, KeyRound, LogOut, Moon, Package, Plus, Sun, Users } from 'lucide-react';
import { useState } from 'react';
import { type RangeState, type RangeSummary } from '../lib/api';
import { type TabId, navigate } from '../lib/router';
import { useApp } from '../lib/store';
import { useTheme } from '../lib/theme';
import { Brand } from './Brand';
import { AccountDialog, CreateRangeDialog, SettingsDialog, TemplatesDialog, UsersDialog } from './dialogs';
import { Badge, Dropdown, MenuItem, type Tone } from './ui';

export function stateTone(state: RangeState | undefined, deploying = false): Tone {
  if (deploying || state === 'DEPLOYING' || state === 'DESTROYING') return 'warn';
  switch (state) {
    case 'SUCCESS':
      return 'ok';
    case 'ERROR':
      return 'err';
    case 'ABORTED':
      return 'drop';
    default:
      return 'neutral';
  }
}

export function StateBadge({ state, testing, deploying }: { state: RangeState | undefined; testing?: boolean; deploying?: boolean }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <Badge tone={stateTone(state, deploying)}>
        {deploying || state === 'DEPLOYING' ? <span className="dot dot--warn dot--pulse" /> : null}
        {state ?? '…'}
      </Badge>
      {testing ? <Badge tone="testing">Testing</Badge> : null}
    </span>
  );
}

function RangePicker({ ranges, current }: { ranges: RangeSummary[]; current: RangeSummary | undefined }) {
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Dropdown
        menuClassName="range-menu"
        trigger={({ toggle, open }) => (
          <button type="button" className="range-picker" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
            <span className="range-picker__label">Range</span>
            <span className="range-picker__name truncate">{current ? current.name : 'Choose a range'}</span>
            {current ? <span className="range-picker__id mono">{current.rangeID}</span> : null}
            <ChevronDown size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="menu__label">Your ranges</div>
            {ranges.map((range) => (
              <MenuItem
                key={range.rangeID}
                icon={range.rangeID === current?.rangeID ? <Check /> : <span style={{ width: 14 }} />}
                hint={
                  <span className="row" style={{ gap: 6 }}>
                    <span className="mono">
                      {range.rangeID} · 10.{range.rangeNumber}.0.0/16
                    </span>
                    · {range.numberOfVMs} VMs
                  </span>
                }
                onSelect={() => {
                  close();
                  navigate({ rangeId: range.rangeID });
                }}
              >
                <span className="row row--between">
                  <span className="truncate">{range.name}</span>
                  <StateBadge state={range.rangeState} testing={range.testingEnabled} deploying={range.deploying} />
                </span>
              </MenuItem>
            ))}
            <div className="menu__sep" />
            <MenuItem
              icon={<Plus />}
              onSelect={() => {
                close();
                setCreating(true);
              }}
            >
              New range…
            </MenuItem>
          </>
        )}
      </Dropdown>
      <CreateRangeDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

export function TopBar({ rangeId, tab }: { rangeId: string | null; tab: TabId }) {
  const session = useApp((s) => s.session);
  const signOut = useApp((s) => s.signOut);
  const [theme, setTheme] = useTheme();
  const [dialog, setDialog] = useState<'templates' | 'users' | 'settings' | 'account' | null>(null);
  if (!session) return null;
  const current = session.ranges.find((r) => r.rangeID === rangeId);
  const initials = session.user.name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="topbar">
      <Brand />
      <div className="divider-v topbar__divider" />
      <RangePicker ranges={session.ranges} current={current} />
      <nav className="topbar__tabs segmented" aria-label="Mode">
        <button type="button" className="segmented__item" aria-pressed={tab === 'view'} onClick={() => navigate({ tab: 'view' })}>
          <Eye />
          <span>View &amp; simulate</span>
        </button>
        <button type="button" className="segmented__item" aria-pressed={tab === 'build'} onClick={() => navigate({ tab: 'build' })}>
          <Blocks />
          <span>Build</span>
        </button>
      </nav>
      <span className="grow" />
      <button type="button" className="btn btn--ghost btn--sm topbar__wide" onClick={() => setDialog('templates')}>
        <Package />
        Templates
      </button>
      {session.user.isAdmin ? (
        <button type="button" className="btn btn--ghost btn--sm topbar__wide" onClick={() => setDialog('users')}>
          <Users />
          Users
        </button>
      ) : null}
      <Dropdown
        align="right"
        trigger={({ toggle, open }) => (
          <button type="button" className="avatar" onClick={toggle} aria-expanded={open} aria-label="Account menu">
            {initials}
          </button>
        )}
      >
        {(close) => {
          const pick = (fn: () => void) => () => {
            close();
            fn();
          };
          return (
            <>
              <div className="menu__label">
                {session.user.name} · {session.user.userID}
                {session.user.isAdmin ? ' · admin' : ''}
              </div>
              <MenuItem icon={<KeyRound />} hint="API key, VPN profile, password" onSelect={pick(() => setDialog('account'))}>
                Account &amp; access
              </MenuItem>
              <div className="topbar__narrow-only">
                <MenuItem icon={<Package />} onSelect={pick(() => setDialog('templates'))}>
                  Templates
                </MenuItem>
                {session.user.isAdmin ? (
                  <MenuItem icon={<Users />} onSelect={pick(() => setDialog('users'))}>
                    Users
                  </MenuItem>
                ) : null}
              </div>
              <MenuItem icon={<Gauge />} hint="Simulation speed" onSelect={pick(() => setDialog('settings'))}>
                Settings
              </MenuItem>
              <MenuItem icon={theme === 'dark' ? <Sun /> : <Moon />} onSelect={pick(() => setTheme(theme === 'dark' ? 'light' : 'dark'))}>
                {theme === 'dark' ? 'Light theme' : 'Dark theme'}
              </MenuItem>
              <div className="menu__sep" />
              <MenuItem icon={<LogOut />} onSelect={pick(() => void signOut())}>
                Sign out
              </MenuItem>
            </>
          );
        }}
      </Dropdown>
      <TemplatesDialog open={dialog === 'templates'} onClose={() => setDialog(null)} />
      <UsersDialog open={dialog === 'users'} onClose={() => setDialog(null)} />
      <SettingsDialog open={dialog === 'settings'} onClose={() => setDialog(null)} />
      <AccountDialog open={dialog === 'account'} onClose={() => setDialog(null)} />
    </header>
  );
}

