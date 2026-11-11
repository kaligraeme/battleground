import { type FirewallEnv, deriveRange } from '@battleground/core';
import { Activity, Blocks, ChevronDown, Ellipsis, Info, KeyRound, Play, Power, PowerOff, Rocket, ShieldCheck, Square, Star, Trash2, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { StateBadge } from '../components/TopBar';
import { Badge, Button, Dialog, Dropdown, Field, MenuItem, Tabs, cx } from '../components/ui';
import { api } from '../lib/api';
import { navigate } from '../lib/router';
import { useApp } from '../lib/store';
import { toast } from '../lib/toast';
import { Topology } from '../topology/Topology';
import type { Endpoint } from '../topology/layout';
import type { Selection, TraceOverlay } from '../topology/model';
import { LogDrawer } from './LogDrawer';
import { clearLogOpenRequest, logOpenRequested } from './logRequest';
import { AccessPanel, InspectPanel, TestingPanel } from './panels';
import { type Party, SERVICES, partyEndpoint, simulate } from './traffic';
import { TrafficPanel, type TrafficState } from './TrafficPanel';
import { useRangeData } from './useRange';

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
type SideTab = 'inspect' | 'traffic' | 'testing' | 'access';

function DeployDialog({ open, onClose, tags, onDeploy }: { open: boolean; onClose: () => void; tags: string[]; onDeploy: (options: { tags: string; limit: string }) => void }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [limit, setLimit] = useState('');
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Deploy part of the range"
      subtitle="Run only the steps for the chosen tags, optionally on only some machines (same as ludus range deploy -t … --limit …)."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={chosen.length === 0}
            onClick={() => {
              onDeploy({ tags: chosen.join(','), limit });
              onClose();
            }}
          >
            <Rocket />
            Deploy {chosen.length > 0 ? chosen.join(', ') : ''}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="tag-grid">
          {tags
            .filter((t) => t !== 'all')
            .map((tag) => (
              <label key={tag} className="tag-check">
                <input type="checkbox" checked={chosen.includes(tag)} onChange={(e) => setChosen(e.target.checked ? [...chosen, tag] : chosen.filter((t) => t !== tag))} />
                <span className="mono">{tag}</span>
              </label>
            ))}
        </div>
        <Field label="Limit to machines (optional)" hint="Comma-separated VM names; the machines must already exist." htmlFor="deploy-limit">
          <input id="deploy-limit" className="input input--mono" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="BG-kali" />
        </Field>
      </div>
    </Dialog>
  );
}

function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Deployment progress">
      <div className="progress__bar" style={{ width: `${pct}%` }} />
      <span className="progress__label truncate">
        {pct}% · {label}
      </span>
    </div>
  );
}

