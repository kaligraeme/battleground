/**
 * Persisted entities of the simulated world.
 *
 * Field names that appear on the wire follow the Ludus API so responses can be
 * produced without renaming; everything else is Battleground-specific.
 */

export type RangeState =
  | 'NEVER DEPLOYED'
  | 'DEPLOYING'
  | 'SUCCESS'
  | 'ERROR'
  | 'ABORTED'
  | 'DESTROYING'
  | 'DESTROYED';

/** Go's zero time, which Ludus emits for "never". */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

export interface UserRec {
  id: string;
  userID: string;
  /** 2..150; also the last octet of the user's VPN address. */
  userNumber: number;
  name: string;
  email: string;
  isAdmin: boolean;
  proxmoxUsername: string;
  passwordHash: string;
  /** The password, encrypted, because `GET /user/credentials` hands it back like Ludus does. */
  passwordEnc: string;
  apiKeyHash: string;
  defaultRangeID: string;
  /** Ranges this user has been given direct access to. */
  rangeIDs: string[];
  dateCreated: string;
  dateLastActive: string;
  wireguard: { privateKey: string; publicKey: string };
}

export interface SnapshotRec {
  name: string;
  description: string;
  /** Unix seconds. */
  snaptime: number;
  includesRAM: boolean;
  parent: string;
  /** The simulated VM state captured by the snapshot. */
  state: { poweredOn: boolean };
}

export type VmOs = 'windows' | 'linux' | 'macos' | 'other';

export interface VmRec {
  proxmoxID: number;
  name: string;
  poweredOn: boolean;
  /** `"null"` (the string) when no address is known, as Ludus reports it. */
  ip: string;
  isRouter: boolean;
  cpu: number;
  ram: number;
  hostname: string;
  template: string;
  os: VmOs;
  vlan?: number;
  snapshots: SnapshotRec[];
  /** Name of the snapshot the live state descends from (parent of Proxmox's `current`). */
  snapshotHead: string;
}

export interface RangeRec {
  id: string;
  rangeID: string;
  rangeNumber: number;
  name: string;
  description: string;
  purpose: string;
  /** The range config, as YAML text exactly as it was uploaded. */
  config: string;
  rangeState: RangeState;
  lastDeployment: string;
  testingEnabled: boolean;
  allowedIPs: string[];
  /** Entries are `"<domain> (<pinned ip>)"`. */
  allowedDomains: string[];
  vms: VmRec[];
  /** The config that the current VMs were last deployed from. */
  deployedConfig?: string;
  /** The router finished its one-time configuration (later deploys skip it). */
  routerConfigured: boolean;
  /** A deploy has written the range's hosts file. */
  etcHostsWritten: boolean;
  created: string;
  updated: string;
  lastActive: string;
}

export type TemplateStatus = 'built' | 'not_built' | 'building';

export interface TemplateRec {
  name: string;
  os: VmOs;
  built: boolean;
  status: TemplateStatus;
  /** Shipped with the server (cannot be deleted, only un-built). */
  builtin: boolean;
  /** userID that added a non-builtin template. */
  owner?: string;
  /** Hypervisor ID of the built template. */
  vmid?: number;
}

export interface AnsibleItemRec {
  name: string;
  version: string;
  type: 'role' | 'collection';
  /** Installed for everyone (`true`) or for one user. */
  global: boolean;
  userID?: string;
}

export interface GroupRec {
  name: string;
  description: string;
  members: string[];
  managers: string[];
  rangeIDs: string[];
}

export interface BlueprintRec {
  id: string;
  blueprintID: string;
  name: string;
  description: string;
  version: string;
  tags: string[];
  minLudusVersion: string;
  ownerUserID: string;
  sharedUsers: string[];
  sharedGroups: string[];
  config: string;
  created: string;
  updated: string;
}

export type LogStatus = 'running' | 'success' | 'failure' | 'aborted';

export interface LogHistoryRec {
  id: string;
  kind: 'range' | 'template';
  /** rangeID for range logs. */
  rangeID?: string;
  /** userID that started a template build. */
  userID?: string;
  template?: string;
  status: LogStatus;
  start: string;
  end: string;
  created: string;
}

export interface SessionRec {
  userID: string;
  created: number;
  expires: number;
}

export interface State {
  schema: 1;
  /** Next simulated Proxmox VMID. */
  nextVmId: number;
  users: Record<string, UserRec>;
  ranges: Record<string, RangeRec>;
  groups: Record<string, GroupRec>;
  blueprints: Record<string, BlueprintRec>;
  templates: Record<string, TemplateRec>;
  ansible: AnsibleItemRec[];
  logHistory: LogHistoryRec[];
  /** Keyed by the SHA-256 of the session token. */
  sessions: Record<string, SessionRec>;
  settings: {
    /** Simulated seconds that pass per real second. `0` means "instant". */
    speed: number;
    /** Key for the few secrets stored reversibly. */
    secretKey: string;
    /** The range host's (simulated) VPN public key. */
    wireguardPublicKey: string;
  };
}

export function emptyState(speed: number, secretKey: string, wireguardPublicKey: string): State {
  return {
    schema: 1,
    nextVmId: 100,
    users: {},
    ranges: {},
    groups: {},
    blueprints: {},
    templates: {},
    ansible: [],
    logHistory: [],
    sessions: {},
    settings: { speed, secretKey, wireguardPublicKey },
  };
}
