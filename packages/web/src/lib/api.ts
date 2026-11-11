/**
 * Client for the Battleground server: the Ludus API (`/api/v2`) plus the
 * UI endpoints (`/api/bg`). The session token comes from signing in.
 */

import type { BuiltinBlueprint, TemplateInfo, TestingAllow } from '@battleground/core';

const TOKEN_KEY = 'battleground.token';

let token: string | null = (() => {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
})();

const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export function setToken(value: string | null): void {
  token = value;
  try {
    if (value) localStorage.setItem(TOKEN_KEY, value);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Without storage the session lasts until the tab closes.
  }
}

export function hasToken(): boolean {
  return token !== null;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

function url(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}

async function request(method: string, path: string, options: { query?: Query; json?: unknown; form?: FormData } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let reqBody: string | FormData | undefined;
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    reqBody = JSON.stringify(options.json);
  } else if (options.form) reqBody = options.form;
  let res: Response;
  try {
    res = await fetch(url(path, options.query), { method, headers, body: reqBody });
  } catch {
    throw new HttpError(0, 'Cannot reach the Battleground server. Is it running?');
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      message = data.error ?? data.message ?? message;
    } catch {
      // Keep the status line.
    }
    if (res.status === 401 && token && !path.endsWith('/login')) {
      setToken(null);
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw new HttpError(res.status, message);
  }
  return res;
}

async function json<T>(method: string, path: string, options?: { query?: Query; json?: unknown; form?: FormData }): Promise<T> {
  const res = await request(method, path, options);
  return (await res.json()) as T;
}

const v2 = (path: string) => `/api/v2${path}`;
const bg = (path: string) => `/api/bg${path}`;

// ---------------------------------------------------------------------------
// Types of the responses the UI uses
// ---------------------------------------------------------------------------

export type RangeState = 'NEVER DEPLOYED' | 'DEPLOYING' | 'SUCCESS' | 'ERROR' | 'ABORTED' | 'DESTROYING' | 'DESTROYED';

export interface SessionUser {
  userID: string;
  name: string;
  email: string;
  isAdmin: boolean;
  userNumber: number;
  proxmoxUsername: string;
}

export interface RangeSummary {
  rangeID: string;
  name: string;
  rangeNumber: number;
  rangeState: RangeState;
  testingEnabled: boolean;
  numberOfVMs: number;
  access: 'Direct' | 'Group' | 'Admin';
  deploying: boolean;
}

export interface Session {
  user: SessionUser;
  defaultRangeID: string;
  ranges: RangeSummary[];
}

export interface TemplateEntry extends TemplateInfo {
  built: boolean;
  status: 'built' | 'not_built' | 'building';
  /** False for documented templates this server does not have. */
  available: boolean;
}

export interface BlueprintEntry {
  blueprintID: string;
  name: string;
  description?: string;
  ownerUserID: string;
  tags?: string[];
  config: string;
  updated: string;
}

export interface Meta {
  version: string;
  speed: number;
  node: string;
  host: { localIp: string; publicIp: string };
  entitlements: string[];
  deployTags: string[];
  templates: TemplateEntry[];
  builtinBlueprints: BuiltinBlueprint[];
  blueprints: BlueprintEntry[];
  ansible: Array<{ name: string; version: string; type: 'role' | 'collection'; global: boolean }>;
  buildStatus: Array<{ user: string; template: string }>;
}

export interface LudusVm {
  proxmoxID: number;
  rangeNumber: number;
  name: string;
  poweredOn: boolean;
  ip: string;
  isRouter?: boolean;
  cpu: number;
  ram: number;
}

export interface LudusRange {
  rangeState: RangeState;
  rangeNumber: number;
  description?: string;
  purpose?: string;
  lastDeployment: string;
  testingEnabled: boolean;
  VMs: LudusVm[];
  rangeID: string;
  name: string;
  numberOfVMs: number;
  allowedIPs?: string[];
  allowedDomains?: string[];
}