export function ViewTab({ rangeId }: { rangeId: string }) {
  const { session, meta, detail, detailError, summary, config, deployedConfig, model, rangeNumber, undeployed } = useRangeData(rangeId);
  const refresh = useApp((s) => s.refresh);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<SideTab>('inspect');
  const [logOpen, setLogOpen] = useState(logOpenRequested);
  useEffect(clearLogOpenRequest, []);
  const [deployDialog, setDeployDialog] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<TrafficState>({ from: null, to: null, service: SERVICES.find((s) => s.id === 'smb') ?? (SERVICES[0] as (typeof SERVICES)[number]) });
  const [picking, setPicking] = useState<'from' | 'to' | null>(null);
  const [rulesSource, setRulesSource] = useState<'deployed' | 'saved'>('deployed');

  const range = useMemo(() => deriveRange(config, { rangeId, rangeNumber }), [config, rangeId, rangeNumber]);
  const userNumber = session?.user.userNumber ?? 2;
  const env = useMemo<FirewallEnv | null>(
    () =>
      detail && meta
        ? {
            rangeNumber,
            hostLocalIp: meta.host.localIp,
            hostPublicIp: meta.host.publicIp,
            grants: detail.grants,
            testing: { enabled: detail.testing.enabled, allowed: detail.testing.allowed },
          }
        : null,
    [detail, meta, rangeNumber],
  );
  // The router enforces the rules it was deployed with until the next deploy.
  const simConfig = rulesSource === 'deployed' && deployedConfig ? deployedConfig : config;

  const trace = useMemo<TraceOverlay | undefined>(() => {
    if (tab !== 'traffic' || !traffic.from || !traffic.to || !simConfig || !env) return undefined;
    const from = partyEndpoint(traffic.from, range);
    const to = partyEndpoint(traffic.to, range);
    if (!from || !to) return undefined;
    try {
      const decision = simulate(simConfig, env, range, traffic.from, traffic.to, traffic.service);
      return {
        from,
        to,
        verdict: decision.verdict === 'ACCEPT' ? 'accept' : decision.verdict === 'REJECT' ? 'reject' : 'drop',
        filtered: decision.hook !== 'NONE',
        label: decision.verdict === 'ACCEPT' ? 'ALLOWED' : decision.verdict === 'REJECT' ? 'REJECTED' : 'DROPPED',
      };
    } catch {
      return undefined;
    }
  }, [tab, traffic, simConfig, env, range]);

  const act = async (label: string, fn: () => Promise<{ result: string }>, options: { openLog?: boolean } = {}) => {
    setBusy(label);
    try {
      const res = await fn();
      toast.ok(res.result);
      if (options.openLog) setLogOpen(true);
    } catch (err) {
      toast.err(label, errorText(err));
    } finally {
      setBusy(null);
      void refresh(rangeId);
    }
  };

  const deploy = (options: { tags?: string; limit?: string } = {}) => act('Deploy', () => api.deploy(rangeId, options), { openLog: true });

  const onPick = (endpoint: Endpoint) => {
    if (!picking) return;
    let party: Party | undefined;
    if (endpoint.kind === 'vm') {
      const lane = range.vlans.find((l) => l.vlan === endpoint.vlan);
      const vm = lane?.vms[endpoint.row];
      if (vm) party = { kind: 'vm', index: vm.index };
    } else if (endpoint.kind === 'internet') party = { kind: 'internet', ip: '8.8.8.8' };
    else if (endpoint.kind === 'vpn') party = { kind: 'vpn', userNumber };
    else party = { kind: 'router' };
    if (party) setTraffic({ ...traffic, [picking]: party });
    setPicking(picking === 'from' && !traffic.to ? 'to' : null);
  };

  const deploying = Boolean(detail?.deploying);
  const state = detail?.range.rangeState ?? summary?.rangeState;
  const progress = detail?.progress;
  const totals = range.totals;

  return (
    <div className="viewtab">
      <div className="rangebar">
        <div className="rangebar__info">
          <div className="row">
            <h2 className="truncate">{detail?.range.name ?? summary?.name ?? rangeId}</h2>
            <StateBadge state={state} testing={detail?.testing.enabled} deploying={deploying} />
            {undeployed ? (
              <Badge tone="accent" title="The saved config differs from what was last deployed">
                Undeployed changes
              </Badge>
            ) : null}
          </div>
          <div className="rangebar__meta">
            <span className="mono">{rangeId}</span>
            <span className="mono">10.{rangeNumber}.0.0/16</span>
            <span>
              {totals.vms} VMs · {totals.cpus} vCPU · {totals.ramGb} GB
            </span>
            {detail && detail.range.lastDeployment !== '0001-01-01T00:00:00Z' ? <span>Last deploy {new Date(detail.range.lastDeployment).toLocaleString()}</span> : null}
          </div>
        </div>
        {deploying && progress ? <ProgressBar done={progress.done} total={progress.total} label={progress.task ?? progress.play} /> : null}
        <div className="rangebar__actions">
          {deploying ? (
            <Button variant="danger" busy={busy === 'Abort'} onClick={() => act('Abort', () => api.abort(rangeId))}>
              <Square />
              Abort
            </Button>
          ) : (
            <div className="btn-group">
              <Button variant="primary" busy={busy === 'Deploy'} disabled={!config} onClick={() => deploy()}>
                <Rocket />
                Deploy
              </Button>
              <Dropdown
                align="right"
                trigger={({ toggle }) => (
                  <Button variant="primary" icon tip="More deploy options" tipPos="left" onClick={toggle}>
                    <ChevronDown />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Rocket />} hint="Every step, every machine" onSelect={() => { close(); deploy(); }}>
                      Deploy everything
                    </MenuItem>
                    <MenuItem icon={<Waypoints />} hint="Router, VLANs and firewall only" onSelect={() => { close(); deploy({ tags: 'network' }); }}>
                      Apply network changes
                    </MenuItem>
                    <MenuItem icon={<Blocks />} hint="Choose tags and machines" onSelect={() => { close(); setDeployDialog(true); }}>
                      Deploy selected steps…
                    </MenuItem>
                  </>
                )}
              </Dropdown>
            </div>
          )}
          <Button
            variant="testing"
            busy={busy === 'Testing'}
            disabled={deploying || !detail?.vms.length}
            onClick={() => act('Testing', () => (detail?.testing.enabled ? api.testingStop(rangeId) : api.testingStart(rangeId)))}
          >
            <ShieldCheck />
            {detail?.testing.enabled ? 'Stop testing' : 'Testing mode'}
          </Button>
          <Dropdown
            align="right"
            trigger={({ toggle }) => (
              <Button icon tip="More" tipPos="left" onClick={toggle}>
                <Ellipsis />
              </Button>
            )}
          >
            {(close) => {
              const pick = (fn: () => void) => () => {
                close();
                fn();
              };
              return (
                <>
                  <MenuItem icon={<Power />} disabled={!detail?.vms.length} onSelect={pick(() => act('Power', () => api.power(rangeId, ['all'], true)))}>
                    Power on everything
                  </MenuItem>
                  <MenuItem icon={<PowerOff />} disabled={!detail?.vms.length} onSelect={pick(() => act('Power', () => api.power(rangeId, ['all'], false)))}>
                    Power off everything
                  </MenuItem>
                  <MenuItem icon={<Star />} onSelect={pick(() => act('Default range', async () => ({ result: `Default range is now ${(await api.setDefaultRange(rangeId)).defaultRangeID}` })))}>
                    Make this my default range
                  </MenuItem>
                  <div className="menu__sep" />
                  <MenuItem
                    icon={<Trash2 />}
                    danger
                    disabled={!detail?.vms.length || deploying}
                    hint="Keeps the range and its config"
                    onSelect={pick(() => {
                      if (window.confirm(`Destroy every machine in ${rangeId}, including the router?`)) void act('Destroy', () => api.destroyVms(rangeId));
                    })}
                  >
                    Destroy all machines
                  </MenuItem>
                  <MenuItem
                    icon={<Trash2 />}
                    danger
                    disabled={deploying}
                    onSelect={pick(() => {
                      if (!window.confirm(`Delete the range ${rangeId}, its machines and its config? This cannot be undone.`)) return;
                      void act('Delete', async () => {
                        const res = await api.deleteRange(rangeId, true);
                        navigate({ rangeId: undefined });
                        return res;
                      });
                    })}
                  >
                    Delete range
                  </MenuItem>
                </>
              );
            }}
          </Dropdown>
        </div>
      </div>

      {detailError && !detail ? <div className="callout callout--err" style={{ margin: 12 }}>{detailError}</div> : null}

      <div className="viewtab__body">
        <div className="viewtab__canvas">
          <Topology
            model={model}
            mode="view"
            selection={selection}
            onSelect={(sel) => {
              setSelection(sel);
              if (sel && tab !== 'traffic') setTab('inspect');
            }}
            trace={trace}
            picking={picking !== null}
            onPick={onPick}
            legend={
              <>
                <span>
                  <span className="dot dot--ok" /> running
                </span>
                <span>
                  <span className="dot" /> off
                </span>
                <span>
                  <span className="legend-dash" /> not deployed
                </span>
              </>
            }
          >
            {model.lanes.length === 0 && config ? (
              <div className="canvas__empty" data-nopan>
                <div className="empty">
                  <Info />
                  <div className="empty__title">This range has no machines</div>
                  <p>Design it in the Build tab: drag templates onto the canvas.</p>
                  <Button variant="primary" onClick={() => navigate({ tab: 'build' })}>
                    <Blocks />
                    Open Build
                  </Button>
                </div>
              </div>
            ) : null}
          </Topology>
          <LogDrawer rangeId={rangeId} open={logOpen} onToggle={() => setLogOpen(!logOpen)} live={deploying} />
        </div>
        <aside className="sidepanel panel">
          <Tabs<SideTab>
            label="Range panels"
            active={tab}
            onChange={(t) => {
              setTab(t);
              if (t !== 'traffic') setPicking(null);
            }}
            tabs={[
              { id: 'inspect', label: 'Details', icon: <Info /> },
              { id: 'traffic', label: 'Traffic', icon: <Activity /> },
              { id: 'testing', label: 'Testing', icon: <ShieldCheck />, count: detail?.testing.enabled ? detail.testing.allowed.length || undefined : undefined },
              { id: 'access', label: 'Access', icon: <KeyRound /> },
            ]}
          />
          <div className="panel__body">
            {tab === 'inspect' ? (
              <InspectPanel
                rangeId={rangeId}
                selection={selection}
                detail={detail}
                range={range}
                config={simConfig}
                env={env}
                onSelect={setSelection}
                onTraceFrom={(index) => {
                  setTraffic({ ...traffic, from: { kind: 'vm', index } });
                  setTab('traffic');
                }}
                onChanged={() => void refresh(rangeId)}
              />
            ) : tab === 'traffic' ? (
              <div className="panel__pad">
                <TrafficPanel
                  config={simConfig}
                  env={env}
                  range={range}
                  state={traffic}
                  onChange={setTraffic}
                  picking={picking}
                  onPicking={setPicking}
                  userNumber={userNumber}
                  rulesNote={
                    undeployed ? (
                      <div className="callout callout--info">
                        <Play />
                        <div className="grow">
                          The saved config has changes that are not deployed yet.
                          <div className="segmented" style={{ marginTop: 6 }} role="group" aria-label="Rules to simulate">
                            <button type="button" className="segmented__item" aria-pressed={rulesSource === 'deployed'} onClick={() => setRulesSource('deployed')}>
                              Deployed rules
                            </button>
                            <button type="button" className="segmented__item" aria-pressed={rulesSource === 'saved'} onClick={() => setRulesSource('saved')}>
                              Saved config
                            </button>
                          </div>
                        </div>
                      </div>
                    ) : !detail?.deployedConfig ? (
                      <div className="callout">
                        <Info />
                        <span>Not deployed yet: simulating the rules this config would create.</span>
                      </div>
                    ) : null
                  }
                />
              </div>
            ) : tab === 'testing' ? (
              <TestingPanel rangeId={rangeId} detail={detail} range={range} onChanged={() => void refresh(rangeId)} />
            ) : (
              <AccessPanel rangeId={rangeId} detail={detail} />
            )}
          </div>
        </aside>
      </div>
      <DeployDialog open={deployDialog} onClose={() => setDeployDialog(false)} tags={meta?.deployTags ?? []} onDeploy={(o) => void deploy(o)} />
      <span className={cx('sr-only')}>{busy ? `${busy} in progress` : ''}</span>
    </div>
  );
}
