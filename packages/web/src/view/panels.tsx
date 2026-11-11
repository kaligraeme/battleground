import { type DerivedRange, type FirewallEnv, type RangeConfig, buildChains, formatRule, templateInfo } from '@battleground/core';
import { Camera, Download, FileText, Globe, Laptop, LockOpen, Play, Power, RotateCcw, Router as RouterIcon, ShieldCheck, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { OsGlyph } from '../components/OsGlyph';
import { Badge, Button, CopyButton, downloadBlob } from '../components/ui';
import { type DetailVm, type RangeDetail, api } from '../lib/api';
import { toast } from '../lib/toast';
import type { Selection } from '../topology/model';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function Rows({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([key, value]) => (
        <div key={key} className="kv__row">
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

function Snapshots({ rangeId, vm, onChanged }: { rangeId: string; vm: DetailVm; onChanged: () => void }) {
  const [name, setName] = useState('');
  const act = async (action: 'create' | 'rollback' | 'remove', snapshot: string) => {
    try {
      const res = await api.snapshot(rangeId, action, { name: snapshot, vmids: [vm.proxmoxID], includeRAM: true, description: action === 'create' ? 'Taken from the Battleground UI' : undefined });
      if (res.errors?.length) toast.err('Snapshot', res.errors.map((e) => e.error).join('; '));
      else toast.ok(action === 'create' ? 'Snapshot taken' : action === 'rollback' ? 'Reverted to snapshot' : 'Snapshot removed', snapshot);
      if (action === 'create') setName('');
      onChanged();
    } catch (err) {
      toast.err('Snapshot', errorText(err));
    }
  };
  return (
    <div className="section">
      <div className="section__title">
        <Camera />
        Snapshots
      </div>
      {vm.snapshots.length === 0 ? <p className="faint text-sm">No snapshots.</p> : null}
      <ul className="snaps">
        {vm.snapshots.map((snap) => (
          <li key={snap.name} className="snaps__item">
            <div className="grow">
              <div className="row">
                <span className="mono">{snap.name}</span>
                {vm.snapshotHead === snap.name ? <Badge tone="accent">current</Badge> : null}
                {snap.includesRAM ? <Badge>RAM</Badge> : null}
              </div>
              <div className="faint text-xs">
                {new Date(snap.snaptime * 1000).toLocaleString()}
                {snap.description ? ` · ${snap.description}` : ''}
              </div>
            </div>
            <Button size="sm" variant="ghost" icon tip="Revert to this snapshot" tipPos="left" onClick={() => act('rollback', snap.name)}>
              <RotateCcw />
            </Button>
            <Button size="sm" variant="ghost" icon tip="Delete snapshot" tipPos="left" onClick={() => act('remove', snap.name)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input className="input input--sm input--mono grow" placeholder="snapshot-name" value={name} onChange={(e) => setName(e.target.value)} aria-label="Snapshot name" />
        <Button size="sm" disabled={!name.trim()} onClick={() => act('create', name.trim())}>
          <Camera />
          Take
        </Button>
      </div>
    </div>
  );
}

export function InspectPanel(props: {
  rangeId: string;
  selection: Selection;
  detail: RangeDetail | null;
  range: DerivedRange;
  config: RangeConfig | undefined;
  env: FirewallEnv | null;
  onSelect: (selection: Selection) => void;
  onTraceFrom: (index: number) => void;
  onChanged: () => void;
}) {
  const { rangeId, selection, detail, range, config, env, onSelect, onChanged } = props;
  const live = new Map((detail?.vms ?? []).map((vm) => [vm.name, vm]));

  const power = async (machine: string, on: boolean) => {
    try {
      toast.ok((await api.power(rangeId, [machine], on)).result);
      onChanged();
    } catch (err) {
      toast.err('Power', errorText(err));
    }
  };

  if (selection?.kind === 'vm') {
    const vm = range.vms.find((v) => v.index === selection.index);
    if (!vm) return <div className="empty">That machine is no longer in the config.</div>;
    const state = live.get(vm.name);
    const info = templateInfo(vm.template, vm.os);
    return (
      <div>
        <div className="section">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <OsGlyph os={vm.os} large />
            <div className="grow">
              <h3 className="truncate">{vm.hostname}</h3>
              <div className="mono faint text-xs truncate">{vm.name}</div>
            </div>
            {state ? <Badge tone={state.poweredOn ? 'ok' : 'neutral'}>{state.poweredOn ? 'Running' : 'Off'}</Badge> : <Badge>Not deployed</Badge>}
          </div>
        </div>
        <div className="section">
          <Rows
            rows={[
              ['Address', <span className="mono">{vm.ip}</span>],
              ['VLAN', <span className="mono">{vm.vlan} · gateway 10.{range.context.rangeNumber}.{vm.vlan}.254</span>],
              ['Template', <span>{info.label} <span className="mono faint text-xs">{vm.template}</span></span>],
              ['Size', `${vm.cpus} vCPU · ${vm.ramGb} GB RAM`],
              ...(vm.domain ? [['Domain', `${vm.domain.fqdn} (${vm.domain.role})`] as [string, ReactNode]] : []),
              ['Login', <span className="mono">{state?.login ?? info.login}</span>],
              ['Services', (state?.services ?? info.services).join(', ')],
              ['Testing mode', vm.testing.blockInternet ? 'Cut off from the internet' : <span className="text-testing">Keeps internet access</span>],
              ...(vm.roles.length > 0 ? [['Roles', vm.roles.join(', ')] as [string, ReactNode]] : []),
              ...(state ? [['VMID', <span className="mono">{state.proxmoxID}</span>] as [string, ReactNode]] : []),
            ]}
          />
          <div className="row row--wrap" style={{ marginTop: 12 }}>
            <Button size="sm" onClick={() => props.onTraceFrom(vm.index)}>
              <Play />
              Simulate traffic from here
            </Button>
            {state ? (
              <Button size="sm" onClick={() => power(vm.name, !state.poweredOn)}>
                <Power />
                {state.poweredOn ? 'Power off' : 'Power on'}
              </Button>
            ) : null}
          </div>
        </div>
        {state ? <Snapshots rangeId={rangeId} vm={state} onChanged={onChanged} /> : null}
      </div>
    );
  }

  if (selection?.kind === 'vlan') {
    const lane = range.vlans.find((v) => v.vlan === selection.vlan);
    if (!lane) return null;
    const rules = range.policy.rules.filter((r) => String(r.vlan_src) === String(lane.vlan) || String(r.vlan_dst) === String(lane.vlan) || r.vlan_src === 'all' || r.vlan_dst === 'all');
    return (
      <div>
        <div className="section">
          <h3>VLAN {lane.vlan}</h3>
          <Rows
            rows={[
              ['Network', <span className="mono">{lane.cidr}</span>],
              ['Gateway & DNS', <span className="mono">{lane.gateway}</span>],
              ['DHCP pool', <span className="mono">10.{range.context.rangeNumber}.{lane.vlan}.100 – .253</span>],
            ]}
          />
        </div>
        <div className="section">
          <div className="section__title">Machines</div>
          <ul className="list">
            {lane.vms.map((vm) => (
              <li key={vm.index}>
                <button type="button" className="list__item" onClick={() => onSelect({ kind: 'vm', index: vm.index })}>
                  <OsGlyph os={vm.os} />
                  <span className="grow truncate">{vm.hostname}</span>
                  <span className="mono faint text-xs">{vm.ip}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="section">
          <div className="section__title">Rules that mention this VLAN</div>
          {rules.length === 0 ? (
            <p className="faint text-sm">None. Traffic between VLANs follows the default ({range.policy.interVlan}).</p>
          ) : (
            <ul className="rules-list">
              {rules.map((r, i) => (
                <li key={i}>
                  <Badge tone={r.action === 'ACCEPT' ? 'ok' : r.action === 'REJECT' ? 'err' : 'drop'}>{r.action}</Badge> {r.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  if (selection?.kind === 'router' || selection?.kind === 'network') {
    const chains = config && env ? buildChains(config, env) : null;
    const routerState = live.get(range.router.name);
    return (
      <div>
        <div className="section">
          <div className="row">
            <span className="node__icon">
              <RouterIcon size={18} />
            </span>
            <div className="grow">
              <h3 className="truncate">{range.router.name}</h3>
              <div className="faint text-xs">Router and firewall for the range</div>
            </div>
            {routerState ? <Badge tone={routerState.poweredOn ? 'ok' : 'neutral'}>{routerState.poweredOn ? 'Running' : 'Off'}</Badge> : <Badge>Not deployed</Badge>}
          </div>
          <Rows
            rows={[
              ['WAN address', <span className="mono">{range.router.wanIp}</span>],
              ['Gateways', <span className="mono">{range.vlans.map((v) => v.gateway).join(', ') || '—'}</span>],
              ['Template', <span className="mono text-xs">{range.router.template}</span>],
              ['Between VLANs', range.policy.interVlan],
              ['Leaving the range', detail?.testing.enabled ? <span className="text-testing">Blocked (testing mode)</span> : range.policy.external],
              ['To VPN clients', range.policy.wireguard],
            ]}
          />
        </div>
        {chains ? (
          <div className="section">
            <div className="section__title">Firewall, in the order the router evaluates it</div>
            <p className="field__hint" style={{ marginBottom: 8 }}>
              Rules you add are inserted at the top of their chain, so the last rule in your config is checked first.
            </p>
            {(
              [
                ['LUDUS_DEFAULTS', chains.defaults],
                ['LUDUS_TESTING', chains.testing],
                ['LUDUS_USER_RULES', chains.user],
              ] as const
            ).map(([name, rules]) => (
              <details key={name} className="chain" open={name === 'LUDUS_USER_RULES'}>
                <summary>
                  <span className="mono">{name}</span> <span className="faint">({rules.length})</span>
                </summary>
                <ol>
                  {rules.map((rule, i) => (
                    <li key={i}>
                      <Badge tone={rule.target === 'ACCEPT' ? 'ok' : rule.target === 'REJECT' ? 'err' : 'drop'}>{rule.target}</Badge> <span className="text-sm">{rule.comment}</span>
                      <div className="mono faint text-xs">{formatRule(rule)}</div>
                    </li>
                  ))}
                  {rules.length === 0 ? <li className="faint text-sm">Empty</li> : null}
                </ol>
              </details>
            ))}
            <p className="field__hint">Anything no rule matches is dropped (FORWARD policy DROP).</p>
          </div>
        ) : null}
      </div>
    );
  }

  if (selection?.kind === 'internet' || selection?.kind === 'vpn') {
    const internet = selection.kind === 'internet';
    return (
      <div className="section">
        <div className="row">
          <span className="node__icon">{internet ? <Globe size={18} /> : <Laptop size={18} />}</span>
          <h3>{internet ? 'The Internet' : 'VPN clients'}</h3>
        </div>
        <p className="muted text-sm" style={{ marginTop: 10 }}>
          {internet
            ? `Everything outside ${range.cidr}: the internet, other ranges and the range host's network. Machines reach it through the router, which hides them behind ${range.router.wanIp}. Nothing out there can open a connection into the range.`
            : 'Users connect to the ranges they have access to over WireGuard. Their client can reach every machine; whether machines may open connections back to the client is set by wireguard_vlan_default (REJECT unless changed).'}
        </p>
        {!internet && detail ? (
          <>
            <div className="section__title" style={{ marginTop: 14 }}>
              Users with access
            </div>
            <ul className="list">
              {detail.grants.map((g) => (
                <li key={g.userID} className="list__item">
                  <span className="mono">{g.userID}</span>
                  <span className="grow truncate muted">{g.name}</span>
                  <span className="mono faint text-xs">198.51.100.{g.userNumber}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    );
  }

  // Nothing selected: the machine list.
  return (
    <div>
      <div className="section">
        <div className="section__title">Machines</div>
        {range.vms.length === 0 ? <p className="faint text-sm">This range has no machines yet. Add some in the Build tab.</p> : null}
        <ul className="list">
          {range.vms.map((vm) => {
            const state = live.get(vm.name);
            return (
              <li key={vm.index}>
                <button type="button" className="list__item" onClick={() => onSelect({ kind: 'vm', index: vm.index })}>
                  <span className={state?.poweredOn ? 'dot dot--ok' : 'dot'} title={state ? (state.poweredOn ? 'Running' : 'Off') : 'Not deployed'} />
                  <OsGlyph os={vm.os} />
                  <span className="grow truncate">{vm.hostname}</span>
                  <span className="mono faint text-xs">{vm.ip}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {detail && detail.vms.some((vm) => !vm.isRouter && !range.vms.some((v) => v.name === vm.name)) ? (
        <div className="section">
          <div className="callout callout--warn">
            <FileText />
            <span>
              Some deployed machines are no longer in the config ({detail.vms.filter((vm) => !vm.isRouter && !range.vms.some((v) => v.name === vm.name)).map((vm) => vm.name).join(', ')}). A deploy does not remove them; destroy the range's machines to start clean.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Testing mode
// ---------------------------------------------------------------------------

export function TestingPanel({ rangeId, detail, range, onChanged }: { rangeId: string; detail: RangeDetail | null; range: DerivedRange; onChanged: () => void }) {
  const [item, setItem] = useState('');
  const [busy, setBusy] = useState(false);
  if (!detail) return null;
  const enabled = detail.testing.enabled;
  const exempt = range.vms.filter((vm) => !vm.testing.blockInternet);
  const deployed = detail.vms.length > 0;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      toast.err('Testing mode', errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const allow = () =>
    run(async () => {
      const value = item.trim();
      const isIp = /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(value);
      const res = await api.allow(rangeId, isIp ? [] : [value], isIp ? [value] : []);
      if (res.allowed?.length) toast.ok('Allowed', res.allowed.join(', '));
      if (res.errors?.length) toast.warn('Not allowed', res.errors.map((e) => `${e.item}: ${e.reason}`).join('; '));
      setItem('');
    });

  return (
    <div>
      <div className="section">
        <p className="muted text-sm">
          Testing mode snapshots the machines and cuts the range off from the internet, so tools can be tried without sending anything out. Stopping it reverts the
          snapshots.
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          {enabled ? (
            <Button variant="testing" busy={busy} onClick={() => run(() => api.testingStop(rangeId))}>
              <RotateCcw />
              Stop testing and revert
            </Button>
          ) : (
            <Button variant="testing" busy={busy} disabled={!deployed} onClick={() => run(() => api.testingStart(rangeId))}>
              <ShieldCheck />
              Start testing
            </Button>
          )}
          {!deployed ? <span className="faint text-sm">Deploy the range first.</span> : null}
        </div>
      </div>
      {enabled ? (
        <div className="section">
          <div className="section__title">Allowed destinations</div>
          <div className="row">
            <input
              className="input input--mono grow"
              placeholder="example.com or 203.0.113.5"
              value={item}
              onChange={(e) => setItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && item.trim()) void allow();
              }}
              aria-label="Domain or IP to allow"
            />
            <Button disabled={!item.trim()} busy={busy} onClick={allow}>
              Allow
            </Button>
          </div>
          <p className="field__hint" style={{ marginTop: 6 }}>
            A domain is resolved now and pinned to that address. Allowed destinations apply to every machine in the range.
          </p>
          <ul className="list" style={{ marginTop: 8 }}>
            {detail.testing.allowed.map((a) => (
              <li key={`${a.domain ?? ''}${a.ip}`} className="list__item">
                <span className="grow mono truncate">{a.domain ?? a.ip}</span>
                {a.domain ? <span className="mono faint text-xs">{a.ip}</span> : null}
                <Button size="sm" variant="ghost" onClick={() => run(() => api.deny(rangeId, a.domain ? [a.domain] : [], a.domain ? [] : [a.ip]))}>
                  Deny
                </Button>
              </li>
            ))}
            {detail.testing.allowed.length === 0 ? <li className="faint text-sm">Nothing allowed: all outbound traffic is dropped.</li> : null}
          </ul>
        </div>
      ) : null}
      <div className="section">
        <div className="section__title">
          <LockOpen />
          Machines that keep internet access
        </div>
        {exempt.length === 0 ? (
          <p className="faint text-sm">None. Set testing.block_internet: false on a machine in the Build tab to exempt it.</p>
        ) : (
          <ul className="list">
            {exempt.map((vm) => (
              <li key={vm.index} className="list__item">
                <OsGlyph os={vm.os} />
                <span className="grow truncate">{vm.hostname}</span>
                <span className="mono faint text-xs">{vm.ip}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function AccessPanel({ rangeId, detail }: { rangeId: string; detail: RangeDetail | null }) {
  const fetchText = async (fn: () => Promise<{ result: string }>, filename: string) => {
    try {
      downloadBlob(filename, (await fn()).result);
    } catch (err) {
      toast.err('Download', errorText(err));
    }
  };
  const origin = window.location.origin;
  return (
    <div>
      <div className="section">
        <div className="section__title">Downloads</div>
        <div className="stack stack--tight">
          <Button disabled={!detail?.etcHostsWritten} onClick={() => fetchText(() => api.etcHosts(rangeId), `${rangeId}-hosts`)}>
            <Download />
            Hosts file
          </Button>
          <Button
            disabled={!detail?.vms.some((vm) => vm.os === 'windows')}
            onClick={async () => {
              try {
                downloadBlob('rdp.zip', await api.rdp(rangeId), 'application/zip');
              } catch (err) {
                toast.err('Download', errorText(err));
              }
            }}
          >
            <Download />
            RDP profiles (zip)
          </Button>
          <Button disabled={!detail?.vms.length} onClick={() => fetchText(() => api.inventory(rangeId), `${rangeId}-inventory.yml`)}>
            <Download />
            Ansible inventory
          </Button>
        </div>
      </div>
      <div className="section">
        <div className="section__title">Default credentials</div>
        <Rows
          rows={[
            ['Windows', <span className="mono">localuser:password</span>],
            ['Domain user', <span className="mono">domainuser:password</span>],
            ['Domain admin', <span className="mono">domainadmin:password</span>],
            ['Kali', <span className="mono">kali:kali (KasmVNC kali:password)</span>],
            ['Debian', <span className="mono">debian:debian</span>],
            ['Others', <span className="mono">localuser:password</span>],
          ]}
        />
      </div>
      <div className="section">
        <div className="section__title">From the command line</div>
        <pre className="codeblock">{`export LUDUS_URL=${origin}\nludus range status -r ${rangeId}\nludus range logs -f -r ${rangeId}`}</pre>
        <CopyButton text={`export LUDUS_URL=${origin}\nludus range status -r ${rangeId}`} />
      </div>
    </div>
  );
}
