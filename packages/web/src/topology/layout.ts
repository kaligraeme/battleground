/**
 * Deterministic layout for the range diagram.
 *
 * A range config has no coordinates, so the picture is derived entirely from
 * its structure: Internet — router — VPN clients across the top, a horizontal
 * trunk below the router, and one lane per VLAN hanging off the trunk. Keeping
 * the layout a pure function of the config means the Build and View tabs always
 * draw the same range the same way, and connector geometry never needs DOM
 * measurement.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  w: number;
  h: number;
}

export const LANE_W = 272;
export const LANE_GAP = 28;
export const LANE_PAD = 10;
export const LANE_HEAD_H = 48;
/** Gutter on the left of each lane that carries the lane's "switch" spine. */
export const SPINE_GUTTER = 16;
export const CARD_W = LANE_W - LANE_PAD * 2 - SPINE_GUTTER;
export const CARD_H = 82;
export const CARD_GAP = 8;
export const LANE_FOOT_H = 40;

const ROUTER_W = 248;
const NODE_H = 68;
const SIDE_W = 196;
const SIDE_GAP = 104;
const BUS_DROP = 46;
const LANE_DROP = 36;
const MARGIN = 48;

export interface LaneInput {
  vlan: number;
  vmCount: number;
}

export interface LaneLayout {
  vlan: number;
  rect: Rect;
  /** X of the vertical spine the lane's VMs hang off. */
  spineX: number;
  cards: Rect[];
  /** Where a newly dropped card would appear (below the last card). */
  foot: Rect;
}

export interface Layout {
  width: number;
  height: number;
  internet: Rect;
  router: Rect;
  vpn: Rect;
  busY: number;
  lanes: LaneLayout[];
  /** The "new VLAN" drop lane, when requested. */
  ghost?: Rect;
}

export function layoutRange(lanes: LaneInput[], options: { ghostLane?: boolean; minLaneRows?: number } = {}): Layout {
  const minRows = options.minLaneRows ?? 1;
  const slots = lanes.length + (options.ghostLane ? 1 : 0);
  const lanesWidth = slots > 0 ? slots * LANE_W + (slots - 1) * LANE_GAP : 0;
  const topWidth = SIDE_W + SIDE_GAP + ROUTER_W + SIDE_GAP + SIDE_W;
  const innerWidth = Math.max(lanesWidth, topWidth);
  const width = innerWidth + MARGIN * 2;

  const centerX = width / 2;
  const top = MARGIN;
  const router: Rect = { x: centerX - ROUTER_W / 2, y: top, w: ROUTER_W, h: NODE_H };
  const internet: Rect = { x: router.x - SIDE_GAP - SIDE_W, y: top, w: SIDE_W, h: NODE_H };
  const vpn: Rect = { x: router.x + ROUTER_W + SIDE_GAP, y: top, w: SIDE_W, h: NODE_H };

  const busY = router.y + router.h + BUS_DROP;
  const laneTop = busY + LANE_DROP;
  const laneLeft = centerX - lanesWidth / 2;

  let maxBottom = laneTop;
  const laneLayouts: LaneLayout[] = lanes.map((lane, i) => {
    const x = laneLeft + i * (LANE_W + LANE_GAP);
    const rows = Math.max(lane.vmCount, minRows);
    const cardsX = x + LANE_PAD + SPINE_GUTTER;
    const cardsTop = laneTop + LANE_HEAD_H;
    const cards: Rect[] = [];
    for (let r = 0; r < lane.vmCount; r++) {
      cards.push({ x: cardsX, y: cardsTop + r * (CARD_H + CARD_GAP), w: CARD_W, h: CARD_H });
    }
    const foot: Rect = {
      x: cardsX,
      y: cardsTop + lane.vmCount * (CARD_H + CARD_GAP),
      w: CARD_W,
      h: LANE_FOOT_H,
    };
    const h = LANE_HEAD_H + rows * (CARD_H + CARD_GAP) + LANE_FOOT_H + LANE_PAD;
    maxBottom = Math.max(maxBottom, laneTop + h);
    return { vlan: lane.vlan, rect: { x, y: laneTop, w: LANE_W, h }, spineX: x + LANE_PAD + 5, cards, foot };
  });

  let ghost: Rect | undefined;
  if (options.ghostLane) {
    const x = laneLeft + lanes.length * (LANE_W + LANE_GAP);
    const h = Math.max(...laneLayouts.map((l) => l.rect.h), LANE_HEAD_H + CARD_H + CARD_GAP + LANE_FOOT_H + LANE_PAD);
    ghost = { x, y: laneTop, w: LANE_W, h };
    maxBottom = Math.max(maxBottom, laneTop + h);
  }

  return {
    width,
    height: maxBottom + MARGIN,
    internet,
    router,
    vpn,
    busY,
    lanes: laneLayouts,
    ghost,
  };
}

