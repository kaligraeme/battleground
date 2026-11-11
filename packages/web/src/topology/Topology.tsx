import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Check, Globe, Laptop, Maximize, Minus, Plus, Router as RouterIcon, ShieldAlert, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useMemo, useRef } from 'react';
import { Button, cx } from '../components/ui';
import { type Endpoint, type Layout, type Rect, layoutRange, polyline, structuralLinks, tracePath } from './layout';
import { type Selection, type TopologyModel, type TraceOverlay, type VmNode, vlanHue } from './model';
import { usePanZoom } from './usePanZoom';
import { VmCard, VmGrip } from './VmCard';

function pos(rect: Rect): CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.w, height: rect.h };
}

function sameEndpoint(a: Endpoint | undefined, b: Endpoint): boolean {
  if (!a || a.kind !== b.kind) return false;
  if (a.kind === 'vm' && b.kind === 'vm') return a.vlan === b.vlan && a.row === b.row;
  return true;
}

export interface TopologyProps {
  model: TopologyModel;
  mode: 'view' | 'build';
  selection: Selection;
  onSelect: (selection: Selection) => void;
  trace?: TraceOverlay;
  /** When set, clicking a node hands it to `onPick` instead of selecting it. */
  picking?: boolean;
  onPick?: (endpoint: Endpoint) => void;
  onAddVlan?: () => void;
  legend?: ReactNode;
  /** Overlay content positioned inside the viewport (e.g. empty-state hint). */
  children?: ReactNode;
}

