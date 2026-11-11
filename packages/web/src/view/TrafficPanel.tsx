import { type Decision, type DerivedRange, type FirewallEnv, type RangeConfig, formatRule } from '@battleground/core';
import { ArrowRight, Check, Crosshair, Grid3x3, ShieldAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Segmented, cx } from '../components/ui';
import { type Party, SERVICES, type Service, matrix, partyIp, partyLabel, samePartyKey, serviceLabel, simulate } from './traffic';

export interface TrafficState {
  from: Party | null;
  to: Party | null;
  service: Service;
}

function verdictTone(verdict: string): 'ok' | 'err' | 'drop' {
  return verdict === 'ACCEPT' ? 'ok' : verdict === 'REJECT' ? 'err' : 'drop';
}

export function VerdictIcon({ verdict, size = 14 }: { verdict: string; size?: number }) {
  return verdict === 'ACCEPT' ? <Check size={size} /> : verdict === 'REJECT' ? <X size={size} /> : <ShieldAlert size={size} />;
}

const VERDICT_TEXT: Record<string, string> = {
  ACCEPT: 'Allowed',
  REJECT: 'Rejected',
  DROP: 'Dropped',
};

function describe(decision: Decision): string {
  if (decision.hook === 'NONE') return 'Both machines are on the same VLAN, so the traffic is switched directly and never passes the router.';
  if (!decision.rule) {
    return decision.hook === 'FORWARD'
      ? 'No rule matched, so the router falls back to its default for routed traffic: drop silently.'
      : 'No rule matched, so the router accepts traffic addressed to itself.';
  }
  const verb = decision.verdict === 'ACCEPT' ? 'allows' : decision.verdict === 'REJECT' ? 'rejects' : 'drops';
  switch (decision.rule.origin.kind) {
    case 'user_rule':
      return `Your network rule "${decision.reason.replace(/^User Rule: /, '')}" ${verb} it.`;
    case 'inter_vlan_default':
      return `No rule covers it, so the default for traffic between VLANs applies (inter_vlan_default: ${decision.verdict}).`;
    case 'external_default':
      return `No rule covers it, so the default for traffic leaving the range applies (external_default: ${decision.verdict}).`;
    case 'wireguard_vlan_default':
      return `Connections from the range to VPN clients follow wireguard_vlan_default (${decision.verdict}).`;
    case 'always_blocked':
      return 'The destination is in always_blocked_networks; nothing from the range may reach it, not even replies.';
    case 'grant':
      return `${decision.rule.origin.userID} has access to this range, so their VPN client is let in.`;
    case 'testing_vm':
      return 'Testing mode is on, but this machine keeps its internet access (testing.block_internet: false).';
    case 'testing_allow':
      return `Testing mode is on and ${decision.rule.origin.domain ?? decision.rule.origin.ip} has been allowed.`;
    default:
      return `A built-in rule ${verb} it: ${decision.reason}.`;
  }
}

function PartyPicker({ label, value, onChange, range, userNumber, picking, onPick }: {
  label: string;
  value: Party | null;
  onChange: (party: Party) => void;
  range: DerivedRange;
  userNumber: number;
  picking: boolean;
  onPick: () => void;
}) {
  const key = value ? (value.kind === 'vm' ? `vm:${value.index}` : value.kind) : '';
  const [internetIp, setInternetIp] = useState(value?.kind === 'internet' ? value.ip : '8.8.8.8');
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <div className="row">
        <select
          className="select"
          aria-label={label}
          value={key}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith('vm:')) onChange({ kind: 'vm', index: Number(v.slice(3)) });
            else if (v === 'internet') onChange({ kind: 'internet', ip: internetIp });
            else if (v === 'vpn') onChange({ kind: 'vpn', userNumber });
            else if (v === 'router') onChange({ kind: 'router' });
          }}
        >
          <option value="" disabled>
            Choose…
          </option>
          <optgroup label="Machines">
            {range.vms.map((vm) => (
              <option key={vm.index} value={`vm:${vm.index}`}>
                {vm.hostname} ({vm.ip})
              </option>
            ))}
          </optgroup>
          <optgroup label="Outside the range">
            <option value="internet">Internet host</option>
            <option value="vpn">Your VPN client (198.51.100.{userNumber})</option>
            <option value="router">The range router</option>
          </optgroup>
        </select>
        <Button icon variant={picking ? 'primary' : 'default'} tip="Pick on the map" tipPos="left" onClick={onPick} aria-pressed={picking}>
          <Crosshair />
        </Button>
      </div>
      {value?.kind === 'internet' ? (
        <input
          className="input input--mono input--sm"
          aria-label="Internet address"
          value={internetIp}
          onChange={(e) => {
            setInternetIp(e.target.value);
            onChange({ kind: 'internet', ip: e.target.value.trim() });
          }}
        />
      ) : null}
    </div>
  );
}

