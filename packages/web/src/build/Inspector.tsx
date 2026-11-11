import {
  ACTIONS,
  type Action,
  FUNCTIONAL_LEVELS,
  type Issue,
  type NetworkRule,
  OFFICE_VERSIONS,
  PROTOCOLS,
  type RangeConfig,
  type VmConfig,
  VISUAL_STUDIO_VERSIONS,
  cloneJson,
  osFamilyOf,
  resolveRangeId,
  roleName,
  templateInfo,
  vmIp,
} from '@battleground/core';
import { ArrowDown, ArrowUp, Copy, Download, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { OsGlyph } from '../components/OsGlyph';
import { Badge, Button, Field, Segmented, Switch, cx } from '../components/ui';
import { type Meta, api } from '../lib/api';
import { useApp } from '../lib/store';
import { toast } from '../lib/toast';
import type { Selection } from '../topology/model';
import { moveVm, prune, renumberVlan } from './draft';

type Apply = (mutate: (config: RangeConfig) => void) => boolean;
type Path = ReadonlyArray<string | number>;

const samePath = (a: Path, b: Path) => a.length === b.length && a.every((v, i) => v === b[i]);

function fieldIssue(issues: readonly Issue[], path: Path): Issue | undefined {
  return issues.find((i) => samePath(i.path, path) && i.severity !== 'info');
}

/** A text box that commits on blur or Enter, so typing a name is one undo step. */
function TextInput({ value, onCommit, mono, placeholder, id, invalid, type = 'text' }: {
  value: string;
  onCommit: (value: string) => void;
  mono?: boolean;
  placeholder?: string;
  id?: string;
  invalid?: boolean;
  type?: string;
}) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => {
    if (local !== value) onCommit(local);
  };
  return (
    <input
      id={id}
      type={type}
      className={cx('input input--sm', mono && 'input--mono')}
      value={local}
      placeholder={placeholder}
      aria-invalid={invalid || undefined}
      onChange={(e) => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setLocal(value);
      }}
    />
  );
}

function NumberInput({ value, onCommit, min, max, step = 1, id, invalid }: { value: number | undefined; onCommit: (value: number | undefined) => void; min?: number; max?: number; step?: number; id?: string; invalid?: boolean }) {
  return (
    <TextInput
      id={id}
      mono
      invalid={invalid}
      value={value === undefined ? '' : String(value)}
      onCommit={(text) => {
        if (text.trim() === '') return onCommit(undefined);
        const n = Number(text);
        if (!Number.isFinite(n)) return;
        onCommit(Math.min(max ?? n, Math.max(min ?? n, step === 1 ? Math.round(n) : n)));
      }}
    />
  );
}

/** Comma-separated list editing for arrays of strings. */
function ListInput({ value, onCommit, placeholder, id }: { value: readonly string[] | undefined; onCommit: (value: string[] | undefined) => void; placeholder?: string; id?: string }) {
  return (
    <TextInput
      id={id}
      mono
      placeholder={placeholder}
      value={(value ?? []).join(', ')}
      onCommit={(text) => {
        const items = text
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        onCommit(items.length > 0 ? items : undefined);
      }}
    />
  );
}

function Section({ title, children, defaultOpen = true }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  return (
    <details className="insp-section" open={defaultOpen}>
      <summary className="section__title">{title}</summary>
      <div className="stack stack--tight">{children}</div>
    </details>
  );
}