export function Topology({ model, mode, selection, onSelect, trace, picking, onPick, onAddVlan, legend, children }: TopologyProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const building = mode === 'build';

  const layout = useMemo<Layout>(
    () =>
      layoutRange(
        model.lanes.map((lane) => ({ vlan: lane.vlan, vmCount: lane.vms.length })),
        { ghostLane: building },
      ),
    [model.lanes, building],
  );
  const links = useMemo(() => structuralLinks(layout), [layout]);
  const { view, panning, fit, zoomIn, zoomOut, handlers } = usePanZoom(viewportRef, layout);

  const traced = useMemo(() => (trace ? tracePath(layout, trace.from, trace.to) : undefined), [layout, trace]);

  const click = (sel: Selection, endpoint?: Endpoint) => {
    if (picking && endpoint && onPick) onPick(endpoint);
    else onSelect(sel);
  };

  const testing = model.testing?.enabled ?? false;
  const externalBlocked = testing || model.policy.external !== 'ACCEPT';
  const routerMidY = layout.router.y + layout.router.h / 2;

  return (
    <div
      ref={viewportRef}
      className={cx('canvas', panning && 'canvas--panning')}
      {...handlers}
      onClick={(event) => {
        if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('canvas__world')) {
          onSelect(null);
        }
      }}
    >
      <div
        className="canvas__world"
        style={{ width: layout.width, height: layout.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
      >
        <svg className="canvas__links" width={layout.width} height={layout.height} aria-hidden>
          <path className={cx('link', testing ? 'link--testing' : externalBlocked && 'link--blocked')} d={links.wan} />
          <path className={cx('link', model.policy.wireguard !== 'ACCEPT' && 'link--dim')} d={links.vpn} />
          {links.trunk ? <path className="link link--trunk" d={links.trunk} /> : null}
          {links.spines.map((d, i) => {
            const lane = layout.lanes[i];
            return lane ? (
              <path key={lane.vlan} className="link link--lane" d={d} style={{ '--vlan-hue': vlanHue(lane.vlan) } as CSSProperties} />
            ) : null;
          })}
          {traced && trace ? (
            <g>
              <path className={cx('trace trace--halo', `trace--${trace.verdict}`)} d={polyline(traced.inbound)} />
              <path className={cx('trace', `trace--${trace.verdict}`)} d={polyline(traced.inbound)} opacity={0.5} />
              <path className={cx('trace trace--flow', `trace--${trace.verdict}`)} d={polyline(traced.inbound)} />
              {traced.outbound.length > 1 ? (
                trace.verdict === 'accept' ? (
                  <>
                    <path className="trace trace--halo trace--accept" d={polyline(traced.outbound)} />
                    <path className="trace trace--accept" d={polyline(traced.outbound)} opacity={0.5} />
                    <path className="trace trace--flow trace--accept" d={polyline(traced.outbound)} />
                  </>
                ) : (
                  <path className={cx('trace trace--ghost', `trace--${trace.verdict}`)} d={polyline(traced.outbound)} />
                )
              ) : null}
            </g>
          ) : null}
        </svg>

        {/* Top row: Internet — router — VPN */}
        <button
          type="button"
          data-nopan
          className={cx(
            'node node--edge',
            selection?.kind === 'internet' && 'node--selected',
            picking && 'node--target',
            sameEndpoint(trace?.from, { kind: 'internet' }) && 'node--trace-src',
            sameEndpoint(trace?.to, { kind: 'internet' }) && 'node--trace-dst',
          )}
          style={pos(layout.internet)}
          onClick={() => click({ kind: 'internet' }, { kind: 'internet' })}
        >
          <span className="node__icon">
            <Globe />
          </span>
          <span className="grow">
            <div className="node__title">Internet</div>
            <div className="node__sub truncate">everything outside {model.cidr}</div>
          </span>
        </button>

        <button
          type="button"
          data-nopan
          className={cx('node node--router', selection?.kind === 'router' && 'node--selected')}
          style={pos(layout.router)}
          onClick={() => click({ kind: 'router' })}
        >
          <span className="node__icon">
            <RouterIcon />
          </span>
          <span className="grow">
            <div className="node__title truncate" title={model.router.name}>
              {model.router.name}
            </div>
            <div className="node__sub truncate">
              WAN {model.router.wanIp} · gateway .254
            </div>
          </span>
          {model.router.power ? (
            <span
              className={cx(
                'dot',
                model.router.power === 'on' && 'dot--ok',
                model.router.phase === 'working' && 'dot--warn dot--pulse',
              )}
              title={model.router.power === 'on' ? 'Powered on' : model.router.power === 'off' ? 'Powered off' : 'Not deployed'}
            />
          ) : null}
        </button>

        <button
          type="button"
          data-nopan
          className={cx(
            'node node--edge',
            selection?.kind === 'vpn' && 'node--selected',
            picking && 'node--target',
            sameEndpoint(trace?.from, { kind: 'vpn' }) && 'node--trace-src',
            sameEndpoint(trace?.to, { kind: 'vpn' }) && 'node--trace-dst',
          )}
          style={pos(layout.vpn)}
          onClick={() => click({ kind: 'vpn' }, { kind: 'vpn' })}
        >
          <span className="node__icon">
            <Laptop />
          </span>
          <span className="grow">
            <div className="node__title">VPN clients</div>
            <div className="node__sub truncate">you · {model.vpnClientIp}</div>
          </span>
        </button>

        <span
          className={cx('link-label', testing ? 'link-label--testing' : externalBlocked && 'link-label--err')}
          style={{ left: (layout.internet.x + layout.internet.w + layout.router.x) / 2, top: routerMidY }}
          title={testing ? 'Testing mode: outbound traffic is blocked unless explicitly allowed' : 'Default for traffic leaving the range'}
        >
          {testing ? 'TESTING' : `out ${model.policy.external}`}
        </span>
        <span
          className={cx('link-label', model.policy.wireguard !== 'ACCEPT' && 'link-label--err')}
          style={{ left: (layout.router.x + layout.router.w + layout.vpn.x) / 2, top: routerMidY }}
          title="Default for connections that VMs open towards VPN clients. VPN clients can always reach the VMs."
        >
          to VPN {model.policy.wireguard}
        </span>
        <button
          type="button"
          data-nopan
          className={cx('link-label link-label--btn', model.policy.interVlan !== 'ACCEPT' && 'link-label--err')}
          style={{ left: layout.router.x + layout.router.w / 2, top: (layout.router.y + layout.router.h + layout.busY) / 2 }}
          onClick={() => onSelect({ kind: 'network' })}
          title="Firewall policy between VLANs"
        >
          between VLANs {model.policy.interVlan}
          {model.policy.ruleCount > 0 ? ` · ${model.policy.ruleCount} rule${model.policy.ruleCount === 1 ? '' : 's'}` : ''}
        </button>

        {/* Lanes */}
        {model.lanes.map((lane, i) => {
          const laneLayout = layout.lanes[i];
          if (!laneLayout) return null;
          const style = { ...pos(laneLayout.rect), '--vlan-hue': vlanHue(lane.vlan) } as CSSProperties;
          const head = (
            <div className="lane__head" data-nopan onClick={() => onSelect({ kind: 'vlan', vlan: lane.vlan })}>
              <span className="lane__tag">VLAN {lane.vlan}</span>
              <span className="lane__cidr">{lane.cidr}</span>
              <span className="lane__count">
                {lane.vms.length} VM{lane.vms.length === 1 ? '' : 's'}
              </span>
            </div>
          );
          const selected = selection?.kind === 'vlan' && selection.vlan === lane.vlan;
          return building ? (
            <LaneDrop key={lane.vlan} vlan={lane.vlan} className={cx('lane', selected && 'lane--selected')} style={style}>
              {head}
              <div
                className="lane__foot"
                style={{
                  left: laneLayout.foot.x - laneLayout.rect.x,
                  top: laneLayout.foot.y - laneLayout.rect.y,
                  width: laneLayout.foot.w,
                  height: laneLayout.foot.h - 8,
                }}
              >
                Drop a template here
              </div>
            </LaneDrop>
          ) : (
            <div key={lane.vlan} className={cx('lane', selected && 'lane--selected')} style={style}>
              {head}
            </div>
          );
        })}

        {building && layout.ghost ? <GhostLane rect={layout.ghost} first={model.lanes.length === 0} onClick={onAddVlan} /> : null}

        {/* VM cards */}
        {model.lanes.map((lane, i) =>
          lane.vms.map((vm, row) => {
            const rect = layout.lanes[i]?.cards[row];
            if (!rect) return null;
            const endpoint: Endpoint = { kind: 'vm', vlan: lane.vlan, row };
            const flags = {
              traceSrc: sameEndpoint(trace?.from, endpoint),
              traceDst: sameEndpoint(trace?.to, endpoint),
              target: picking,
            };
            const selected = selection?.kind === 'vm' && selection.index === vm.index;
            const onClick = () => click({ kind: 'vm', index: vm.index }, endpoint);
            return building ? (
              <DraggableVm key={vm.index} vm={vm} rect={rect} selected={selected} onClick={onClick} />
            ) : (
              <VmCard
                key={vm.index}
                vm={vm}
                style={pos(rect)}
                selected={selected}
                flags={flags}
                role="button"
                tabIndex={0}
                onClick={onClick}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onClick();
                  }
                }}
              />
            );
          }),
        )}

        {traced && trace ? (
          <span className={cx('verdict-pin', `verdict-pin--${trace.verdict}`)} style={{ left: traced.decisionPoint.x, top: traced.decisionPoint.y }}>
            {trace.verdict === 'accept' ? <Check /> : trace.verdict === 'reject' ? <X /> : <ShieldAlert />}
            {trace.label}
          </span>
        ) : null}
      </div>

      <div className="canvas__controls" data-nopan>
        <Button variant="ghost" icon size="sm" tip="Zoom in" tipPos="right" onClick={zoomIn}>
          <Plus />
        </Button>
        <Button variant="ghost" icon size="sm" tip="Zoom out" tipPos="right" onClick={zoomOut}>
          <Minus />
        </Button>
        <Button variant="ghost" icon size="sm" tip="Fit to screen" tipPos="right" onClick={fit}>
          <Maximize />
        </Button>
        <div className="canvas__zoom num">{Math.round(view.k * 100)}%</div>
      </div>
      {legend ? (
        <div className="canvas__legend" data-nopan>
          {legend}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Build-mode pieces (need a DndContext above them)
// ---------------------------------------------------------------------------

export const laneDropId = (vlan: number) => `lane:${vlan}`;
export const NEW_LANE_DROP_ID = 'lane:new';
export const vmDragId = (index: number) => `vm:${index}`;

function LaneDrop({ vlan, className, style, children }: { vlan: number; className: string; style: CSSProperties; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: laneDropId(vlan), data: { type: 'lane', vlan } });
  return (
    <div ref={setNodeRef} className={cx(className, isOver && 'lane--over')} style={style} data-vlan={vlan}>
      {children}
    </div>
  );
}

function GhostLane({ rect, first, onClick }: { rect: Rect; first: boolean; onClick?: () => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: NEW_LANE_DROP_ID, data: { type: 'new-lane' } });
  return (
    <button
      type="button"
      ref={setNodeRef}
      data-nopan
      className={cx('lane lane--ghost', isOver && 'lane--over')}
      style={pos(rect)}
      onClick={onClick}
    >
      <Plus />
      <span>
        {first ? 'Drop a template here' : 'New VLAN'}
        <br />
        <span className="faint text-xs">{first ? 'to create the first network' : 'drop a template or click'}</span>
      </span>
    </button>
  );
}

function DraggableVm({ vm, rect, selected, onClick }: { vm: VmNode; rect: Rect; selected: boolean; onClick: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: vmDragId(vm.index),
    data: { type: 'vm', index: vm.index },
  });
  return (
    <VmCard
      ref={setNodeRef}
      vm={vm}
      style={pos(rect)}
      selected={selected}
      flags={{ dragging: isDragging }}
      grip={<VmGrip />}
      onClick={onClick}
      {...listeners}
      {...attributes}
    />
  );
}
