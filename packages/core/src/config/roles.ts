/**
 * Ordering of user-defined Ansible roles.
 *
 * Roles on one VM run in the order they are listed. A role may also declare
 * `depends_on` entries naming a role on another (or the same) VM that has to
 * run first; a role that is pulled forward this way brings along the roles
 * listed above it on its own VM. The algorithm, including its tie-breaking and
 * its two error messages, follows the resolver a Ludus server runs when a
 * config is saved.
 */

import { resolveRangeId } from './addressing';
import { type RoleRef, type RouterConfig, type VmConfig } from './types';

export interface RoleStep {
  vmName: string;
  role: string;
}

export type RoleOrderResult = { ok: true; order: RoleStep[] } | { ok: false; error: string; vmName: string; role: string };

/** The router's VM name when the config does not set one. */
export function defaultRouterVmName(rangeId: string): string {
  return `${rangeId}-router-debian13-x64`;
}

const key = (vmName: string, role: string) => `${vmName}\u0000${role}`;

function compareSteps(a: RoleStep, b: RoleStep): number {
  if (a.vmName !== b.vmName) return a.vmName < b.vmName ? -1 : 1;
  if (a.role !== b.role) return a.role < b.role ? -1 : 1;
  return 0;
}

export function resolveRoleOrder(
  config: { ludus?: readonly Pick<VmConfig, 'vm_name' | 'roles'>[]; router?: Pick<RouterConfig, 'vm_name' | 'roles'> },
  rangeId: string,
): RoleOrderResult {
  const render = (text: string) => resolveRangeId(text, rangeId);
  const graph = new Map<string, RoleStep[]>();
  const nodes = new Map<string, RoleStep>();
  const perVm: RoleStep[][] = [];

  const addVm = (vmName: string, roles: readonly RoleRef[] | undefined) => {
    const ordered: RoleStep[] = [];
    for (const role of roles ?? []) {
      let name: string;
      let dependsOn: RoleStep[] = [];
      if (typeof role === 'string') name = role;
      else if (role && typeof role === 'object' && typeof role.name === 'string') {
        name = role.name;
        dependsOn = (role.depends_on ?? []).map((dep) => ({ vmName: render(String(dep.vm_name)), role: String(dep.role) }));
      } else continue;
      const node: RoleStep = { vmName, role: name };
      nodes.set(key(vmName, name), node);
      graph.set(key(vmName, name), dependsOn);
      ordered.push(node);
    }
    perVm.push(ordered);
  };

  for (const vm of config.ludus ?? []) addVm(render(String(vm.vm_name)), vm.roles);
  addVm(render(config.router?.vm_name ?? defaultRouterVmName(rangeId)), config.router?.roles);

  const dependsOnTransitively = (from: RoleStep, target: RoleStep): boolean => {
    const stack = [from];
    const seen = new Set<string>();
    const targetKey = key(target.vmName, target.role);
    while (stack.length > 0) {
      const current = stack.pop() as RoleStep;
      const currentKey = key(current.vmName, current.role);
      if (currentKey === targetKey) return true;
      if (seen.has(currentKey)) continue;
      seen.add(currentKey);
      stack.push(...(graph.get(currentKey) ?? []));
    }
    return false;
  };

  // List order becomes an implicit dependency, unless explicit ones already demand the opposite.
  for (const ordered of perVm) {
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1] as RoleStep;
      const node = ordered[i] as RoleStep;
      if (!dependsOnTransitively(prev, node)) graph.get(key(node.vmName, node.role))?.push(prev);
    }
  }

  const order: RoleStep[] = [];
  const permanent = new Set<string>();
  const temporary = new Set<string>();
  let failure: RoleOrderResult | undefined;

  const visit = (node: RoleStep): boolean => {
    const nodeKey = key(node.vmName, node.role);
    if (permanent.has(nodeKey)) return true;
    if (temporary.has(nodeKey)) {
      failure = { ok: false, error: `ERROR: Circular dependency found for ${node.vmName}:${node.role}`, vmName: node.vmName, role: node.role };
      return false;
    }
    temporary.add(nodeKey);
    const neighbours = graph.get(nodeKey);
    if (!neighbours) {
      failure = { ok: false, error: `ERROR: Dependency not found ${node.vmName}:${node.role}`, vmName: node.vmName, role: node.role };
      return false;
    }
    for (const neighbour of [...neighbours].sort(compareSteps)) {
      if (!visit(neighbour)) return false;
    }
    temporary.delete(nodeKey);
    permanent.add(nodeKey);
    order.push(node);
    return true;
  };

  for (const node of nodes.values()) {
    if (!visit(node)) return failure as RoleOrderResult;
  }
  return { ok: true, order };
}

/** True when any VM or the router lists at least one role. */
export function hasRoles(config: { ludus?: readonly Pick<VmConfig, 'roles'>[]; router?: Pick<RouterConfig, 'roles'> }): boolean {
  return (config.ludus ?? []).some((vm) => (vm.roles?.length ?? 0) > 0) || (config.router?.roles?.length ?? 0) > 0;
}
