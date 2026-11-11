import {
  type RangeConfig,
  type TemplateInfo,
  type VmConfig,
  cloneJson,
  nextFreeOctet,
  parseYaml,
  stringifyDoc,
  syncDocument,
  templateStem,
} from '@battleground/core';
import { useCallback, useMemo, useRef, useState } from 'react';

const HISTORY_LIMIT = 200;

export interface DraftState {
  text: string;
  canUndo: boolean;
  canRedo: boolean;
  /** Replaces the text (typing in the editor). Rapid edits are merged into one undo step. */
  setText: (text: string) => void;
  /** Applies a structural change, keeping comments and layout elsewhere in the YAML. */
  apply: (mutate: (config: RangeConfig) => void) => boolean;
  undo: () => void;
  redo: () => void;
  /** Starts over from a new text (after a save, or loading a blueprint). */
  reset: (text: string, options?: { keepHistory?: boolean }) => void;
}

export function useDraft(initial: string): DraftState {
  const [text, setTextState] = useState(initial);
  const past = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const lastTyped = useRef(0);
  const [, force] = useState(0);
  const current = useRef(initial);

  const commit = useCallback((next: string, merge: boolean) => {
    if (next === current.current) return;
    if (!merge) {
      past.current.push(current.current);
      if (past.current.length > HISTORY_LIMIT) past.current.shift();
    }
    future.current = [];
    current.current = next;
    setTextState(next);
    force((n) => n + 1);
  }, []);

  const setText = useCallback(
    (next: string) => {
      const now = Date.now();
      // Keystrokes less than a second apart belong to the same undo step.
      commit(next, now - lastTyped.current < 1000 && past.current.length > 0);
      lastTyped.current = now;
    },
    [commit],
  );

  const apply = useCallback(
    (mutate: (config: RangeConfig) => void) => {
      const parsed = parseYaml(current.current);
      if (parsed.problems.length > 0) return false;
      const prev = (parsed.value && typeof parsed.value === 'object' ? parsed.value : {}) as RangeConfig;
      const next = cloneJson(prev);
      if (!Array.isArray(next.ludus)) next.ludus = [];
      mutate(next);
      const doc = syncDocument(parsed.doc, prev, next);
      lastTyped.current = 0;
      commit(stringifyDoc(doc), false);
      return true;
    },
    [commit],
  );

  const undo = useCallback(() => {
    const previous = past.current.pop();
    if (previous === undefined) return;
    future.current.push(current.current);
    current.current = previous;
    lastTyped.current = 0;
    setTextState(previous);
    force((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (next === undefined) return;
    past.current.push(current.current);
    current.current = next;
    lastTyped.current = 0;
    setTextState(next);
    force((n) => n + 1);
  }, []);

  const reset = useCallback((next: string, options: { keepHistory?: boolean } = {}) => {
    if (options.keepHistory) {
      if (next !== current.current) {
        past.current.push(current.current);
        future.current = [];
      }
    } else {
      past.current = [];
      future.current = [];
    }
    current.current = next;
    lastTyped.current = 0;
    setTextState(next);
    force((n) => n + 1);
  }, []);

  return useMemo(
    () => ({ text, canUndo: past.current.length > 0, canRedo: future.current.length > 0, setText, apply, undo, redo, reset }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [text, setText, apply, undo, redo, reset, past.current.length, future.current.length],
  );
}

// ---------------------------------------------------------------------------
// Building blocks for visual edits
// ---------------------------------------------------------------------------

/** The next VLAN to offer: tens first (10, 20, …), then anything free. */
export function nextVlan(config: RangeConfig): number {
  const used = new Set((config.ludus ?? []).map((vm) => vm.vlan));
  for (let vlan = 10; vlan <= 250; vlan += 10) if (!used.has(vlan)) return vlan;
  for (let vlan = 2; vlan <= 255; vlan++) if (!used.has(vlan)) return vlan;
  return 10;
}

function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** A sensible new machine for a template on a VLAN. */
export function newVm(config: RangeConfig, template: TemplateInfo, vlan: number): VmConfig {
  const stem = templateStem(template.name);
  const vms = config.ludus ?? [];
  const vmName = uniqueName(`{{ range_id }}-${stem.toLowerCase()}`, new Set(vms.map((vm) => vm.vm_name)));
  const suffix = vmName.slice(`{{ range_id }}-${stem.toLowerCase()}`.length);
  const hostname = `{{ range_id }}-${template.os === 'windows' ? stem.toUpperCase() : stem.toLowerCase()}${suffix}`;
  const start = template.kind === 'attacker' ? 1 : template.kind === 'workstation' ? 21 : 11;
  const vm: VmConfig = {
    vm_name: vmName,
    hostname,
    template: template.name,
    vlan,
    ip_last_octet: nextFreeOctet(config, vlan, start),
    ram_gb: template.ramGb,
    cpus: template.cpus,
  };
  if (template.os === 'windows') vm.windows = { sysprep: false };
  else if (template.os === 'macos') vm.macos = true;
  else vm.linux = true;
  // Attack boxes usually need to keep reaching the outside while the rest of the range is being tested.
  if (template.kind === 'attacker') vm.testing = { snapshot: false, block_internet: false };
  return vm;
}

/** Moves a machine to another VLAN, picking a free address there if its own is taken. */
export function moveVm(config: RangeConfig, index: number, vlan: number): void {
  const vm = config.ludus?.[index];
  if (!vm || vm.vlan === vlan) return;
  const clash = config.ludus.some((other, i) => i !== index && other.vlan === vlan && other.ip_last_octet === vm.ip_last_octet);
  vm.vlan = vlan;
  if (clash) vm.ip_last_octet = nextFreeOctet({ ludus: config.ludus.filter((_, i) => i !== index) }, vlan, vm.ip_last_octet);
}

/** Renumbers a VLAN everywhere it appears: machines and rules. */
export function renumberVlan(config: RangeConfig, from: number, to: number): void {
  for (const vm of config.ludus ?? []) if (vm.vlan === from) vm.vlan = to;
  for (const rule of config.network?.rules ?? []) {
    if (rule.vlan_src === from) rule.vlan_src = to;
    if (rule.vlan_dst === from) rule.vlan_dst = to;
  }
  if (config.router?.outbound_wireguard_vlans) config.router.outbound_wireguard_vlans = config.router.outbound_wireguard_vlans.map((v) => (v === from ? to : v));
}

/** Removes empty optional sections so visual edits do not leave `{}` behind. */
export function prune(config: RangeConfig): void {
  const net = config.network;
  if (net) {
    if (net.rules && net.rules.length === 0) delete net.rules;
    if (net.always_blocked_networks && net.always_blocked_networks.length === 0) delete net.always_blocked_networks;
    if (Object.keys(net).length === 0) delete config.network;
  }
  if (config.router && Object.keys(config.router).length === 0) delete config.router;
  if (config.defaults && Object.keys(config.defaults).length === 0) delete config.defaults;
}
