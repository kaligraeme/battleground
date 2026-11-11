/**
 * The shape of a simulated run.
 *
 * A scenario is a pure description — plays, tasks, per-host results, how long
 * each task takes in the real world, and what each task changes — derived from
 * a range config. The runner (`runner.ts`) plays it back against the clock,
 * writes the log and applies the effects to the simulated world.
 */

import type { RangeConfig } from '@battleground/core';
import type { VmOs } from '../model';

export interface HostLine {
  host: string;
  result: 'ok' | 'changed' | 'skipping' | 'fatal' | 'included';
  /** Loop item label, printed as `=> (item=<label>)`. */
  item?: string;
  /** Pre-formatted text printed after `=>` (for example a JSON block with `msg`). May span lines. */
  body?: string;
  /** For `included` results: the task file that was included. */
  file?: string;
}

/** A change to the simulated world, applied when the task that carries it completes. */
export type Effect =
  | {
      kind: 'vm.create';
      name: string;
      hostname: string;
      template: string;
      os: VmOs;
      cpus: number;
      ramGb: number;
      isRouter: boolean;
      vlan?: number;
    }
  | { kind: 'vm.power'; name: string; on: boolean }
  | { kind: 'vm.ip'; name: string; ip: string }
  | { kind: 'router.configured' }
  | { kind: 'etchosts.written' };

export interface SimTask {
  /** Printed as `TASK [<name>]`. */
  name: string;
  lines: HostLine[];
  /** How long this task typically takes on a real range, in seconds. */
  seconds: number;
  effects?: Effect[];
  /** VMs this task is working on; drives the per-VM activity shown in the UI. */
  focus?: string[];
  /** The task fails and the run stops after it. Its last line must have result `fatal`. */
  fatal?: boolean;
}

/** Coarse phase of a deployment, for progress display. */
export type Stage = 'checks' | 'router' | 'network' | 'vms' | 'addressing' | 'dns' | 'domain' | 'windows' | 'software' | 'roles' | 'finish';

export const STAGES: readonly Stage[] = ['checks', 'router', 'network', 'vms', 'addressing', 'dns', 'domain', 'windows', 'software', 'roles', 'finish'];

export interface SimPlay {
  /** Printed as `PLAY [<name>]`. */
  name: string;
  stage: Stage;
  /** Hosts the play targets. Empty means the play prints `skipping: no hosts matched`. */
  hosts: string[];
  tasks: SimTask[];
}

export interface DeployScenario {
  plays: SimPlay[];
  /** True when the scenario ends in a fatal task. */
  fails: boolean;
}

export interface ExistingVm {
  /** Resolved VM name. */
  name: string;
  poweredOn: boolean;
  /** `"null"` when unknown. */
  ip: string;
}

export interface DeployInput {
  config: RangeConfig;
  rangeId: string;
  rangeNumber: number;
  /** Requested tags; `['all']` for a full deploy. */
  tags: string[];
  /** Ansible `--limit` pattern, if any. */
  limit?: string;
  /** Restrict user-defined roles to these names, if non-empty. */
  onlyRoles?: string[];
  entitlements: readonly string[];
  /** VMs that already exist in the range from earlier deploys. */
  existing: readonly ExistingVm[];
  /** True when an earlier deploy already configured the router. */
  routerConfigured: boolean;
  testingEnabled: boolean;
}

/** One step of a simulated template build. */
export interface PackerStep {
  /** Log lines without the timestamp prefix (the runner adds `YYYY/MM/DD hh:mm:ss `). */
  lines: string[];
  /** How long the step typically takes for real, in seconds. */
  seconds: number;
}

export interface PackerInput {
  /** Template name, e.g. `debian-12-x64-server-template`. */
  name: string;
  os: VmOs;
}

/** Per-host counters for the `PLAY RECAP` block. */
export interface RecapCounters {
  ok: number;
  changed: number;
  unreachable: number;
  failed: number;
  skipped: number;
  rescued: number;
  ignored: number;
}