export interface SnapshotInfo {
  name: string;
  description: string;
  snaptime: number;
  includesRAM: boolean;
  parent: string;
}

export interface DetailVm extends LudusVm {
  hostname: string;
  template: string;
  os: 'windows' | 'linux' | 'macos' | 'other';
  vlan: number | null;
  snapshots: SnapshotInfo[];
  snapshotHead: string;
  login: string;
  services: string[];
}

export interface Progress {
  stage: string;
  play: string;
  task?: string;
  focus: string[];
  done: number;
  total: number;
}

export interface Grant {
  userID: string;
  userNumber: number;
  name: string;
  accessType: string;
}

export interface HistoryEntry {
  id: string;
  status: 'running' | 'success' | 'failure' | 'aborted';
  template?: string;
  start: string;
  end: string;
  created: string;
}

export interface RangeDetail {
  range: LudusRange;
  config: string;
  deployedConfig: string | null;
  deploying: boolean;
  progress: Progress | null;
  access: string;
  grants: Grant[];
  testing: { enabled: boolean; allowed: TestingAllow[] };
  routerConfigured: boolean;
  etcHostsWritten: boolean;
  lastRun: HistoryEntry | null;
  vms: DetailVm[];
}

export interface UserView {
  name: string;
  userID: string;
  userNumber: number;
  dateCreated: string;
  dateLastActive: string;
  isAdmin: boolean;
  proxmoxUsername: string;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const r = (rangeID: string) => ({ rangeID });

export const api = {
  login: (login: string, password: string) => json<Session & { token: string }>('POST', bg('/login'), { json: { login, password } }),
  logout: () => json<unknown>('POST', bg('/logout')),
  session: () => json<Session>('GET', bg('/session')),
  meta: () => json<Meta>('GET', bg('/meta')),
  detail: (rangeID: string) => json<RangeDetail>('GET', bg('/range'), { query: r(rangeID) }),
  setSpeed: (speed: number) => json<{ speed: number }>('PUT', bg('/settings'), { json: { speed } }),
  addTemplate: (name: string, os: string) => json<{ result: string }>('POST', bg('/templates'), { json: { name, os } }),

  setConfig: (rangeID: string, text: string, force = false) => {
    const form = new FormData();
    form.append('file', new File([text], 'file', { type: 'application/x-yaml' }));
    form.append('force', String(force));
    return json<{ result: string }>('PUT', v2('/range/config'), { query: r(rangeID), form });
  },
  deploy: (rangeID: string, options: { tags?: string; limit?: string; force?: boolean; onlyRoles?: string[] } = {}) =>
    json<{ result: string }>('POST', v2('/range/deploy'), {
      query: r(rangeID),
      json: { tags: options.tags ?? '', force: options.force ?? false, limit: options.limit ?? '', only_roles: options.onlyRoles ?? [] },
    }),
  abort: (rangeID: string) => json<{ result: string }>('POST', v2('/range/abort'), { query: r(rangeID) }),
  logs: (rangeID: string, cursor?: number) => json<{ result: string; cursor: number }>('GET', v2('/range/logs'), { query: { ...r(rangeID), cursor } }),
  history: (rangeID: string) => json<HistoryEntry[]>('GET', v2('/range/logs/history'), { query: r(rangeID) }),
  historyLog: (rangeID: string, id: string) => json<HistoryEntry & { result: string }>('GET', v2(`/range/logs/history/${encodeURIComponent(id)}`), { query: r(rangeID) }),
  power: (rangeID: string, machines: string[], on: boolean) =>
    json<{ result: string }>('PUT', v2(on ? '/range/poweron' : '/range/poweroff'), { query: r(rangeID), json: { machines } }),
  destroyVms: (rangeID: string) => json<{ result: string }>('DELETE', v2(`/range/${encodeURIComponent(rangeID)}/vms`), { query: r(rangeID) }),
  deleteRange: (rangeID: string, force: boolean) => json<{ result: string }>('DELETE', v2('/range'), { query: { ...r(rangeID), force } }),
  createRange: (input: { rangeID: string; name: string; description?: string; purpose?: string; userIDs: string[] }) =>
    json<{ result: string }>('POST', v2('/ranges/create'), {
      json: { rangeID: input.rangeID, name: input.name, description: input.description ?? '', purpose: input.purpose ?? '', userID: input.userIDs },
    }),

  testingStart: (rangeID: string) => json<{ result: string }>('PUT', v2('/testing/start'), { query: r(rangeID) }),
  testingStop: (rangeID: string) => json<{ result: string }>('PUT', v2('/testing/stop'), { query: r(rangeID), json: { force: false } }),
  allow: (rangeID: string, domains: string[], ips: string[]) =>
    json<{ allowed?: string[]; errors?: Array<{ item: string; reason: string }> }>('POST', v2('/testing/allow'), { query: r(rangeID), json: { domains, ips } }),
  deny: (rangeID: string, domains: string[], ips: string[]) =>
    json<{ denied?: string[]; errors?: Array<{ item: string; reason: string }> }>('POST', v2('/testing/deny'), { query: r(rangeID), json: { domains, ips } }),

  snapshot: (rangeID: string, action: 'create' | 'rollback' | 'remove', body: { name: string; description?: string; vmids?: number[]; includeRAM?: boolean }) =>
    json<{ success?: number[]; errors?: Array<{ vmid: number; error: string }> }>('POST', v2(`/snapshots/${action}`), { query: r(rangeID), json: body }),

  buildTemplates: (templates: string[], parallel = 1) => json<{ result: string }>('POST', v2('/templates'), { json: { templates, parallel } }),
  abortBuilds: () => json<{ result: string }>('POST', v2('/templates/abort')),
  deleteTemplate: (name: string) => json<{ result: string }>('DELETE', v2(`/template/${encodeURIComponent(name)}`)),
  templateLogs: (cursor?: number) => json<{ result: string; cursor: number }>('GET', v2('/templates/logs'), { query: { cursor } }),

  installRole: (name: string, kind: 'role' | 'collection' = 'role') =>
    json<{ result: string }>('POST', v2(kind === 'role' ? '/ansible/role' : '/ansible/collection'), {
      json: kind === 'role' ? { role: name, action: 'install', force: false, global: false } : { collection: name, action: 'install', force: false, global: false },
    }),

  users: () => json<UserView[]>('GET', v2('/user/all')),
  addUser: (input: { userID: string; name: string; email: string; isAdmin: boolean; password?: string }) =>
    json<UserView & { apiKey: string }>('POST', v2('/user'), { json: input }),
  deleteUser: (userID: string, deleteRange: boolean) =>
    json<{ result: string }>('DELETE', v2(`/user/${encodeURIComponent(userID)}`), { query: { deleteDefaultRange: deleteRange ? 'true' : undefined } }),
  rotateApiKey: () => json<{ result: { apiKey: string; userID: string } }>('GET', v2('/user/apikey')),
  wireguard: () => json<{ result: { wireGuardConfig: string } }>('GET', v2('/user/wireguard')),
  setDefaultRange: (rangeID: string) => json<{ defaultRangeID: string }>('POST', v2('/user/default-range'), { json: { defaultRangeID: rangeID } }),
  setPassword: (userID: string, password: string) => json<{ result: string }>('POST', v2('/user/credentials'), { json: { userID, proxmoxPassword: password } }),

  etcHosts: (rangeID: string) => json<{ result: string }>('GET', v2('/range/etchosts'), { query: r(rangeID) }),
  inventory: (rangeID: string) => json<{ result: string }>('GET', v2('/range/ansibleinventory'), { query: r(rangeID) }),
  rdp: async (rangeID: string) => (await request('GET', v2('/range/rdpconfigs'), { query: r(rangeID) })).blob(),
};
