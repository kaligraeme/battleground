/**
 * The simulated range host: users, ranges, machines, templates, jobs.
 *
 * Every operation mirrors what a Ludus server does for the same API call:
 * the same checks in the same order, the same messages, the same state
 * changes. Where Ludus would talk to a hypervisor or run Ansible, this plays
 * back a simulation instead (see `sim/`).
 */

import { join } from 'node:path';
import {
  BUILTIN_TEMPLATES,
  DEFAULT_RANGE_CONFIG,
  type RangeConfig,
  TEMPLATE_CATALOG,
  type TestingAllow,
  hasRoles,
  osFamilyOf,
  parseYaml,
  resolveRangeId,
  resolveRoleOrder,
  templateInfo,
  validateConfigText,
} from '@battleground/core';
import { ApiError, badRequest, conflict, forbidden, notFound, serverError, unauthorized } from './http/errors';
import { digest, fakeWireguardKey, hashPassword, newApiKey, newToken, randomPassword, recordId, safeEqualHex, verifyPassword } from './ids';
import { LogStore, sliceLog } from './logs';
import {
  type BlueprintRec,
  type GroupRec,
  type LogHistoryRec,
  type RangeRec,
  type RangeState,
  type SnapshotRec,
  type State,
  type TemplateRec,
  type UserRec,
  type VmOs,
  type VmRec,
  ZERO_TIME,
  emptyState,
} from './model';
import { decrypt, encrypt, newSecretKey } from './secrets';
import { AbortedError, SimClock } from './sim/clock';
import { BUILD_COMPLETE, buildPackerScenario } from './sim/packer';
import { type RunProgress, runScenario } from './sim/runner';
import { buildDeployScenario } from './sim/scenario';
import { type TestingTag, buildTestingScenario } from './sim/testingScenario';
import type { Effect } from './sim/types';
import { formatRecap, playBanner, taskBanner } from './sim/ansibleLog';
import { Store } from './store';

export const DEPLOY_TAGS = [
  'all',
  'access-control',
  'additional-tools',
  'allow-share-access',
  'assign-ip',
  'bootstrap-auth',
  'custom-choco',
  'custom-groups',
  'dcs',
  'debug',
  'dns-rewrites',
  'domain-join',
  'install-office',
  'install-visual-studio',
  'linux-packages',
  'network',
  'nexus',
  'share',
  'sysprep',
  'user-defined-roles',
  'vm-deploy',
  'windows',
];

/** What `GET /range/tags` lists (derived from the playbook, so it differs slightly from the allow-list). */
export const LISTED_TAGS = [
  'access-control',
  'additional-tools',
  'allow-share-access',
  'assign-ip',
  'bootstrap-auth',
  'custom-choco',
  'custom-groups',
  'dcs',
  'debug',
  'dns-rewrites',
  'domain-join',
  'generate-rdp',
  'install-office',
  'install-visual-studio',
  'linux-packages',
  'network',
  'nexus',
  'share',
  'sysprep',
  'user-defined-roles',
  'user-management',
  'vm-deploy',
  'windows',
];

const RESERVED_USER_IDS = ['ADMIN', 'ROOT', 'CICD', 'SHARED', '0'];
const USER_ID_RE = /^[A-Za-z][A-Za-z0-9]{0,19}$/;
export const RANGE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*(\/[A-Za-z0-9_-]+){0,2}$/;
const GROUP_NAME_RE = /^[A-Za-z0-9_-]+$/;
const MAX_LOG_HISTORY = 100;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const TESTING_SNAPSHOT = 'ludus_automated_clean_snapshot';
/** Longest a request that waits on a simulated playbook may take per task, in real ms. */
const MAX_TASK_MS = 1500;

export interface WorldOptions {
  dataDir: string | null;
  speed?: number;
  templatesPrebuilt: boolean;
  /** Resolves a domain for testing-mode allow lists. Defaults to real DNS. */
  resolveDomain?: (domain: string) => Promise<string | undefined>;
}

interface DeployJob {
  controller: AbortController;
  done: Promise<void>;
  progress: RunProgress | null;
  logId: string;
  tags: string[];
  startedAt: string;
}

interface BuildJob {
  template: string;
  user: string;
  controller: AbortController;
  logId: string;
  logKey: string;
}

interface QueuedBuild {
  template: string;
  user: string;
}

const now = () => new Date().toISOString();

async function defaultResolve(domain: string): Promise<string | undefined> {
  const { resolve4 } = await import('node:dns/promises');
  try {
    const answer = await Promise.race([resolve4(domain), new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]);
    return answer[0];
  } catch {
    return undefined;
  }
}

export class World {
  readonly store: Store<State>;
  readonly logs: LogStore;
  readonly clock: SimClock;
  readonly node = 'battleground';
  /** The range host's own addresses (simulated; ranges are never allowed to reach them). */
  readonly hostLocalIp = '203.0.113.10';
  readonly hostPublicIp = '203.0.113.10';
  readonly entitlements: readonly string[] = [];
  private readonly deployJobs = new Map<string, DeployJob>();
  private readonly builds = new Map<string, BuildJob>();
  private readonly queue: QueuedBuild[] = [];
  private parallel = 1;
  private readonly resolveDomain: (domain: string) => Promise<string | undefined>;
  private readonly loginFailures = new Map<string, number[]>();
  /** Operations that hold a range for a while (testing, destroy), to keep them from overlapping. */
  private readonly busy = new Set<string>();

  constructor(options: WorldOptions) {
    this.store = new Store<State>(options.dataDir ? join(options.dataDir, 'state.json') : null, () =>
      emptyState(options.speed ?? 60, newSecretKey(), fakeWireguardKey()),
    );
    this.logs = new LogStore(options.dataDir ? join(options.dataDir, 'logs') : null);
    this.clock = new SimClock(() => this.state.settings.speed);
    this.resolveDomain = options.resolveDomain ?? defaultResolve;
    if (options.speed !== undefined) this.state.settings.speed = options.speed;
    this.reconcile(options);
  }

  get state(): State {
    return this.store.state;
  }

  save(): void {
    this.store.touch();
  }

  /** Brings persisted state back to a consistent picture after a restart, as a Ludus server does. */
  private reconcile(options: WorldOptions): void {
    const s = this.state;
    if (Object.keys(s.templates).length === 0) {
      for (const template of BUILTIN_TEMPLATES) {
        s.templates[template.name] = {
          name: template.name,
          os: template.os,
          builtin: true,
          built: options.templatesPrebuilt,
          status: options.templatesPrebuilt ? 'built' : 'not_built',
          vmid: options.templatesPrebuilt ? s.nextVmId++ : undefined,
        };
      }
    }
    for (const template of Object.values(s.templates)) {
      if (template.status === 'building') template.status = template.built ? 'built' : 'not_built';
    }
    for (const range of Object.values(s.ranges)) {
      if (range.rangeState === 'DEPLOYING') range.rangeState = 'ABORTED';
      if (range.rangeState === 'DESTROYING') range.rangeState = 'ERROR';
    }
    for (const entry of s.logHistory) {
      if (entry.status === 'running') {
        entry.status = 'aborted';
        entry.end = now();
      }
    }
    const nowMs = Date.now();
    for (const [key, session] of Object.entries(s.sessions)) if (session.expires < nowMs) delete s.sessions[key];
    this.save();
  }

  // =========================================================================
  // Users and authentication
  // =========================================================================

  user(userID: string): UserRec | undefined {
    return this.state.users[userID];
  }