function Issues({ issues }: { issues: readonly Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <div className="stack stack--tight" style={{ marginBottom: 10 }}>
      {issues.map((issue, i) => (
        <div key={i} className={cx('callout', issue.severity === 'error' ? 'callout--err' : issue.severity === 'warning' ? 'callout--warn' : 'callout--info')}>
          <TriangleAlert />
          <div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{issue.message}</div>
            {issue.hint ? <div className="faint text-xs">{issue.hint}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Machine
// ---------------------------------------------------------------------------

export function VmInspector({ config, index, apply, issues, meta, rangeId, rangeNumber, onSelect }: {
  config: RangeConfig;
  index: number;
  apply: Apply;
  issues: readonly Issue[];
  meta: Meta | null;
  rangeId: string;
  rangeNumber: number;
  onSelect: (selection: Selection) => void;
}) {
  const loadMeta = useApp((s) => s.loadMeta);
  const vm = config.ludus?.[index];
  if (!vm) return <div className="empty">That machine no longer exists.</div>;
  const os = osFamilyOf(vm);
  const at = (...rest: Array<string | number>): Path => ['ludus', index, ...rest];
  const issueAt = (...rest: Array<string | number>) => fieldIssue(issues, at(...rest));
  const own = issues.filter((i) => i.path[0] === 'ludus' && i.path[1] === index);
  const edit = (fn: (vm: VmConfig, config: RangeConfig) => void) =>
    apply((c) => {
      const target = c.ludus[index];
      if (target) fn(target, c);
      prune(c);
    });
  const domains = [...new Set((config.ludus ?? []).map((v) => v.domain?.fqdn).filter((d): d is string => Boolean(d)))];
  const templates = meta?.templates.filter((t) => t.available) ?? [];
  const info = templateInfo(vm.template);
  const installed = new Set(meta?.ansible.map((a) => a.name) ?? []);
  const roleNames = (vm.roles ?? []).map(roleName);
  const missingRoles = roleNames.filter((r) => !installed.has(r) && !(r.split('.').length === 3 && installed.has(r.split('.').slice(0, 2).join('.'))));

  return (
    <div className="inspector">
      <div className="insp-head">
        <OsGlyph os={os} large />
        <div className="grow">
          <h3 className="truncate">{resolveRangeId(String(vm.hostname), rangeId)}</h3>
          <div className="mono faint text-xs">{Number.isInteger(vm.vlan) && Number.isInteger(vm.ip_last_octet) ? vmIp(rangeNumber, vm.vlan, vm.ip_last_octet) : '—'}</div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          icon
          tip="Duplicate"
          onClick={() =>
            edit((_, c) => {
              const copy = cloneJson(vm);
              const taken = new Set(c.ludus.map((v) => v.vm_name));
              let n = 2;
              while (taken.has(`${vm.vm_name}-${n}`)) n++;
              copy.vm_name = `${vm.vm_name}-${n}`;
              copy.hostname = `${vm.hostname}-${n}`;
              const used = new Set(c.ludus.filter((v) => v.vlan === vm.vlan).map((v) => v.ip_last_octet));
              let octet = vm.ip_last_octet + 1;
              while (used.has(octet) && octet < 253) octet++;
              copy.ip_last_octet = octet;
              if (copy.domain?.role === 'primary-dc') copy.domain.role = 'alt-dc';
              c.ludus.splice(index + 1, 0, copy);
            })
          }
        >
          <Copy />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon
          tip="Remove machine"
          tipPos="left"
          onClick={() => {
            edit((_, c) => {
              c.ludus.splice(index, 1);
            });
            onSelect(null);
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <Issues issues={own} />

      <Section title="Machine">
        <Field label="Hostname" hint={os === 'windows' ? 'Windows uses the first 15 characters.' : undefined} error={issueAt('hostname')?.message} htmlFor="vm-hostname">
          <TextInput id="vm-hostname" mono value={String(vm.hostname ?? '')} invalid={Boolean(issueAt('hostname'))} onCommit={(v) => edit((t) => void (t.hostname = v))} />
        </Field>
        <Field label="VM name" hint="Use {{ range_id }} to insert the range ID." error={issueAt('vm_name')?.message} htmlFor="vm-name">
          <TextInput id="vm-name" mono value={String(vm.vm_name ?? '')} invalid={Boolean(issueAt('vm_name'))} onCommit={(v) => edit((t) => void (t.vm_name = v))} />
        </Field>
        <Field label="Template" error={issueAt('template')?.message} htmlFor="vm-template">
          <select
            id="vm-template"
            className="select select--sm"
            value={vm.template}
            aria-invalid={Boolean(issueAt('template')) || undefined}
            onChange={(e) => {
              const next = templateInfo(e.target.value, templates.find((t) => t.name === e.target.value)?.os === 'other' ? undefined : templates.find((t) => t.name === e.target.value)?.os);
              edit((t) => {
                t.template = e.target.value;
                // Keep the OS key in step with the template.
                const family = next.os === 'other' ? 'linux' : next.os;
                if (family !== osFamilyOf(t)) {
                  delete t.windows;
                  delete t.linux;
                  delete t.macos;
                  delete t.domain;
                  if (family === 'windows') t.windows = { sysprep: false };
                  else if (family === 'macos') t.macos = true;
                  else t.linux = true;
                }
              });
            }}
          >
            {!templates.some((t) => t.name === vm.template) ? <option value={vm.template}>{vm.template} (unknown)</option> : null}
            {templates.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
                {t.built ? '' : ' (not built)'}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="VLAN" error={issueAt('vlan')?.message} htmlFor="vm-vlan">
            <NumberInput id="vm-vlan" min={2} max={255} value={vm.vlan} invalid={Boolean(issueAt('vlan'))} onCommit={(v) => v !== undefined && apply((c) => moveVm(c, index, v))} />
          </Field>
          <Field label="Last octet" error={issueAt('ip_last_octet')?.message} htmlFor="vm-octet">
            <NumberInput id="vm-octet" min={1} max={253} value={vm.ip_last_octet} invalid={Boolean(issueAt('ip_last_octet'))} onCommit={(v) => v !== undefined && edit((t) => void (t.ip_last_octet = v))} />
          </Field>
          <Field label="vCPUs" error={issueAt('cpus')?.message} htmlFor="vm-cpus">
            <NumberInput id="vm-cpus" min={1} max={512} value={vm.cpus} onCommit={(v) => v !== undefined && edit((t) => void (t.cpus = v))} />
          </Field>
          <Field label="RAM (GB)" error={issueAt('ram_gb')?.message} htmlFor="vm-ram">
            <NumberInput id="vm-ram" min={1} max={4096} value={vm.ram_gb} onCommit={(v) => v !== undefined && edit((t) => void (t.ram_gb = v))} />
          </Field>
        </div>
        <p className="field__hint">
          Logs in as <span className="mono">{info.login}</span> · {info.services.join(', ')}
        </p>
      </Section>

      {os === 'windows' ? (
        <Section title="Windows">
          <Field label="Active Directory" row htmlFor="vm-domain">
            <Switch
              id="vm-domain"
              checked={Boolean(vm.domain)}
              onChange={(on) =>
                edit((t, c) => {
                  if (!on) delete t.domain;
                  else {
                    const fqdn = domains[0] ?? 'ludus.domain';
                    const hasDc = c.ludus.some((v) => v !== t && v.domain?.fqdn === fqdn && v.domain.role === 'primary-dc');
                    t.domain = { fqdn, role: hasDc ? 'member' : 'primary-dc' };
                  }
                })
              }
            />
          </Field>
          {vm.domain ? (
            <div className="grid-2">
              <Field label="Domain" error={issueAt('domain', 'fqdn')?.message} htmlFor="vm-fqdn">
                <TextInput id="vm-fqdn" mono value={vm.domain.fqdn} onCommit={(v) => edit((t) => void (t.domain && (t.domain.fqdn = v)))} />
              </Field>
              <Field label="Role" htmlFor="vm-role">
                <select
                  id="vm-role"
                  className="select select--sm"
                  value={vm.domain.role}
                  onChange={(e) =>
                    edit((t) => {
                      if (!t.domain) return;
                      t.domain.role = e.target.value as typeof vm.domain.role;
                      if (t.domain.role !== 'primary-dc' && t.windows) delete t.windows.gpos;
                    })
                  }
                >
                  <option value="primary-dc">Primary domain controller</option>
                  <option value="alt-dc">Additional domain controller</option>
                  <option value="member">Member</option>
                </select>
              </Field>
            </div>
          ) : null}
          {vm.domain?.role === 'primary-dc' ? (
            <div className="stack stack--tight">
              <span className="field__label">Group policies</span>
              {(['disable_defender', 'anon_share_access'] as const).map((gpo) => (
                <label key={gpo} className="row text-sm">
                  <input
                    type="checkbox"
                    checked={vm.windows?.gpos?.includes(gpo) ?? false}
                    onChange={(e) =>
                      edit((t) => {
                        t.windows ??= {};
                        const set = new Set(t.windows.gpos ?? []);
                        if (e.target.checked) set.add(gpo);
                        else set.delete(gpo);
                        if (set.size > 0) t.windows.gpos = [...set];
                        else delete t.windows.gpos;
                      })
                    }
                  />
                  {gpo === 'disable_defender' ? 'Disable Windows Defender (whole domain)' : 'Allow anonymous SMB share access'}
                </label>
              ))}
            </div>
          ) : null}
          {(
            [
              ['sysprep', 'Run sysprep first'],
              ['install_additional_tools', 'Install analyst tools (browsers, Wireshark, Burp…)'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label} row htmlFor={`vm-${key}`}>
              <Switch
                id={`vm-${key}`}
                checked={vm.windows?.[key] === true}
                onChange={(on) =>
                  edit((t) => {
                    t.windows ??= {};
                    if (on) t.windows[key] = true;
                    else if (key === 'sysprep') t.windows.sysprep = false;
                    else delete t.windows[key];
                  })
                }
              />
            </Field>
          ))}
          <Field label="Chocolatey packages" hint="Comma-separated" htmlFor="vm-choco">
            <ListInput id="vm-choco" placeholder="vscodium, googlechrome" value={vm.windows?.chocolatey_packages} onCommit={(v) => edit((t) => {
              t.windows ??= {};
              if (v) t.windows.chocolatey_packages = v;
              else delete t.windows.chocolatey_packages;
            })} />
          </Field>
          <div className="grid-2">
            <Field label="Office" htmlFor="vm-office">
              <select
                id="vm-office"
                className="select select--sm"
                value={vm.windows?.office_version ?? ''}
                onChange={(e) =>
                  edit((t) => {
                    t.windows ??= {};
                    if (e.target.value) {
                      t.windows.office_version = Number(e.target.value) as (typeof OFFICE_VERSIONS)[number];
                      t.windows.office_arch ??= '64bit';
                    } else {
                      delete t.windows.office_version;
                      delete t.windows.office_arch;
                    }
                  })
                }
              >
                <option value="">None</option>
                {OFFICE_VERSIONS.map((v) => (
                  <option key={v} value={v}>
                    Office {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Visual Studio" htmlFor="vm-vs">
              <select
                id="vm-vs"
                className="select select--sm"
                value={vm.windows?.visual_studio_version ?? ''}
                onChange={(e) =>
                  edit((t) => {
                    t.windows ??= {};
                    if (e.target.value) t.windows.visual_studio_version = Number(e.target.value) as (typeof VISUAL_STUDIO_VERSIONS)[number];
                    else delete t.windows.visual_studio_version;
                  })
                }
              >
                <option value="">None</option>
                {VISUAL_STUDIO_VERSIONS.map((v) => (
                  <option key={v} value={v}>
                    {v} Community
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Section>
      ) : null}

      {os === 'linux' ? (
        <Section title="Linux">
          <Field label="Packages to install" hint="Comma-separated" htmlFor="vm-packages">
            <ListInput
              id="vm-packages"
              placeholder="curl, nmap"
              value={typeof vm.linux === 'object' && vm.linux ? vm.linux.packages : undefined}
              onCommit={(v) => edit((t) => void (t.linux = v ? { packages: v } : true))}
            />
          </Field>
        </Section>
      ) : null}

      <Section title="Testing mode">
        <Field label="Snapshot and revert this machine" row htmlFor="vm-snap">
          <Switch
            id="vm-snap"
            checked={vm.testing?.snapshot !== false}
            onChange={(snapshot) =>
              edit((t) => {
                const block = t.testing?.block_internet !== false;
                if (snapshot && block) delete t.testing;
                else t.testing = { snapshot, block_internet: block };
              })
            }
          />
        </Field>
        <Field label="Cut off from the internet" row htmlFor="vm-block">
          <Switch
            id="vm-block"
            checked={vm.testing?.block_internet !== false}
            onChange={(block) =>
              edit((t) => {
                const snapshot = t.testing?.snapshot !== false;
                if (snapshot && block) delete t.testing;
                else t.testing = { snapshot, block_internet: block };
              })
            }
          />
        </Field>
      </Section>

      <Section title="Ansible roles" defaultOpen={roleNames.length > 0}>
        <Field label="Roles to apply, in order" hint="Comma-separated role names" error={issueAt('roles')?.message} htmlFor="vm-roles">
          <ListInput
            id="vm-roles"
            placeholder="geerlingguy.docker"
            value={roleNames}
            onCommit={(v) =>
              edit((t) => {
                if (!v) return void delete t.roles;
                const existing = new Map((t.roles ?? []).map((r) => [roleName(r), r]));
                t.roles = v.map((name) => existing.get(name) ?? name);
              })
            }
          />
        </Field>
        {missingRoles.map((role) => (
          <div key={role} className="callout callout--warn">
            <TriangleAlert />
            <span className="grow">
              <span className="mono">{role}</span> is not installed on the server.
            </span>
            <Button
              size="sm"
              onClick={async () => {
                try {
                  toast.ok((await api.installRole(role, role.split('.').length === 3 ? 'collection' : 'role')).result);
                  await loadMeta();
                } catch (err) {
                  toast.err('Install', err instanceof Error ? err.message : String(err));
                }
              }}
            >
              <Download />
              Install
            </Button>
          </div>
        ))}
      </Section>

      <Section title="Advanced" defaultOpen={false}>
        <Field label="DNS names pointing at this machine" hint="Exact names, or *.example.com for every subdomain" htmlFor="vm-rewrites">
          <ListInput id="vm-rewrites" placeholder="www.corp.example, *.corp.example" value={vm.dns_rewrites} onCommit={(v) => edit((t) => (v ? (t.dns_rewrites = v) : delete t.dns_rewrites))} />
        </Field>
        <Field label="Extra inventory groups" htmlFor="vm-groups">
          <ListInput id="vm-groups" value={vm.ansible_groups} onCommit={(v) => edit((t) => (v ? (t.ansible_groups = v) : delete t.ansible_groups))} />
        </Field>
        <div className="grid-2">
          <Field label="Primary DNS server" htmlFor="vm-dns1">
            <TextInput id="vm-dns1" mono placeholder="router" value={vm.primary_dns_server ?? ''} onCommit={(v) => edit((t) => (v ? (t.primary_dns_server = v) : delete t.primary_dns_server))} />
          </Field>
          <Field label="Minimum RAM (GB)" hint="Enables ballooning" htmlFor="vm-ram-min">
            <NumberInput id="vm-ram-min" min={0.5} step={0.5} value={vm.ram_min_gb} onCommit={(v) => edit((t) => (v === undefined ? delete t.ram_min_gb : (t.ram_min_gb = v)))} />
          </Field>
        </div>
        {(
          [
            ['full_clone', 'Full clone (slower, independent of the template)'],
            ['unmanaged', 'Unmanaged (no guest agent; configure it yourself)'],
            ['force_ip', 'Assume the configured address (no guest agent)'],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label} row htmlFor={`vm-${key}`}>
            <Switch id={`vm-${key}`} checked={vm[key] === true} onChange={(on) => edit((t) => (on ? (t[key] = true) : delete t[key]))} />
          </Field>
        ))}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// VLAN
// ---------------------------------------------------------------------------

export function VlanInspector({ config, vlan, apply, rangeNumber, onSelect }: { config: RangeConfig; vlan: number; apply: Apply; rangeNumber: number; onSelect: (s: Selection) => void }) {
  const members = (config.ludus ?? []).map((vm, index) => ({ vm, index })).filter(({ vm }) => vm.vlan === vlan);
  const used = new Set((config.ludus ?? []).map((vm) => vm.vlan));
  return (
    <div className="inspector">
      <div className="insp-head">
        <h3 className="grow">VLAN {vlan}</h3>
        <Button
          size="sm"
          variant="ghost"
          icon
          tip="Remove VLAN and its machines"
          tipPos="left"
          onClick={() => {
            if (members.length > 0 && !window.confirm(`Remove VLAN ${vlan} and its ${members.length} machine(s)?`)) return;
            apply((c) => {
              c.ludus = c.ludus.filter((vm) => vm.vlan !== vlan);
              if (c.network?.rules) c.network.rules = c.network.rules.filter((r) => r.vlan_src !== vlan && r.vlan_dst !== vlan);
              prune(c);
            });
            onSelect(null);
          }}
        >
          <Trash2 />
        </Button>
      </div>
      <Section title="Network">
        <Field label="VLAN number" hint={`Its network is 10.${rangeNumber}.${vlan}.0/24; the router is .254.`} htmlFor="vlan-number">
          <NumberInput
            id="vlan-number"
            min={2}
            max={255}
            value={vlan}
            onCommit={(to) => {
              if (to === undefined || to === vlan) return;
              if (used.has(to)) {
                toast.warn(`VLAN ${to} already exists`, 'Move machines onto it instead, or choose a free number.');
                return;
              }
              apply((c) => renumberVlan(c, vlan, to));
              onSelect({ kind: 'vlan', vlan: to });
            }}
          />
        </Field>
      </Section>
      <Section title={`Machines (${members.length})`}>
        <ul className="list">
          {members.map(({ vm, index }) => (
            <li key={index}>
              <button type="button" className="list__item" onClick={() => onSelect({ kind: 'vm', index })}>
                <OsGlyph os={osFamilyOf(vm)} />
                <span className="grow truncate mono text-sm">{vm.hostname}</span>
                <span className="mono faint text-xs">.{vm.ip_last_octet}</span>
              </button>
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function RouterInspector({ config, apply, meta, rangeId }: { config: RangeConfig; apply: Apply; meta: Meta | null; rangeId: string }) {
  const router = config.router ?? {};
  const edit = (fn: (r: NonNullable<RangeConfig['router']>) => void) =>
    apply((c) => {
      c.router ??= {};
      fn(c.router);
      prune(c);
    });
  const linux = meta?.templates.filter((t) => t.available && t.os === 'linux') ?? [];
  return (
    <div className="inspector">
      <div className="insp-head">
        <h3 className="grow">Router</h3>
      </div>
      <p className="muted text-sm" style={{ marginBottom: 10 }}>
        Every range gets a Debian router that routes between VLANs, filters traffic and serves DHCP and DNS. These settings are optional.
      </p>
      <Section title="Machine">
        <Field label="VM name" hint={`Default: ${rangeId}-router-debian13-x64`} htmlFor="router-name">
          <TextInput id="router-name" mono placeholder="{{ range_id }}-router-debian13-x64" value={router.vm_name ?? ''} onCommit={(v) => edit((r) => (v ? (r.vm_name = v) : delete r.vm_name))} />
        </Field>
        <Field label="Template" htmlFor="router-template">
          <select id="router-template" className="select select--sm" value={router.template ?? ''} onChange={(e) => edit((r) => (e.target.value ? (r.template = e.target.value) : delete r.template))}>
            <option value="">Default (debian-13-x64-server-template)</option>
            {linux.map((t) => (
              <option key={t.name} value={t.name}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid-2">
          <Field label="vCPUs" hint="Default 2" htmlFor="router-cpus">
            <NumberInput id="router-cpus" min={1} max={512} value={router.cpus} onCommit={(v) => edit((r) => (v === undefined ? delete r.cpus : (r.cpus = v)))} />
          </Field>
          <Field label="RAM (GB)" hint="Default 2" htmlFor="router-ram">
            <NumberInput id="router-ram" min={1} max={4096} value={router.ram_gb} onCommit={(v) => edit((r) => (v === undefined ? delete r.ram_gb : (r.ram_gb = v)))} />
          </Field>
        </div>
      </Section>
      <Section title="Extra firewall commands" defaultOpen={(router.iptables_commands?.length ?? 0) > 0}>
        <Field label="iptables commands, one per line" hint="Run after the firewall is built. They are not part of the traffic simulation." htmlFor="router-iptables">
          <textarea
            id="router-iptables"
            className="textarea textarea--mono"
            defaultValue={(router.iptables_commands ?? []).join('\n')}
            onBlur={(e) => {
              const lines = e.target.value
                .split('\n')
                .map((l) => l.trim())
                .filter(Boolean);
              edit((r) => (lines.length > 0 ? (r.iptables_commands = lines) : delete r.iptables_commands));
            }}
          />
        </Field>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Network rules
// ---------------------------------------------------------------------------

const SPECIAL: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All VLANs' },
  { value: 'public', label: 'Outside the range' },
  { value: 'wireguard', label: 'VPN clients' },
];

function EndpointPicker({ vlan, octet, vlans, onChange, label }: { vlan: NetworkRule['vlan_src']; octet: NetworkRule['ip_last_octet_src']; vlans: number[]; onChange: (vlan: NetworkRule['vlan_src'], octet: NetworkRule['ip_last_octet_src']) => void; label: string }) {
  const options = [...new Set([...vlans, ...(typeof vlan === 'number' ? [vlan] : [])])].sort((a, b) => a - b);
  return (
    <div className="rule-endpoint">
      <select
        className="select select--sm"
        aria-label={`${label} VLAN`}
        value={String(vlan)}
        onChange={(e) => {
          const v = e.target.value;
          const next = /^\d+$/.test(v) ? Number(v) : (v as NetworkRule['vlan_src']);
          onChange(next, next === 'all' || next === 'public' ? undefined : octet);
        }}
      >
        {options.map((v) => (
          <option key={v} value={v}>
            VLAN {v}
          </option>
        ))}
        {SPECIAL.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      {vlan !== 'all' && vlan !== 'public' ? (
        <TextInput
          mono
          placeholder="any host"
          value={octet === undefined ? '' : String(octet)}
          onCommit={(text) => {
            const t = text.trim();
            onChange(vlan, t === '' ? undefined : /^\d+$/.test(t) ? Number(t) : t);
          }}
        />
      ) : null}
    </div>
  );
}

function PolicyControl({ label, hint, value, onChange }: { label: string; hint: string; value: Action; onChange: (value: Action) => void }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <Segmented label={label} value={value} onChange={onChange} options={ACTIONS.map((a) => ({ value: a, label: a === 'ACCEPT' ? 'Allow' : a === 'REJECT' ? 'Reject' : 'Drop' }))} />
      <span className="field__hint">{hint}</span>
    </div>
  );
}

export function NetworkInspector({ config, apply, issues }: { config: RangeConfig; apply: Apply; issues: readonly Issue[] }) {
  const network = config.network ?? {};
  const rules = network.rules ?? [];
  const vlans = [...new Set((config.ludus ?? []).map((vm) => vm.vlan))].sort((a, b) => a - b);
  const edit = (fn: (n: NonNullable<RangeConfig['network']>) => void) =>
    apply((c) => {
      c.network ??= {};
      fn(c.network);
      prune(c);
    });
  const editRule = (index: number, fn: (rule: NetworkRule) => void) =>
    edit((n) => {
      const rule = n.rules?.[index];
      if (!rule) return;
      fn(rule);
      if (rule.ip_last_octet_src === undefined) delete rule.ip_last_octet_src;
      if (rule.ip_last_octet_dst === undefined) delete rule.ip_last_octet_dst;
    });

  return (
    <div className="inspector">
      <div className="insp-head">
        <h3 className="grow">Firewall</h3>
      </div>
      <Section title="Defaults">
        <PolicyControl label="Between VLANs" hint="When no rule matches traffic from one VLAN to another." value={network.inter_vlan_default ?? 'ACCEPT'} onChange={(v) => edit((n) => (v === 'ACCEPT' ? delete n.inter_vlan_default : (n.inter_vlan_default = v)))} />
        <PolicyControl label="Leaving the range" hint="Traffic to the internet and anything outside the range." value={network.external_default ?? 'ACCEPT'} onChange={(v) => edit((n) => (v === 'ACCEPT' ? delete n.external_default : (n.external_default = v)))} />
        <PolicyControl label="Machines to VPN clients" hint="Connections machines open towards VPN users (callbacks). VPN users can always reach machines." value={network.wireguard_vlan_default ?? 'REJECT'} onChange={(v) => edit((n) => (v === 'REJECT' ? delete n.wireguard_vlan_default : (n.wireguard_vlan_default = v)))} />
        <Field label="Never reachable from the range" hint="Networks in CIDR form, e.g. your office LAN" htmlFor="net-blocked">
          <ListInput id="net-blocked" placeholder="192.168.1.0/24" value={network.always_blocked_networks} onCommit={(v) => edit((n) => (v ? (n.always_blocked_networks = v) : delete n.always_blocked_networks))} />
        </Field>
      </Section>
      <Section title={`Rules (${rules.length})`}>
        <p className="field__hint">
          The router checks rules from the bottom of this list up, so when two rules overlap the lower one wins. Only the first packet of a connection is checked; replies are always allowed.
        </p>
        <ol className="rules">
          {rules.map((rule, index) => {
            const own = issues.filter((i) => i.path[0] === 'network' && i.path[1] === 'rules' && i.path[2] === index && i.severity !== 'info');
            return (
              <li key={index} className={cx('rule', own.some((i) => i.severity === 'error') && 'rule--error')}>
                <div className="row">
                  <TextInput mono value={rule.name} placeholder="Rule name" onCommit={(v) => editRule(index, (r) => void (r.name = v))} />
                  <select className="select select--sm rule__action" aria-label="Action" value={rule.action} onChange={(e) => editRule(index, (r) => void (r.action = e.target.value as Action))}>
                    {ACTIONS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="rule__grid">
                  <span className="faint text-xs">from</span>
                  <EndpointPicker label="Source" vlan={rule.vlan_src} octet={rule.ip_last_octet_src} vlans={vlans} onChange={(v, o) => editRule(index, (r) => { r.vlan_src = v; r.ip_last_octet_src = o; })} />
                  <span className="faint text-xs">to</span>
                  <EndpointPicker label="Destination" vlan={rule.vlan_dst} octet={rule.ip_last_octet_dst} vlans={vlans} onChange={(v, o) => editRule(index, (r) => { r.vlan_dst = v; r.ip_last_octet_dst = o; })} />
                  <span className="faint text-xs">using</span>
                  <div className="row">
                    <select
                      className="select select--sm"
                      aria-label="Protocol"
                      style={{ width: 100 }}
                      value={rule.protocol}
                      onChange={(e) =>
                        editRule(index, (r) => {
                          r.protocol = e.target.value as NetworkRule['protocol'];
                          if (!['tcp', 'udp', 'sctp'].includes(r.protocol)) r.ports = 'all';
                        })
                      }
                    >
                      {PROTOCOLS.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>
                    <TextInput mono placeholder="all, 443, 80,443 or 8000:8100" value={String(rule.ports)} onCommit={(v) => editRule(index, (r) => void (r.ports = /^\d+$/.test(v.trim()) ? Number(v.trim()) : v.trim() || 'all'))} />
                  </div>
                </div>
                {own.map((issue, i) => (
                  <div key={i} className={cx('text-xs', issue.severity === 'error' ? 'text-err' : 'text-warn')}>
                    {issue.message}
                  </div>
                ))}
                <div className="rule__tools">
                  <Button size="sm" variant="ghost" icon tip="Move up" disabled={index === 0} onClick={() => edit((n) => { const list = n.rules ?? []; [list[index - 1], list[index]] = [list[index] as NetworkRule, list[index - 1] as NetworkRule]; })}>
                    <ArrowUp />
                  </Button>
                  <Button size="sm" variant="ghost" icon tip="Move down" disabled={index === rules.length - 1} onClick={() => edit((n) => { const list = n.rules ?? []; [list[index + 1], list[index]] = [list[index] as NetworkRule, list[index + 1] as NetworkRule]; })}>
                    <ArrowDown />
                  </Button>
                  <Button size="sm" variant="ghost" icon tip="Delete rule" onClick={() => edit((n) => void n.rules?.splice(index, 1))}>
                    <Trash2 />
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
        <Button
          size="sm"
          onClick={() =>
            edit((n) => {
              n.rules ??= [];
              n.rules.push({ name: `Rule ${n.rules.length + 1}`, vlan_src: vlans[0] ?? 'all', vlan_dst: vlans[1] ?? vlans[0] ?? 'all', protocol: 'tcp', ports: 443, action: 'ACCEPT' });
            })
          }
        >
          <Plus />
          Add rule
        </Button>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range-wide defaults
// ---------------------------------------------------------------------------

export function DefaultsInspector({ config, apply }: { config: RangeConfig; apply: Apply }) {
  const d = config.defaults ?? {};
  const edit = (fn: (d: NonNullable<RangeConfig['defaults']>) => void) =>
    apply((c) => {
      c.defaults ??= {};
      fn(c.defaults);
      prune(c);
    });
  const text = (key: 'ad_domain_admin' | 'ad_domain_admin_password' | 'ad_domain_user' | 'ad_domain_user_password' | 'ad_domain_safe_mode_password' | 'timezone', label: string, placeholder: string) => (
    <Field label={label} htmlFor={`def-${key}`}>
      <TextInput id={`def-${key}`} mono placeholder={placeholder} value={d[key] ?? ''} onCommit={(v) => edit((x) => (v ? (x[key] = v) : delete x[key]))} />
    </Field>
  );
  return (
    <div className="inspector">
      <div className="insp-head">
        <h3 className="grow">Range settings</h3>
      </div>
      <Section title="Active Directory">
        <div className="grid-2">
          {text('ad_domain_admin', 'Domain admin', 'domainadmin')}
          {text('ad_domain_admin_password', 'Admin password', 'password')}
          {text('ad_domain_user', 'Domain user', 'domainuser')}
          {text('ad_domain_user_password', 'User password', 'password')}
        </div>
        {text('ad_domain_safe_mode_password', 'Safe mode password', 'password')}
        <div className="grid-2">
          {(['ad_domain_functional_level', 'ad_forest_functional_level'] as const).map((key) => (
            <Field key={key} label={key === 'ad_domain_functional_level' ? 'Domain level' : 'Forest level'} htmlFor={`def-${key}`}>
              <select id={`def-${key}`} className="select select--sm" value={d[key] ?? ''} onChange={(e) => edit((x) => (e.target.value ? (x[key] = e.target.value as (typeof FUNCTIONAL_LEVELS)[number]) : delete x[key]))}>
                <option value="">Default (Win2012R2)</option>
                {FUNCTIONAL_LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          ))}
        </div>
      </Section>
      <Section title="Machines">
        {text('timezone', 'Time zone', 'America/New_York')}
        <Field label="Snapshot memory when testing starts" row htmlFor="def-ram">
          <Switch id="def-ram" checked={d.snapshot_with_RAM !== false} onChange={(on) => edit((x) => (on ? delete x.snapshot_with_RAM : (x.snapshot_with_RAM = false)))} />
        </Field>
        <Field label="Red/green testing-mode wallpaper on Windows" row htmlFor="def-wall">
          <Switch id="def-wall" checked={d.enable_dynamic_wallpaper !== false} onChange={(on) => edit((x) => (on ? delete x.enable_dynamic_wallpaper : (x.enable_dynamic_wallpaper = false)))} />
        </Field>
      </Section>
      <Badge plain>Leave a field empty to use the server default.</Badge>
    </div>
  );
}