export function TrafficPanel(props: {
  config: RangeConfig | undefined;
  env: FirewallEnv | null;
  range: DerivedRange;
  state: TrafficState;
  onChange: (state: TrafficState) => void;
  picking: 'from' | 'to' | null;
  onPicking: (which: 'from' | 'to' | null) => void;
  userNumber: number;
  rulesNote?: React.ReactNode;
}) {
  const { config, env, range, state, onChange, picking, onPicking, userNumber } = props;
  const [view, setView] = useState<'trace' | 'grid'>('trace');
  const [customPort, setCustomPort] = useState('8080');

  const decision = useMemo(() => {
    if (!config || !env || !state.from || !state.to) return null;
    try {
      return simulate(config, env, range, state.from, state.to, state.service);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }, [config, env, range, state]);

  const parties = useMemo<Party[]>(
    () => [...range.vms.map((vm): Party => ({ kind: 'vm', index: vm.index })), { kind: 'internet', ip: '8.8.8.8' }, { kind: 'vpn', userNumber }],
    [range.vms, userNumber],
  );
  const grid = useMemo(() => (config && env && view === 'grid' ? matrix(config, env, range, parties, state.service) : []), [config, env, range, parties, state.service, view]);

  if (!config || !env) return <div className="empty">Loading…</div>;
  if (range.vms.length === 0) {
    return (
      <div className="empty">
        <div className="empty__title">Nothing to simulate yet</div>
        <p>Add machines in the Build tab first.</p>
      </div>
    );
  }

  const serviceSelect = (
    <div className="field">
      <span className="field__label">Traffic</span>
      <div className="row">
        <select
          className="select"
          aria-label="Service"
          value={SERVICES.some((s) => s.id === state.service.id) ? state.service.id : 'custom'}
          onChange={(e) => {
            const found = SERVICES.find((s) => s.id === e.target.value);
            if (found) onChange({ ...state, service: found });
            else onChange({ ...state, service: { id: 'custom', label: 'Custom', protocol: 'tcp', port: Number(customPort) || 8080 } });
          }}
        >
          {SERVICES.map((s) => (
            <option key={s.id} value={s.id}>
              {serviceLabel(s)}
            </option>
          ))}
          <option value="custom">Custom port…</option>
        </select>
        {state.service.id === 'custom' ? (
          <>
            <select
              className="select"
              style={{ width: 84 }}
              aria-label="Protocol"
              value={state.service.protocol}
              onChange={(e) => onChange({ ...state, service: { ...state.service, protocol: e.target.value } })}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
            </select>
            <input
              className="input input--mono"
              style={{ width: 84 }}
              aria-label="Port"
              inputMode="numeric"
              value={customPort}
              onChange={(e) => {
                setCustomPort(e.target.value);
                const port = Number(e.target.value);
                if (Number.isInteger(port) && port >= 0 && port <= 65535) onChange({ ...state, service: { ...state.service, port } });
              }}
            />
          </>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="stack traffic">
      <Segmented
        label="Traffic view"
        value={view}
        onChange={setView}
        options={[
          { value: 'trace', label: <><ArrowRight /> Trace a connection</> },
          { value: 'grid', label: <><Grid3x3 /> Who can reach whom</> },
        ]}
      />
      {props.rulesNote}
      {serviceSelect}
      {view === 'trace' ? (
        <>
          <PartyPicker label="From" value={state.from} onChange={(from) => onChange({ ...state, from })} range={range} userNumber={userNumber} picking={picking === 'from'} onPick={() => onPicking(picking === 'from' ? null : 'from')} />
          <PartyPicker label="To" value={state.to} onChange={(to) => onChange({ ...state, to })} range={range} userNumber={userNumber} picking={picking === 'to'} onPick={() => onPicking(picking === 'to' ? null : 'to')} />
          {picking ? <div className="callout callout--info">Click a machine, the Internet or the VPN node on the map to choose “{picking}”.</div> : null}
          {typeof decision === 'string' ? <div className="callout callout--err">{decision}</div> : null}
          {decision && typeof decision !== 'string' && state.from && state.to ? (
            <div className={cx('verdict', `verdict--${verdictTone(decision.verdict)}`)}>
              <div className="verdict__head">
                <VerdictIcon verdict={decision.verdict} size={18} />
                <strong>{VERDICT_TEXT[decision.verdict]}</strong>
                <span className="mono text-xs muted">
                  {partyIp(state.from, range, state.to)} → {partyIp(state.to, range, state.from)} {state.service.protocol}
                  {state.service.port !== undefined ? `/${state.service.port}` : ''}
                </span>
              </div>
              <p>{describe(decision)}</p>
              {decision.notes.length > 0 ? (
                <ul className="verdict__notes">
                  {decision.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
              {decision.trace.length > 0 ? (
                <details className="verdict__trace">
                  <summary>
                    Rules checked on the router ({decision.trace.length}
                    {decision.rule ? '' : ', then the chain policy'})
                  </summary>
                  <ol>
                    {decision.trace.map((step, i) => (
                      <li key={i} className={step.matched ? 'is-match' : undefined}>
                        <span className="mono text-xs">
                          {step.chain} #{step.position}
                        </span>{' '}
                        <span className="mono text-xs muted">{formatRule(step.rule)}</span>
                        <div className="text-xs">
                          {step.rule.comment}
                          {step.matched ? <Badge tone={verdictTone(step.rule.target)}>{step.rule.target}</Badge> : <span className="faint"> · no ({step.mismatch})</span>}
                        </div>
                      </li>
                    ))}
                    {!decision.rule && decision.hook !== 'NONE' ? <li className="is-match">{decision.reason}</li> : null}
                  </ol>
                </details>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="matrix__corner">from ↓ to →</th>
                {parties.map((p) => (
                  <th key={samePartyKey(p)} scope="col">
                    <span className="matrix__col">{partyLabel(p, range).replace(/^VPN client .*/, 'VPN').replace(/^Internet.*/, 'Internet')}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parties.map((from, i) => (
                <tr key={samePartyKey(from)}>
                  <th scope="row" className="truncate">
                    {partyLabel(from, range).replace(/^VPN client .*/, 'VPN').replace(/^Internet.*/, 'Internet')}
                  </th>
                  {parties.map((to, j) => {
                    const cell = grid[i]?.[j];
                    if (!cell) return <td key={j} className="matrix__self" />;
                    return (
                      <td key={j}>
                        <button
                          type="button"
                          className={cx('matrix__cell', `matrix__cell--${verdictTone(cell.verdict)}`)}
                          title={`${partyLabel(from, range)} → ${partyLabel(to, range)}: ${VERDICT_TEXT[cell.verdict]} (${cell.reason})`}
                          onClick={() => {
                            onChange({ ...state, from, to });
                            setView('trace');
                          }}
                        >
                          <VerdictIcon verdict={cell.verdict} size={12} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="field__hint">New connections for {serviceLabel(state.service)}. Click a cell to trace it. Replies to allowed connections always get back.</p>
        </div>
      )}
    </div>
  );
}