  async createUser(input: { userID?: string; name?: string; email?: string; isAdmin?: boolean; password?: string }): Promise<{ user: UserRec; apiKey: string; password: string }> {
    const userID = input.userID ?? '';
    const name = input.name ?? '';
    if (!name || !userID) throw badRequest('Name and userID are required');
    if (!USER_ID_RE.test(userID)) throw badRequest('provided userID does not match ^[A-Za-z0-9]{1,20}$');
    if (RESERVED_USER_IDS.includes(userID)) throw badRequest(`${userID} is a reserved user ID`);
    if (!input.email) throw badRequest('Email is required');
    if (input.password !== undefined && input.password !== '' && input.password.length < 8) throw badRequest('Password must be at least 8 characters long');
    if (this.state.users[userID]) throw badRequest('User with that ID already exists');
    const proxmoxUsername = name.toLowerCase().replace(/ /g, '-');
    if (Object.values(this.state.users).some((u) => u.proxmoxUsername === proxmoxUsername)) throw badRequest('User with that name already exists');
    if (this.state.ranges[userID]) throw badRequest(`Pool with the name ${userID} already exists`);
    const used = new Set(Object.values(this.state.users).map((u) => u.userNumber));
    let userNumber = 2;
    while (used.has(userNumber)) userNumber++;
    if (userNumber > 150) throw serverError('Error provisioning user: cannot create more than 150 users');

    const password = input.password || randomPassword(15);
    const apiKey = newApiKey(userID);
    const created = now();
    const user: UserRec = {
      id: recordId(),
      userID,
      userNumber,
      name,
      email: input.email,
      isAdmin: input.isAdmin === true,
      proxmoxUsername,
      passwordHash: await hashPassword(password),
      passwordEnc: encrypt(password, this.state.settings.secretKey),
      apiKeyHash: digest(apiKey),
      defaultRangeID: '',
      rangeIDs: [],
      dateCreated: created,
      dateLastActive: created,
      wireguard: { privateKey: fakeWireguardKey(), publicKey: fakeWireguardKey() },
    };
    this.state.users[userID] = user;
    // A new user's default range starts from the example config with their ID filled in.
    const range = this.newRange({
      rangeID: userID,
      name: `Default Range for ${name}`,
      description: 'Default range created automatically for user',
      purpose: 'General testing and development',
      config: resolveRangeId(DEFAULT_RANGE_CONFIG, userID),
    });
    user.rangeIDs.push(range.rangeID);
    user.defaultRangeID = range.rangeID;
    this.save();
    return { user, apiKey, password };
  }

  authenticateKey(key: string): UserRec {
    const parts = key.split('.');
    if (parts.length !== 2) throw unauthorized('Malformed API Key provided');
    const userID = parts[0] as string;
    const user = this.state.users[userID];
    if (!user) throw unauthorized(`User ${userID} from API key not found`);
    if (!safeEqualHex(digest(key), user.apiKeyHash)) throw unauthorized('Invalid API key');
    return user;
  }

  rotateApiKey(user: UserRec): string {
    const key = newApiKey(user.userID);
    user.apiKeyHash = digest(key);
    this.save();
    return key;
  }

  password(user: UserRec): string {
    return decrypt(user.passwordEnc, this.state.settings.secretKey);
  }

  async setPassword(user: UserRec, password: string): Promise<void> {
    user.passwordHash = await hashPassword(password);
    user.passwordEnc = encrypt(password, this.state.settings.secretKey);
    this.save();
  }