// ---------------------------------------------------------------------------
// Connector geometry
// ---------------------------------------------------------------------------

export type Endpoint =
  | { kind: 'vm'; vlan: number; row: number }
  | { kind: 'router' }
  | { kind: 'internet' }
  | { kind: 'vpn' };

function mid(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

function vmAnchor(layout: Layout, vlan: number, row: number): { lane: LaneLayout; card: Rect } | undefined {
  const lane = layout.lanes.find((l) => l.vlan === vlan);
  const card = lane?.cards[row];
  return lane && card ? { lane, card } : undefined;
}

/** Points from an endpoint up to the router's hub (bottom-centre of the router node). */
function toRouter(layout: Layout, endpoint: Endpoint): Point[] {
  const hub: Point = { x: layout.router.x + layout.router.w / 2, y: layout.router.y + layout.router.h };
  switch (endpoint.kind) {
    case 'router':
      return [hub];
    case 'internet':
      return [
        { x: layout.internet.x + layout.internet.w, y: mid(layout.internet).y },
        { x: layout.router.x, y: mid(layout.router).y },
      ];
    case 'vpn':
      return [
        { x: layout.vpn.x, y: mid(layout.vpn).y },
        { x: layout.router.x + layout.router.w, y: mid(layout.router).y },
      ];
    case 'vm': {
      const anchor = vmAnchor(layout, endpoint.vlan, endpoint.row);
      if (!anchor) return [hub];
      const y = anchor.card.y + anchor.card.h / 2;
      return [
        { x: anchor.card.x, y },
        { x: anchor.lane.spineX, y },
        { x: anchor.lane.spineX, y: layout.busY },
        { x: hub.x, y: layout.busY },
        hub,
      ];
    }
  }
}

export interface TracePath {
  /** Points from the source up to (and including) the router, or the full path when switched locally. */
  inbound: Point[];
  /** Points from the router on to the destination. Empty when the router is not involved. */
  outbound: Point[];
  /** Where to draw the verdict marker. */
  decisionPoint: Point;
  viaRouter: boolean;
}

/** Geometry for a traced packet between two endpoints. */
export function tracePath(layout: Layout, from: Endpoint, to: Endpoint): TracePath {
  if (from.kind === 'vm' && to.kind === 'vm' && from.vlan === to.vlan) {
    const a = vmAnchor(layout, from.vlan, from.row);
    const b = vmAnchor(layout, to.vlan, to.row);
    if (a && b) {
      const ya = a.card.y + a.card.h / 2;
      const yb = b.card.y + b.card.h / 2;
      const points: Point[] = [
        { x: a.card.x, y: ya },
        { x: a.lane.spineX, y: ya },
        { x: a.lane.spineX, y: yb },
        { x: b.card.x, y: yb },
      ];
      return { inbound: points, outbound: [], decisionPoint: { x: a.lane.spineX, y: (ya + yb) / 2 }, viaRouter: false };
    }
  }
  const inbound = toRouter(layout, from);
  const outbound = toRouter(layout, to).reverse();
  // The verdict sits on the router's top edge, so it never hides the router's name.
  return { inbound, outbound, decisionPoint: { x: layout.router.x + layout.router.w / 2, y: layout.router.y - 4 }, viaRouter: true };
}

export function polyline(points: Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
}

/** The always-present structural links: Internet—router, router—VPN, trunk and lane uplinks. */
export function structuralLinks(layout: Layout): { wan: string; vpn: string; trunk: string; spines: string[] } {
  const routerMid = mid(layout.router);
  const hubX = routerMid.x;
  const wan = polyline([
    { x: layout.internet.x + layout.internet.w, y: routerMid.y },
    { x: layout.router.x, y: routerMid.y },
  ]);
  const vpn = polyline([
    { x: layout.router.x + layout.router.w, y: routerMid.y },
    { x: layout.vpn.x, y: routerMid.y },
  ]);
  const xs = [hubX, ...layout.lanes.map((l) => l.spineX)];
  const trunk =
    layout.lanes.length === 0
      ? ''
      : `${polyline([
          { x: hubX, y: layout.router.y + layout.router.h },
          { x: hubX, y: layout.busY },
        ])} ${polyline([
          { x: Math.min(...xs), y: layout.busY },
          { x: Math.max(...xs), y: layout.busY },
        ])}`;
  const spines = layout.lanes.map((lane) => {
    const last = lane.cards[lane.cards.length - 1];
    const bottom = last ? last.y + last.h / 2 : lane.rect.y + LANE_HEAD_H / 2;
    const stubs = lane.cards
      .map((card) => polyline([{ x: lane.spineX, y: card.y + card.h / 2 }, { x: card.x, y: card.y + card.h / 2 }]))
      .join(' ');
    return `${polyline([
      { x: lane.spineX, y: layout.busY },
      { x: lane.spineX, y: bottom },
    ])} ${stubs}`;
  });
  return { wan, vpn, trunk, spines };
}