  async login(login: string, password: string): Promise<{ token: string; user: UserRec }> {
    const key = login.toLowerCase();
    const recent = (this.loginFailures.get(key) ?? []).filter((t) => t > Date.now() - 5 * 60_000);
    if (recent.length >= 10) throw new ApiError(429, 'Too many failed sign-in attempts. Try again in a few minutes.');
    const user = Object.values(this.state.users).find((u) => u.email.toLowerCase() === key || u.userID.toLowerCase() === key);
    const valid = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !valid) {
      recent.push(Date.now());
      this.loginFailures.set(key, recent);
      throw unauthorized('Invalid email/user ID or password');
    }
    this.loginFailures.delete(key);
    const token = newToken();
    this.state.sessions[digest(token)] = { userID: user.userID, created: Date.now(), expires: Date.now() + SESSION_TTL_MS };
    this.save();
    return { token, user };
  }

  sessionUser(token: string): UserRec | undefined {
    const session = this.state.sessions[digest(token)];
    if (!session || session.expires < Date.now()) return undefined;
    return this.state.users[session.userID];
  }

  logout(token: string): void {
    delete this.state.sessions[digest(token)];
    this.save();
  }

  touch(user: UserRec, range: RangeRec | undefined): void {
    const t = Date.now();
    if (t - Date.parse(user.dateLastActive) > 30_000) {
      user.dateLastActive = new Date(t).toISOString();
      this.save();
    }
    if (range && t - Date.parse(range.lastActive) > 30_000) {
      range.lastActive = new Date(t).toISOString();
      this.save();
    }
  }

  userView(user: UserRec) {
    return {
      name: user.name,
      userID: user.userID,
      userNumber: user.userNumber,
      dateCreated: user.dateCreated,
      dateLastActive: user.dateLastActive,
      isAdmin: user.isAdmin,
      proxmoxUsername: user.proxmoxUsername,
    };
  }

  deleteUser(caller: UserRec, userID: string, deleteDefaultRange: boolean): void {
    if (caller.userID === userID) throw badRequest('You cannot remove yourself');
    if (userID === 'ROOT') throw badRequest('You cannot delete the root user');
    const user = this.state.users[userID];
    if (!user) throw serverError('User was not found in the Ludus database: sql: no rows in result set');
    if (deleteDefaultRange && user.defaultRangeID && this.state.ranges[user.defaultRangeID]) {
      this.removeRange(this.state.ranges[user.defaultRangeID] as RangeRec);
    }
    for (const group of Object.values(this.state.groups)) {
      group.members = group.members.filter((id) => id !== userID);
      group.managers = group.managers.filter((id) => id !== userID);
    }
    for (const blueprint of Object.values(this.state.blueprints)) {
      if (blueprint.ownerUserID === userID) blueprint.ownerUserID = caller.userID;
      blueprint.sharedUsers = blueprint.sharedUsers.filter((id) => id !== userID);
    }
    for (const [key, session] of Object.entries(this.state.sessions)) if (session.userID === userID) delete this.state.sessions[key];
    this.state.ansible = this.state.ansible.filter((item) => item.userID !== userID);
    delete this.state.users[userID];
    this.save();
  }

  // =========================================================================
  // Ranges: lookup and access
  // =========================================================================

  range(rangeID: string): RangeRec | undefined {
    return this.state.ranges[rangeID];
  }

  groupsOf(user: UserRec): GroupRec[] {
    return Object.values(this.state.groups).filter((g) => g.members.includes(user.userID) || g.managers.includes(user.userID));
  }

  /** How a user reaches a range: directly, through a group, or not at all. */
  accessType(user: UserRec, range: RangeRec): 'Direct' | 'Group' | undefined {
    if (user.rangeIDs.includes(range.rangeID)) return 'Direct';
    if (this.groupsOf(user).some((g) => g.rangeIDs.includes(range.rangeID))) return 'Group';
    return undefined;
  }

  hasAccess(user: UserRec, range: RangeRec): boolean {
    return this.accessType(user, range) !== undefined;
  }

  /** Users whose VPN clients the range router lets in, sorted by user ID. */
  grants(range: RangeRec): Array<{ userID: string; userNumber: number; name: string; accessType: string }> {
    const out = new Map<string, { userID: string; userNumber: number; name: string; accessType: string }>();
    for (const user of Object.values(this.state.users)) {
      if (user.rangeIDs.includes(range.rangeID)) out.set(user.userID, { userID: user.userID, userNumber: user.userNumber, name: user.name, accessType: 'Direct' });
    }
    for (const group of Object.values(this.state.groups)) {
      if (!group.rangeIDs.includes(range.rangeID)) continue;
      for (const [ids, accessType] of [
        [group.members, 'Group Member'],
        [group.managers, 'Group Manager'],
      ] as const) {
        for (const id of ids) {
          const user = this.state.users[id];
          if (user && !out.has(id)) out.set(id, { userID: id, userNumber: user.userNumber, name: user.name, accessType });
        }
      }
    }
    return [...out.values()].sort((a, b) => (a.userID < b.userID ? -1 : a.userID > b.userID ? 1 : 0));
  }

  /** Ranges a user can reach, as `GET /ranges/accessible` lists them. */
  accessibleRanges(user: UserRec): Array<{ rangeNumber: number; rangeID: string; accessType: 'Direct' | 'Group' }> {
    const out: Array<{ rangeNumber: number; rangeID: string; accessType: 'Direct' | 'Group' }> = [];
    for (const id of user.rangeIDs) {
      const range = this.state.ranges[id];
      if (range) out.push({ rangeNumber: range.rangeNumber, rangeID: id, accessType: 'Direct' });
    }
    for (const group of this.groupsOf(user)) {
      for (const id of group.rangeIDs) {
        const range = this.state.ranges[id];
        if (range) out.push({ rangeNumber: range.rangeNumber, rangeID: id, accessType: 'Group' });
      }
    }
    return out.sort((a, b) => a.rangeNumber - b.rangeNumber);
  }

  private newRange(input: { rangeID: string; name: string; description: string; purpose: string; config: string; rangeNumber?: number }): RangeRec {
    let rangeNumber = input.rangeNumber;
    if (!rangeNumber || rangeNumber <= 0) {
      const used = new Set(Object.values(this.state.ranges).map((r) => r.rangeNumber));
      rangeNumber = 1;
      while (used.has(rangeNumber)) rangeNumber++;
    }
    const created = now();
    const range: RangeRec = {
      id: recordId(),
      rangeID: input.rangeID,
      rangeNumber,
      name: input.name,
      description: input.description,
      purpose: input.purpose,
      config: input.config,
      rangeState: 'NEVER DEPLOYED',
      lastDeployment: ZERO_TIME,
      testingEnabled: false,
      allowedIPs: [],
      allowedDomains: [],
      vms: [],
      routerConfigured: false,
      etcHostsWritten: false,
      created,
      updated: created,
      lastActive: created,
    };
    this.state.ranges[range.rangeID] = range;
    return range;
  }

  async createRange(
    input: { name?: string; rangeID?: string; description?: string; purpose?: string; userID?: string[] | null; rangeNumber?: number; blueprintID?: string },
    caller: UserRec,
  ): Promise<string> {
    const blueprint = input.blueprintID ? this.blueprintFor(caller, input.blueprintID, 'lower') : undefined;
    const userIDs = (input.userID ?? []).filter(Boolean);
    const missing = userIDs.filter((id) => !this.state.users[id]);
    if (missing.length > 0) {
      throw new ApiError(500, 'Error finding user', { errors: missing.map((userID) => ({ userID, error: 'Error finding user: sql: no rows in result set' })) });
    }
    const rangeID = input.rangeID ?? '';
    if (!rangeID) throw badRequest('Range ID is required');
    if (!RANGE_ID_RE.test(rangeID)) {
      throw conflict(
        "Range ID name must be a valid proxmox pool name (e.g. 'DEMO', 'my-range' or 'New_Range'). Use only letters, numbers, hyphens, and underscores. Must start with a letter.",
      );
    }
    if (this.state.ranges[rangeID]) throw conflict(`Range ID ${rangeID} already in use`);
    if (input.rangeNumber && input.rangeNumber > 0 && Object.values(this.state.ranges).some((r) => r.rangeNumber === input.rangeNumber)) {
      throw conflict(`Range number ${input.rangeNumber} already in use`);
    }
    if (!input.name) throw conflict('Unable to save range: name: Cannot be blank.');
    const range = this.newRange({
      rangeID,
      name: input.name,
      description: input.description ?? '',
      purpose: input.purpose ?? '',
      config: DEFAULT_RANGE_CONFIG,
      rangeNumber: input.rangeNumber,
    });
    for (const id of userIDs) {
      const user = this.state.users[id] as UserRec;
      if (!user.rangeIDs.includes(rangeID)) user.rangeIDs.push(rangeID);
    }
    this.save();
    if (blueprint) {
      try {
        this.writeConfig(range, caller, blueprint.config, false);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw serverError(
          `Range ${rangeID} was created but applying blueprint "${blueprint.blueprintID}" failed: ${message}. Run 'ludus blueprint apply ${blueprint.blueprintID} --target-range ${rangeID}' to retry.`,
        );
      }
      return `Range ${rangeID} created and blueprint ${blueprint.blueprintID} applied`;
    }
    return `Range ${rangeID} created successfully`;
  }

  /** `GET /range` / `GET /range/all` shape. */
  rangeView(range: RangeRec, details = false) {
    const vms = [...range.vms].sort((a, b) => a.proxmoxID - b.proxmoxID);
    return {
      rangeState: range.rangeState,
      rangeNumber: range.rangeNumber,
      ...(range.description ? { description: range.description } : {}),
      ...(range.purpose ? { purpose: range.purpose } : {}),
      lastDeployment: range.lastDeployment,
      testingEnabled: range.testingEnabled,
      VMs: vms.map((vm) => this.vmView(range, vm, details)),
      rangeID: range.rangeID,
      name: range.name,
      numberOfVMs: range.vms.length,
      ...(range.allowedIPs.length > 0 ? { allowedIPs: range.allowedIPs } : {}),
      ...(range.allowedDomains.length > 0 ? { allowedDomains: range.allowedDomains } : {}),
    };
  }

  vmView(range: RangeRec, vm: VmRec, details: boolean) {
    const view: Record<string, unknown> = {
      proxmoxID: vm.proxmoxID,
      rangeNumber: range.rangeNumber,
      name: vm.name,
      poweredOn: vm.poweredOn,
      ip: vm.poweredOn ? vm.ip || 'null' : 'null',
      ...(vm.isRouter ? { isRouter: true } : {}),
      cpu: vm.cpu,
      ram: vm.ram,
      ID: 0,
    };
    if (details) {
      if (!vm.poweredOn) Object.assign(view, { osVersion: 'N/A', licenseStatus: 'N/A', lastUpdate: 'N/A' });
      else if (vm.os === 'windows') {
        const info = templateInfo(vm.template, 'windows');
        Object.assign(view, {
          osVersion: `Microsoft ${info.label.replace(/^Windows Server/, 'Windows Server')} ${info.kind === 'server' ? 'Standard Evaluation' : 'Enterprise Evaluation'}`,
          licenseStatus: 'Licensed (179 days, 5 rearms)',
          lastUpdate: range.created.slice(0, 10),
        });
      } else {
        const label = vm.template.startsWith('kali') ? 'Kali GNU/Linux Rolling' : vm.template.includes('debian-13') ? 'Debian GNU/Linux 13 (trixie)' : vm.template.includes('debian-12') ? 'Debian GNU/Linux 12 (bookworm)' : templateInfo(vm.template).label;
        Object.assign(view, { osVersion: label, licenseStatus: 'N/A', lastUpdate: 'N/A' });
      }
    }
    return view;
  }

  /** The parsed config of a range (configs are validated on save, but a stored one may predate that). */
  configOf(range: RangeRec): RangeConfig | undefined {
    const parsed = parseYaml(range.config);
    if (parsed.problems.length > 0 || !parsed.value || typeof parsed.value !== 'object') return undefined;
    return parsed.value as RangeConfig;
  }

  builtTemplates(): Set<string> {
    return new Set(Object.values(this.state.templates).filter((t) => t.built).map((t) => t.name));
  }

  ansibleFor(user: UserRec) {
    return this.state.ansible.filter((item) => item.global || item.userID === user.userID);
  }

  /** Validates and stores a config, as `PUT /range/config` and blueprint apply do. */
  writeConfig(range: RangeRec, user: UserRec, text: string, force: boolean): void {
    if (range.testingEnabled && !force) {
      throw conflict('Testing is enabled; to prevent conflicts, the config cannot be updated while testing is enabled. Use --force to override.');
    }
    const result = validateConfigText(text, {
      rangeId: range.rangeID,
      userId: user.userID,
      builtTemplates: this.builtTemplates(),
      knownTemplates: new Set(Object.keys(this.state.templates)),
      ansible: this.ansibleFor(user),
      nodes: [this.node],
      lint: false,
    });
    if (result.ludusError !== undefined) {
      if (result.issues.some((issue) => issue.source === 'roles')) {
        range.rangeState = 'ERROR';
        this.save();
      }
      throw badRequest(`Configuration error: ${result.ludusError}`);
    }
    if (result.config && hasRoles(result.config)) this.writeRoleResolutionLog(range, result.config);
    range.config = text;
    range.updated = now();
    this.save();
  }

  private writeRoleResolutionLog(range: RangeRec, config: RangeConfig): void {
    const order = resolveRoleOrder(config, range.rangeID);
    const lines = order.ok ? order.order.map((step) => ({ vm_name: step.vmName, role_name: step.role })) : [];
    let text = 'Resolving dependencies for user-defined roles..\n';
    text += playBanner('Setup for user-defined roles');
    text += taskBanner('Run the custom module to resolve role dependencies');
    text += 'ok: [localhost]\n';
    text += taskBanner('Display resolved role order');
    text += `ok: [localhost] => ${JSON.stringify({ resolved_role_order: { changed: false, failed: false, order: lines } }, null, 4)}\n`;
    text += taskBanner('Write out an ansible playbook to run the user-defined roles');
    text += 'changed: [localhost]\n';
    text += formatRecap(new Map([['localhost', { ok: 3, changed: 1, unreachable: 0, failed: 0, skipped: 0, rescued: 0, ignored: 0 }]]));
    this.logs.write(this.ansibleLogKey(range), text);
  }

  // =========================================================================
  // Deploy
  // =========================================================================

  ansibleLogKey(range: RangeRec): string {
    return `ranges/${range.rangeID}/ansible.log`;
  }

  progress(range: RangeRec): RunProgress | null {
    return this.deployJobs.get(range.rangeID)?.progress ?? null;
  }

  deploying(range: RangeRec): boolean {
    return this.deployJobs.has(range.rangeID);
  }

  deploy(range: RangeRec, user: UserRec, body: { tags?: string; force?: boolean; only_roles?: string[] | null; limit?: string }): void {
    const tags = body.tags ? body.tags.split(',') : ['all'];
    for (const tag of tags) if (!DEPLOY_TAGS.includes(tag)) throw badRequest(`The tag '${tag}' does not exist on the Ludus server`);
    const force = body.force === true;
    if (!force) {
      if (range.rangeState === 'DEPLOYING') {
        throw conflict('The range has an active deployment running. Try `range abort` to stop the deployment or run with --force if you really want to try a deploy');
      }
      if (range.rangeState === 'DESTROYING') {
        throw conflict('The range is currently being destroyed. Wait for it to finish or run with --force if you really want to try a deploy');
      }
      if (range.testingEnabled) {
        throw conflict('Testing enabled; deploy requires internet access to succeed; run with --force if you really want to try a deploy with testing enabled');
      }
    }
    if (this.deployJobs.has(range.rangeID)) {
      // A forced deploy cannot run alongside another one here; Ludus would start a second playbook.
      throw conflict('The range has an active deployment running. Try `range abort` to stop the deployment first');
    }
    const config = this.configOf(range);
    if (!config) throw serverError('Unable to read the range config: it is not valid YAML');
    if (config.defaults?.use_cert_auth === true && !this.entitlements.includes('ENTERPRISE_PLUGIN')) {
      throw forbidden('certificate authentication requires the enterprise plugin entitlement');
    }
    const onlyRoles = (body.only_roles ?? []).filter((role) => role !== '');
    const installed = new Set(this.ansibleFor(user).map((item) => item.name));
    for (const role of onlyRoles) if (!installed.has(role)) throw badRequest(`The role '${role}' does not exist on the Ludus server for user ${user.userID}`);

    range.rangeState = 'DEPLOYING';
    range.lastDeployment = now();
    this.save();

    let limit = body.limit?.trim() ? body.limit.trim() : undefined;
    if (limit && !limit.includes('localhost')) limit = `${limit},localhost`;
    const scenario = buildDeployScenario({
      config,
      rangeId: range.rangeID,
      rangeNumber: range.rangeNumber,
      tags,
      limit,
      onlyRoles,
      entitlements: this.entitlements,
      existing: range.vms.map((vm) => ({ name: vm.name, proxmoxID: vm.proxmoxID, poweredOn: vm.poweredOn, ip: vm.ip })),
      routerConfigured: range.routerConfigured,
      testingEnabled: range.testingEnabled,
      builtTemplates: this.builtTemplates(),
      nextVmId: this.state.nextVmId,
      grants: this.grants(range),
      node: this.node,
    });
    const configText = range.config;
    const entry = this.startHistory({ kind: 'range', rangeID: range.rangeID, userID: user.userID });
    const logKey = this.ansibleLogKey(range);
    this.logs.write(logKey, '');
    const controller = new AbortController();
    const job: DeployJob = { controller, done: Promise.resolve(), progress: null, logId: entry.id, tags, startedAt: entry.start };
    this.deployJobs.set(range.rangeID, job);
    job.done = (async () => {
      let status: 'success' | 'failure' | 'aborted' = 'failure';
      try {
        status = await runScenario(scenario, { clock: this.clock, signal: controller.signal }, {
          write: (text) => this.logs.append(logKey, text),
          effect: (effect) => this.applyEffect(range, effect),
          progress: (progress) => {
            job.progress = progress;
          },
        });
      } catch (err) {
        this.logs.append(logKey, `\nERROR! ${err instanceof Error ? err.message : String(err)}\n`);
      } finally {
        this.deployJobs.delete(range.rangeID);
        const current = this.state.ranges[range.rangeID];
        if (current) {
          if (status === 'success') {
            current.rangeState = 'SUCCESS';
            current.deployedConfig = configText;
          } else if (status === 'failure' && current.rangeState !== 'ABORTED') {
            current.rangeState = 'ERROR';
            current.deployedConfig = configText;
          }
        }
        this.finishHistory(entry, status === 'aborted' || current?.rangeState === 'ABORTED' ? 'aborted' : status, logKey);
        this.save();
      }
    })();
  }

  private applyEffect(range: RangeRec, effect: Effect): void {
    switch (effect.kind) {
      case 'vm.create': {
        if (!range.vms.some((vm) => vm.name === effect.name)) {
          range.vms.push({
            proxmoxID: effect.proxmoxID,
            name: effect.name,
            poweredOn: false,
            ip: 'null',
            isRouter: effect.isRouter,
            cpu: effect.cpus,
            ram: Math.floor(effect.ramGb),
            hostname: effect.hostname,
            template: effect.template,
            os: effect.os,
            vlan: effect.vlan,
            snapshots: [],
            snapshotHead: '',
          });
        }
        this.state.nextVmId = Math.max(this.state.nextVmId, effect.proxmoxID + 1);
        break;
      }
      case 'vm.power': {
        const vm = range.vms.find((v) => v.name === effect.name);
        if (vm) vm.poweredOn = effect.on;
        break;
      }
      case 'vm.ip': {
        const vm = range.vms.find((v) => v.name === effect.name);
        if (vm) vm.ip = effect.ip;
        break;
      }
      case 'router.configured':
        range.routerConfigured = true;
        break;
      case 'etchosts.written':
        range.etcHostsWritten = true;
        break;
    }
    this.save();
  }

  async abort(range: RangeRec): Promise<void> {
    const job = this.deployJobs.get(range.rangeID);
    if (!job) throw serverError(`no ansible process found for range ${range.rangeID}`);
    range.rangeState = 'ABORTED';
    this.save();
    job.controller.abort();
    await job.done;
  }

  /** Resolves when the range has no deployment running (for tests and shutdown). */
  async idle(range?: RangeRec): Promise<void> {
    if (range) await this.deployJobs.get(range.rangeID)?.done;
    else await Promise.all([...this.deployJobs.values()].map((job) => job.done));
  }

  rangeLog(range: RangeRec, params: { tail?: string; cursor?: string }): { result: string; cursor: number } {
    const parseNumber = (value: string | undefined, name: string) => {
      if (value === undefined || value === '') return undefined;
      if (!/^-?\d+$/.test(value)) throw badRequest(`Invalid number provided to ${name}: strconv.Atoi: parsing "${value}": invalid syntax`);
      return Math.max(0, Number(value));
    };
    const text = this.logs.read(this.ansibleLogKey(range));
    if (text === undefined) throw serverError(`open /opt/ludus/ranges/${range.rangeID}/ansible.log: no such file or directory`);
    return sliceLog(text, { tail: parseNumber(params.tail, 'tail'), cursor: parseNumber(params.cursor, 'cursor') });
  }

  // --- log history ---------------------------------------------------------

  private startHistory(input: Pick<LogHistoryRec, 'kind' | 'rangeID' | 'userID' | 'template'>): LogHistoryRec {
    const t = now();
    const entry: LogHistoryRec = { id: recordId(), ...input, status: 'running', start: t, end: ZERO_TIME, created: t };
    this.state.logHistory.push(entry);
    this.save();
    return entry;
  }

  private finishHistory(entry: LogHistoryRec, status: 'success' | 'failure' | 'aborted', logKey: string): void {
    if (entry.status !== 'aborted') entry.status = status;
    entry.end = now();
    const text = this.logs.read(logKey);
    if (text) this.logs.write(`history/${entry.id}.log`, text);
    const sameScope = this.state.logHistory.filter((e) => e.kind === entry.kind && (entry.kind === 'range' ? e.rangeID === entry.rangeID : e.userID === entry.userID));
    if (sameScope.length > MAX_LOG_HISTORY) {
      const drop = new Set(sameScope.slice(0, sameScope.length - MAX_LOG_HISTORY).map((e) => e.id));
      for (const id of drop) this.logs.remove(`history/${id}.log`);
      this.state.logHistory = this.state.logHistory.filter((e) => !drop.has(e.id));
    }
    this.save();
  }

  historyView(entry: LogHistoryRec) {
    return {
      id: entry.id,
      status: entry.status,
      ...(entry.template ? { template: entry.template } : {}),
      start: entry.start,
      end: entry.end,
      created: entry.created,
    };
  }

  rangeHistory(range: RangeRec): LogHistoryRec[] {
    return this.state.logHistory.filter((e) => e.kind === 'range' && e.rangeID === range.rangeID).reverse();
  }

  historyEntry(id: string): LogHistoryRec | undefined {
    return this.state.logHistory.find((e) => e.id === id);
  }

  historyText(entry: LogHistoryRec): string | undefined {
    if (entry.status === 'running') {
      if (entry.kind === 'range' && entry.rangeID) {
        const range = this.state.ranges[entry.rangeID];
        return range ? this.logs.read(this.ansibleLogKey(range)) : undefined;
      }
      const build = [...this.builds.values()].find((b) => b.logId === entry.id);
      return build ? this.logs.read(build.logKey) : undefined;
    }
    return this.logs.read(`history/${entry.id}.log`);
  }

  // =========================================================================
  // Power, destroy, delete
  // =========================================================================

  /** Finds VMs by name or VMID; `['all']` selects every VM in the range. */
  private pickVms(range: RangeRec, machines: readonly string[] | null | undefined): VmRec[] {
    const list = (machines ?? []).map((m) => m.trim()).filter((m) => m !== '');
    if (list.length === 0) throw conflict("you must specify a VM, comma separated list of VMs, or 'all'");
    if (list.length === 1 && list[0] === 'all') return [...range.vms];
    const found: VmRec[] = [];
    const missing: string[] = [];
    for (const entry of list) {
      const byId = /^\d+$/.test(entry) ? range.vms.find((vm) => vm.proxmoxID === Number(entry)) : undefined;
      const vm = byId ?? range.vms.find((v) => v.name === entry);
      if (vm) found.push(vm);
      else missing.push(entry);
    }
    if (missing.length > 0) throw conflict(`Unable to find VM(s) in your range by name: ${missing.sort().join(', ')}`);
    return found;
  }

  async power(range: RangeRec, machines: readonly string[] | null | undefined, on: boolean): Promise<string> {
    const vms = this.pickVms(range, machines);
    const changing = vms.filter((vm) => vm.poweredOn !== on);
    if (changing.length > 0) await this.clock.sleep(on ? 20 : 8, undefined, 1500);
    for (const vm of changing) vm.poweredOn = on;
    this.save();
    const list = (machines ?? []).map((m) => m.trim()).filter(Boolean);
    return list.length > 1 ? `Powered ${on ? 'on' : 'off'} ${list.length} VMs` : `Powered ${on ? 'on' : 'off'} VM: ${list[0]}`;
  }

  async destroyVms(range: RangeRec): Promise<void> {
    if (this.busy.has(range.rangeID)) throw conflict('Another operation on this range is still running');
    this.busy.add(range.rangeID);
    try {
      range.rangeState = 'DESTROYING';
      this.save();
      await this.clock.sleep(10 + range.vms.length * 8, undefined, 3000);
      range.vms = [];
      range.routerConfigured = false;
      if (range.testingEnabled) {
        range.testingEnabled = false;
        range.allowedIPs = [];
        range.allowedDomains = [];
      }
      range.rangeState = 'DESTROYED';
      this.save();
    } finally {
      this.busy.delete(range.rangeID);
    }
  }

  destroyVm(vmid: number): void {
    for (const range of Object.values(this.state.ranges)) {
      const index = range.vms.findIndex((vm) => vm.proxmoxID === vmid);
      if (index !== -1) {
        const [vm] = range.vms.splice(index, 1);
        if (vm?.isRouter) range.routerConfigured = false;
        this.save();
        return;
      }
    }
    throw serverError(`Unable to destroy VM: VMID ${vmid} not found in cluster`);
  }

  deleteRange(range: RangeRec, force: boolean): void {
    if (range.vms.length > 0 && !force) throw conflict('Range has VMs. Use --force to delete anyway');
    this.deployJobs.get(range.rangeID)?.controller.abort();
    this.removeRange(range);
  }

  private removeRange(range: RangeRec): void {
    delete this.state.ranges[range.rangeID];
    for (const user of Object.values(this.state.users)) user.rangeIDs = user.rangeIDs.filter((id) => id !== range.rangeID);
    for (const group of Object.values(this.state.groups)) group.rangeIDs = group.rangeIDs.filter((id) => id !== range.rangeID);
    this.state.logHistory = this.state.logHistory.filter((e) => e.rangeID !== range.rangeID);
    this.logs.remove(`ranges/${range.rangeID}`);
    this.save();
  }

  // =========================================================================
  // Testing mode
  // =========================================================================

  private testingVms(range: RangeRec) {
    const config = this.configOf(range);
    return range.vms
      .filter((vm) => !vm.isRouter)
      .map((vm) => {
        const entry = config?.ludus?.find((item) => resolveRangeId(String(item.vm_name), range.rangeID) === vm.name);
        const dc = entry?.windows !== undefined && (entry?.domain?.role === 'primary-dc' || entry?.domain?.role === 'alt-dc');
        return {
          name: vm.name,
          ip: vm.ip,
          snapshot: entry?.testing?.snapshot !== false,
          blockInternet: entry?.testing?.block_internet !== false,
          dc,
          windowsEndpoint: vm.os === 'windows' && !dc,
        };
      });
  }

  private routerName(range: RangeRec): string {
    return range.vms.find((vm) => vm.isRouter)?.name ?? `${range.rangeID}-router-debian13-x64`;
  }

  /** Runs a short testing-mode playbook against the range log, as Ludus does (each run replaces the log). */
  private async runTestingPlaybook(range: RangeRec, tag: TestingTag, item: { ip?: string; domain?: string } = {}): Promise<void> {
    const scenario = buildTestingScenario({ tag, router: this.routerName(range), vms: this.testingVms(range), ...item });
    const key = this.ansibleLogKey(range);
    this.logs.write(key, '');
    await runScenario(scenario, { clock: this.clock, signal: new AbortController().signal, maxTaskMs: MAX_TASK_MS / 5 }, {
      write: (text) => this.logs.append(key, text),
      effect: () => {},
      progress: () => {},
    });
  }

  private guardTesting(range: RangeRec): void {
    if (this.deployJobs.has(range.rangeID)) throw conflict('Wait for the running deployment to finish before changing testing mode');
    if (this.busy.has(range.rangeID)) throw conflict('Another operation on this range is still running');
  }

  async startTesting(range: RangeRec): Promise<void> {
    if (range.testingEnabled) throw conflict('Testing already enabled');
    this.guardTesting(range);
    this.busy.add(range.rangeID);
    try {
      await this.runTestingPlaybook(range, 'start-testing');
      const config = this.configOf(range);
      const withRam = config?.defaults?.snapshot_with_RAM !== false;
      for (const vm of range.vms) {
        if (vm.isRouter) continue;
        const entry = config?.ludus?.find((item) => resolveRangeId(String(item.vm_name), range.rangeID) === vm.name);
        if (entry?.testing?.snapshot === false) continue;
        vm.snapshots = vm.snapshots.filter((snap) => snap.name !== TESTING_SNAPSHOT);
        vm.snapshots.push({
          name: TESTING_SNAPSHOT,
          description: `Automated snapshot created by ludus at ${now()}`,
          snaptime: Math.floor(Date.now() / 1000),
          includesRAM: withRam && vm.poweredOn,
          parent: vm.snapshotHead,
          state: { poweredOn: vm.poweredOn },
        });
        vm.snapshotHead = TESTING_SNAPSHOT;
      }
      range.testingEnabled = true;
      this.save();
    } finally {
      this.busy.delete(range.rangeID);
    }
  }

  async stopTesting(range: RangeRec): Promise<void> {
    if (!range.testingEnabled) throw conflict('Testing not enabled');
    this.guardTesting(range);
    this.busy.add(range.rangeID);
    try {
      await this.runTestingPlaybook(range, 'stop-testing');
      for (const vm of range.vms) {
        const snap = vm.snapshots.find((s) => s.name === TESTING_SNAPSHOT);
        if (!snap) continue;
        vm.snapshotHead = TESTING_SNAPSHOT;
        // Machines are reverted, then started again.
        vm.poweredOn = true;
      }
      range.testingEnabled = false;
      range.allowedIPs = [];
      range.allowedDomains = [];
      this.save();
    } finally {
      this.busy.delete(range.rangeID);
    }
  }

  async allow(range: RangeRec, domains: readonly string[] | null | undefined, ips: readonly string[] | null | undefined) {
    if (!range.testingEnabled) throw conflict(`testing not enabled for range ${range.rangeID}`);
    const allowed: string[] = [];
    const errors: Array<{ item: string; reason: string }> = [];
    for (const domain of (domains ?? []).filter(Boolean)) {
      if (range.allowedDomains.some((entry) => entry.includes(`${domain} (`))) {
        errors.push({ item: domain, reason: 'already allowed' });
        continue;
      }
      const ip = await this.resolveDomain(domain);
      if (!ip) {
        errors.push({ item: domain, reason: `could not resolve IP for the domain ${domain}` });
        continue;
      }
      await this.runTestingPlaybook(range, 'allow-domain', { domain, ip });
      range.allowedDomains.push(`${domain} (${ip})`);
      allowed.push(domain);
    }
    for (const ip of (ips ?? []).filter(Boolean)) {
      if (range.allowedIPs.includes(ip)) {
        errors.push({ item: ip, reason: 'already allowed' });
        continue;
      }
      await this.runTestingPlaybook(range, 'allow-ip', { ip });
      range.allowedIPs.push(ip);
      allowed.push(ip);
    }
    this.save();
    return { ...(allowed.length > 0 ? { allowed } : {}), ...(errors.length > 0 ? { errors } : {}) };
  }

  async deny(range: RangeRec, domains: readonly string[] | null | undefined, ips: readonly string[] | null | undefined) {
    if (!range.testingEnabled) throw conflict(`Testing not enabled for range ${range.rangeID}`);
    const denied: string[] = [];
    const errors: Array<{ item: string; reason: string }> = [];
    for (const domain of (domains ?? []).filter(Boolean)) {
      if (!range.allowedDomains.some((entry) => entry.includes(`${domain} (`))) {
        errors.push({ item: domain, reason: 'not allowed' });
        continue;
      }
      await this.runTestingPlaybook(range, 'deny-domain', { domain });
      range.allowedDomains = range.allowedDomains.filter((entry) => !entry.includes(`${domain} (`));
      denied.push(domain);
    }
    for (const ip of (ips ?? []).filter(Boolean)) {
      if (!range.allowedIPs.includes(ip)) {
        denied.push(`${ip} NOT denied as it is not allowed`);
        continue;
      }
      await this.runTestingPlaybook(range, 'deny-ip', { ip });
      range.allowedIPs = range.allowedIPs.filter((entry) => entry !== ip);
      denied.push(ip);
    }
    this.save();
    return { ...(denied.length > 0 ? { denied } : {}), ...(errors.length > 0 ? { errors } : {}) };
  }

  /** Allowed destinations in the order the router evaluates them. */
  testingAllows(range: RangeRec): TestingAllow[] {
    const out: TestingAllow[] = [];
    for (const entry of range.allowedDomains) {
      const match = /^(.*) \((.*)\)$/.exec(entry);
      if (match) out.push({ domain: match[1] as string, ip: match[2] as string });
    }
    for (const ip of range.allowedIPs) out.push({ ip });
    return out;
  }

  // =========================================================================
  // Snapshots
  // =========================================================================

  private snapshotTargets(range: RangeRec, vmids: readonly number[] | null | undefined): Array<{ vmid: number; vm?: VmRec }> {
    if (!vmids || vmids.length === 0) return range.vms.map((vm) => ({ vmid: vm.proxmoxID, vm }));
    return vmids.map((vmid) => ({ vmid, vm: Object.values(this.state.ranges).flatMap((r) => r.vms).find((v) => v.proxmoxID === vmid) }));
  }

  static snapshotNameError(name: string): string | undefined {
    if (name.length < 3) return 'SnapshotName must be at least 3 characters long';
    if (name.length > 40) return 'SnapshotName must be at most 40 characters long';
    if (!/^[a-zA-Z]/.test(name)) return 'SnapshotName must start with a letter';
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,39}$/.test(name)) {
      return 'SnapshotName must only contain the following characters: abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    }
    return undefined;
  }

  listSnapshots(range: RangeRec, vmidsParam: string | undefined) {
    const snapshots: Array<Record<string, unknown>> = [];
    const errors: Array<Record<string, unknown>> = [];
    let targets: Array<{ vmid: number; vm?: VmRec; explicit: boolean }>;
    if (vmidsParam && vmidsParam.trim()) {
      targets = [];
      for (const raw of vmidsParam.split(',')) {
        const text = raw.trim();
        if (!/^\d+$/.test(text)) {
          errors.push({ error: `Invalid VM ID: ${text}` });
          continue;
        }
        const vmid = Number(text);
        targets.push({ vmid, vm: Object.values(this.state.ranges).flatMap((r) => r.vms).find((v) => v.proxmoxID === vmid), explicit: true });
      }
    } else {
      targets = range.vms.map((vm) => ({ vmid: vm.proxmoxID, vm, explicit: false }));
    }
    for (const target of targets) {
      if (!target.vm) {
        errors.push({ vmid: target.vmid, error: `Error getting VM info for VM ${target.vmid}: vm '${target.vmid}' not found` });
        continue;
      }
      const vm = target.vm;
      for (const snap of vm.snapshots) {
        snapshots.push({
          name: snap.name,
          ...(snap.includesRAM ? { includesRAM: true } : {}),
          ...(snap.description ? { description: snap.description } : {}),
          snaptime: snap.snaptime,
          ...(snap.parent ? { parent: snap.parent } : {}),
          vmid: vm.proxmoxID,
          vmname: vm.name,
        });
      }
      snapshots.push({ name: 'current', description: 'You are here!', ...(vm.snapshotHead ? { parent: vm.snapshotHead } : {}), vmid: vm.proxmoxID, vmname: vm.name });
    }
    return { ...(snapshots.length > 0 ? { snapshots } : {}), ...(errors.length > 0 ? { errors } : {}) };
  }

  async snapshotAction(
    range: RangeRec,
    action: 'create' | 'rollback' | 'remove',
    body: { name?: string; description?: string; vmids?: number[] | null; includeRAM?: boolean },
  ) {
    const name = body.name ?? '';
    const success: number[] = [];
    const errors: Array<{ vmid: number; vmname: string; error: string }> = [];
    const targets = this.snapshotTargets(range, body.vmids);
    if (targets.length > 0) await this.clock.sleep(action === 'create' ? 10 : 6, undefined, 1200);
    for (const { vmid, vm } of targets) {
      const vmname = body.vmids && body.vmids.length > 0 ? '' : (vm?.name ?? '');
      if (!vm) {
        errors.push({ vmid, vmname, error: `VMID ${vmid} not found in the cluster` });
        continue;
      }
      const nameError = World.snapshotNameError(name);
      if (nameError) {
        errors.push({ vmid, vmname, error: nameError });
        continue;
      }
      const existing = vm.snapshots.find((s) => s.name === name);
      if (action === 'create') {
        if (existing) {
          errors.push({ vmid, vmname, error: `error creating Snapshot: 500 snapshot name '${name}' already used, (params: {"snapname":"${name}"})` });
          continue;
        }
        const snap: SnapshotRec = {
          name,
          description: body.description ?? '',
          snaptime: Math.floor(Date.now() / 1000),
          includesRAM: body.includeRAM === true && vm.poweredOn,
          parent: vm.snapshotHead,
          state: { poweredOn: vm.poweredOn },
        };
        vm.snapshots.push(snap);
        vm.snapshotHead = name;
      } else if (!existing) {
        errors.push({ vmid, vmname, error: `500 snapshot '${name}' does not exist` });
        continue;
      } else if (action === 'rollback') {
        vm.snapshotHead = name;
        // A snapshot with RAM resumes running; without it the machine comes back powered off.
        vm.poweredOn = existing.includesRAM ? true : false;
      } else {
        for (const snap of vm.snapshots) if (snap.parent === name) snap.parent = existing.parent;
        if (vm.snapshotHead === name) vm.snapshotHead = existing.parent;
        vm.snapshots = vm.snapshots.filter((s) => s.name !== name);
      }
      success.push(vmid);
    }
    this.save();
    return { ...(success.length > 0 ? { success } : {}), ...(errors.length > 0 ? { errors } : {}) };
  }

  // =========================================================================
  // Templates
  // =========================================================================

  templatesView() {
    const order = (t: TemplateRec) => {
      const index = TEMPLATE_CATALOG.findIndex((c) => c.name === t.name);
      return t.builtin ? index : 1000 + (index === -1 ? 999 : index);
    };
    return Object.values(this.state.templates)
      .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, built: t.built, status: t.status, os: t.os }));
  }

  buildTemplates(user: UserRec, names: readonly string[] | null | undefined, parallel: number | undefined): string {
    const list = names ?? [];
    if (list.length === 0) throw badRequest('templates array cannot be empty');
    for (const name of list) if (name !== 'all' && !this.state.templates[name]) throw notFound(`Template '${name}' not found`);
    const width = parallel && parallel > 0 ? parallel : 1;
    this.parallel = width;
    const wanted = list.includes('all') ? this.templatesView().map((t) => t.name) : [...list];
    for (const name of wanted) {
      const template = this.state.templates[name];
      if (!template || template.built || template.status === 'building' || this.queue.some((q) => q.template === name)) continue;
      this.queue.push({ template: name, user: user.userID });
    }
    this.pumpBuilds();
    return `Template building started - this will take a while. Building ${width} template(s) at a time.`;
  }

  private pumpBuilds(): void {
    while (this.builds.size < this.parallel && this.queue.length > 0) {
      const next = this.queue.shift() as QueuedBuild;
      void this.runBuild(next);
    }
  }

  private async runBuild(item: QueuedBuild): Promise<void> {
    const template = this.state.templates[item.template];
    const user = this.state.users[item.user];
    if (!template || !user || template.built) return this.pumpBuilds();
    const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.(\d+)Z$/, '.$1000000Z');
    const logKey = `users/${user.proxmoxUsername}/packer/log-history/${template.name}-${stamp}.log`;
    const entry = this.startHistory({ kind: 'template', userID: user.userID, template: template.name });
    const controller = new AbortController();
    const job: BuildJob = { template: template.name, user: user.userID, controller, logId: entry.id, logKey };
    this.builds.set(template.name, job);
    template.status = 'building';
    this.save();
    const vmid = this.state.nextVmId++;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stampLine = () => {
      const d = new Date();
      return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };
    this.logs.write(logKey, '');
    let status: 'success' | 'failure' | 'aborted' = 'success';
    try {
      // Builds are launched a few seconds apart.
      await this.clock.sleep(3, controller.signal);
      for (const step of buildPackerScenario({ name: template.name, os: template.os === 'other' ? 'linux' : template.os, vmid })) {
        await this.clock.sleep(step.seconds, controller.signal);
        this.logs.append(logKey, step.lines.map((line) => `${stampLine()} ${line}\n`).join(''));
      }
      this.logs.append(logKey, BUILD_COMPLETE);
      template.built = true;
      template.status = 'built';
      template.vmid = vmid;
    } catch (err) {
      status = err instanceof AbortedError ? 'aborted' : 'failure';
      template.status = 'not_built';
      if (status === 'failure') this.logs.append(logKey, `${stampLine()} [ERROR] ${err instanceof Error ? err.message : String(err)}\n`);
    } finally {
      this.builds.delete(template.name);
      const text = this.logs.read(logKey) ?? '';
      this.logs.write(`users/${user.proxmoxUsername}/packer.log`, text);
      this.finishHistory(entry, status, logKey);
      this.save();
      this.pumpBuilds();
    }
  }

  buildStatus() {
    const running = [...this.builds.values()].map((b) => ({ user: this.state.users[b.user]?.proxmoxUsername ?? b.user, template: b.template }));
    return running.length > 0 ? running : null;
  }

  abortBuilds(user: UserRec): string {
    const mine = [...this.builds.values()].filter((b) => b.user === user.userID);
    const queued = this.queue.filter((q) => q.user === user.userID);
    if (mine.length === 0 && queued.length === 0) throw serverError(`No packer processes found for user ${user.proxmoxUsername}`);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]?.user === user.userID) this.queue.splice(i, 1);
    for (const build of mine) {
      const entry = this.historyEntry(build.logId);
      if (entry) entry.status = 'aborted';
      build.controller.abort();
    }
    this.save();
    return `Packer process(es) aborted for user ${user.proxmoxUsername}`;
  }

  templateLog(user: UserRec, params: { tail?: string; cursor?: string; logID?: string }): { result: string; cursor: number } {
    let key: string;
    if (params.logID) {
      const build = [...this.builds.values()].find((b) => b.logId === params.logID);
      if (!build) throw badRequest('The provided log history ID is not currently running. Follow mode is only supported for active template builds.');
      key = build.logKey;
    } else {
      const running = [...this.builds.values()].filter((b) => b.user === user.userID).at(-1);
      key = running ? running.logKey : `users/${user.proxmoxUsername}/packer.log`;
    }
    const text = this.logs.read(key);
    if (text === undefined) throw serverError(`open /opt/ludus/users/${user.proxmoxUsername}/packer.log: no such file or directory`);
    const num = (value: string | undefined, name: string) => {
      if (value === undefined || value === '') return undefined;
      if (!/^-?\d+$/.test(value)) throw badRequest(`Invalid number provided to ${name}: strconv.Atoi: parsing "${value}": invalid syntax`);
      return Math.max(0, Number(value));
    };
    return sliceLog(text, { tail: num(params.tail, 'tail'), cursor: num(params.cursor, 'cursor') });
  }

  templateHistory(user: UserRec): LogHistoryRec[] {
    return this.state.logHistory.filter((e) => e.kind === 'template' && e.userID === user.userID).reverse();
  }

  deleteTemplate(user: UserRec, name: string): string {
    const template = this.state.templates[name];
    if (!template) throw notFound(`Template '${name}' not found`);
    if (!template.builtin && template.owner && template.owner !== user.userID && !user.isAdmin) {
      throw badRequest(`'${name}' is a user template that belongs to another user and you are not an Admin (path: /opt/ludus/users/${template.owner}/packer/${name})`);
    }
    this.builds.get(name)?.controller.abort();
    if (template.builtin) {
      template.built = false;
      template.status = 'not_built';
      template.vmid = undefined;
      this.save();
      return `Built template removed but template '${name}' is a ludus server included template and cannot be deleted`;
    }
    delete this.state.templates[name];
    this.save();
    return `Template '${name}' removed`;
  }

  addTemplate(user: UserRec, name: string, os: VmOs, force: boolean): string {
    const existing = this.state.templates[name];
    if (existing?.builtin) throw serverError('The uploaded template name is already present on the server. Template names must be unique.');
    if (existing && existing.owner !== user.userID && !user.isAdmin) throw badRequest(`'${name}' is a template that does not belong to you`);
    if (existing && !force) throw badRequest('Template already exists, use --force to overwrite it');
    this.state.templates[name] = { name, os, builtin: false, built: false, status: 'not_built', owner: user.userID };
    this.save();
    return 'Successfully added template';
  }

  // =========================================================================
  // Ansible roles and collections (simulated installs)
  // =========================================================================

  ansibleView(user: UserRec) {
    const mine = this.state.ansible.filter((item) => !item.global && item.userID === user.userID);
    const global = this.state.ansible.filter((item) => item.global);
    const out = [...mine, ...global].map((item) => ({ ...(item.global ? { global: true } : {}), name: item.name, version: item.version, type: item.type }));
    return out.length > 0 ? out : null;
  }

  ansibleAction(user: UserRec, type: 'role' | 'collection', body: { name: string; version?: string; action?: string; global?: boolean; force?: boolean }): string {
    const action = body.action || (type === 'collection' ? 'install' : '');
    if (action !== 'install' && action !== 'remove') {
      throw type === 'role' ? serverError("action must be one of 'install' or 'remove'") : badRequest("action must be one of 'install' or 'remove'");
    }
    if (body.global && !user.isAdmin) throw forbidden('Only administrators can perform global ansible actions');
    const name = body.name.trim();
    if (!name) throw badRequest(`A ${type} name is required`);
    const matches = (item: State['ansible'][number]) =>
      item.type === type && item.name === name && (body.global ? item.global : !item.global && item.userID === user.userID);
    if (action === 'remove') {
      if (!this.state.ansible.some(matches)) throw conflict(`- ${name} is not installed, skipping.`);
      this.state.ansible = this.state.ansible.filter((item) => !matches(item));
      this.save();
      return `Successfully removed: ${name}`;
    }
    if (type === 'collection' && this.state.ansible.some(matches) && !body.force) {
      throw conflict(
        'Collection already installed. Collections from https://docs.ansible.com/ansible/latest/collections/index.html are installed globally. If you want to reinstall it, consider using `--force`.',
      );
    }
    this.state.ansible = this.state.ansible.filter((item) => !matches(item));
    this.state.ansible.push({ name, version: body.version || '(unknown version)', type, global: body.global === true, userID: body.global ? undefined : user.userID });
    this.save();
    return type === 'collection' && body.version ? `Successfully installed: ${name}:==${body.version}` : `Successfully installed: ${name}${body.version ? `,${body.version}` : ''}`;
  }

  // =========================================================================
  // Groups
  // =========================================================================

  group(name: string): GroupRec {
    const group = this.state.groups[name];
    if (!group) throw notFound(`Group ${name} not found`);
    return group;
  }

  createGroup(name: string | undefined, description: string | undefined): void {
    if (!name) throw badRequest('Group name is required');
    if (this.state.groups[name]) throw conflict('Group with this name already exists');
    if (!GROUP_NAME_RE.test(name)) throw serverError('Error creating group in proxmox: group name must be alphanumeric, hyphens, and underscores only');
    this.state.groups[name] = { name, description: description ?? '', members: [], managers: [], rangeIDs: [] };
    this.save();
  }

  // =========================================================================
  // Blueprints
  // =========================================================================

  blueprintAccess(user: UserRec, blueprint: BlueprintRec): 'admin' | 'owner' | 'direct' | 'group' | undefined {
    if (user.isAdmin) return 'admin';
    if (blueprint.ownerUserID === user.userID) return 'owner';
    if (blueprint.sharedUsers.includes(user.userID)) return 'direct';
    if (this.groupsOf(user).some((g) => blueprint.sharedGroups.includes(g.name))) return 'group';
    return undefined;
  }

  /** Looks a blueprint up by ID; `wording` picks between the two message styles Ludus uses. */
  blueprintFor(user: UserRec, id: string, wording: 'upper' | 'lower' = 'upper'): BlueprintRec {
    const blueprint = this.state.blueprints[id] ?? Object.values(this.state.blueprints).find((b) => b.id === id);
    if (!blueprint) throw notFound(wording === 'upper' ? `Blueprint ${id} not found` : `blueprint "${id}" not found`);
    if (!this.blueprintAccess(user, blueprint)) throw forbidden(wording === 'upper' ? 'You do not have access to this blueprint' : 'you do not have access to this blueprint');
    return blueprint;
  }

  createBlueprint(user: UserRec, input: { blueprintID?: string; name?: string; description?: string; version?: string; tags?: string[]; min_ludus_version?: string; config?: string }): BlueprintRec {
    const id = input.blueprintID ?? '';
    if (!id) throw badRequest('Blueprint ID is required');
    if (!RANGE_ID_RE.test(id)) throw badRequest("Blueprint ID must be a valid ID (e.g. 'blueprint-1', 'team/windows' or 'my_blueprint')");
    if (this.state.blueprints[id]) throw conflict(`Blueprint ID ${id} already in use`);
    const config = input.config || DEFAULT_RANGE_CONFIG;
    const check = validateConfigText(config, { lint: false });
    if (check.issues.some((issue) => issue.severity === 'error' && (issue.source === 'yaml' || issue.source === 'schema'))) {
      throw badRequest(`invalid blueprint config: ${check.ludusError}`);
    }
    const t = now();
    const blueprint: BlueprintRec = {
      id: recordId(),
      blueprintID: id,
      name: input.name || id,
      description: input.description ?? '',
      version: input.version || '1.0.0',
      tags: input.tags ?? [],
      minLudusVersion: input.min_ludus_version ?? '',
      ownerUserID: user.userID,
      sharedUsers: [],
      sharedGroups: [],
      config,
      created: t,
      updated: t,
    };
    this.state.blueprints[id] = blueprint;
    this.save();
    return blueprint;
  }

  blueprintView(user: UserRec, blueprint: BlueprintRec) {
    return {
      blueprintID: blueprint.blueprintID,
      name: blueprint.name,
      ...(blueprint.description ? { description: blueprint.description } : {}),
      ownerUserID: blueprint.ownerUserID,
      ...(blueprint.sharedUsers.length > 0 ? { sharedUsers: blueprint.sharedUsers } : {}),
      ...(blueprint.sharedGroups.length > 0 ? { sharedGroups: blueprint.sharedGroups } : {}),
      accessType: this.blueprintAccess(user, blueprint) ?? 'unknown',
      ...(blueprint.tags.length > 0 ? { tags: blueprint.tags } : {}),
      created: blueprint.created,
      updated: blueprint.updated,
    };
  }

  /** Requirements of a config: the templates and roles it needs, and whether they are available. */
  requirements(user: UserRec, config: RangeConfig | undefined) {
    const built = this.builtTemplates();
    const installed = new Set(this.ansibleFor(user).map((item) => item.name));
    const templates = [...new Set((config?.ludus ?? []).map((vm) => vm.template))];
    const roles = [...new Set((config?.ludus ?? []).flatMap((vm) => (vm.roles ?? []).map((r) => (typeof r === 'string' ? r : r.name))))];
    return {
      templateStatus: templates.map((name) => ({ name, built: built.has(name) })),
      roleStatus: roles.map((name) => ({ name, installed: installed.has(name), subscription: false })),
    };
  }

  osOf(template: string): VmOs {
    const known = this.state.templates[template];
    if (known) return known.os;
    const info = templateInfo(template);
    return info.os;
  }

  /** The OS family a config entry declares, for UI summaries. */
  static osFamily = osFamilyOf;
}

export type { RangeState };
