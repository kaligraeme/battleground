/**
 * Runs a dungeon on the client: reads input, predicts your own movement, sends actions,
 * applies server snapshots and events, and drives the renderer and HUD every frame.
 */
import { PLAYER_RADIUS, PLAYER_SPEED } from '../../shared/constants.js';
import { SKILLS } from '../../shared/content/classes.js';
import { STATUSES } from '../../shared/content/statuses.js';
import { angleTo, dist } from '../../shared/geometry.js';
import { findPath, moveCircle } from '../../shared/map.js';
import type { GameEvent, InstanceStart, ServerMsg } from '../../shared/protocol.js';
import { h } from '../dom.js';
import type { Net } from '../net.js';
import { Effects } from './fx.js';
import { Hud, SLOT_KEYS } from './hud.js';
import { Renderer } from './renderer.js';
import { World } from './world.js';

export class Game {
  readonly el: HTMLElement;
  readonly world: World;
  private canvas = h('canvas', { class: 'world' });
  private renderer: Renderer;
  private hud: Hud;
  private fx = new Effects();
  private local = { x: 0, y: 0, f: 0 };
  private epoch = 0;
  private keys = new Set<string>();
  private targetId: number | null = null;
  /** Auto-follow a party member (F key). */
  private followId: number | null = null;
  private followPath: { x: number; y: number }[] | null = null;
  private followPathAt = 0;
  private hoverId: number | null = null;
  private zoom = 34;
  private raf = 0;
  private last = performance.now();
  private lastSend = 0;
  private sent = { x: 0, y: 0, f: 0 };
  private hudTick = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private net: Net,
    start: InstanceStart,
  ) {
    this.world = new World(start);
    this.renderer = new Renderer(this.canvas);
    this.hud = new Hud(this.world, {
      useSlot: (i) => this.useSlot(i),
      setTarget: (id) => this.setTarget(id),
      leave: () => this.net.send({ t: 'instance.leave' }),
      chat: (text) => this.net.send({ t: 'chat', text }),
    });
    this.el = h('div', { class: 'game' }, this.canvas, this.hud.el);
    this.bindInput();
    this.hud.log(`Entering ${start.duty.name}.`, 'sys');
    this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    for (const d of this.disposers) d();
  }

  // ── Network ──────────────────────────────────────────────────────────────────────────────

  onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'snap': {
        // Events first, so spawns exist before their snapshot rows.
        for (const ev of msg.ev) this.onEvent(ev);
        this.world.applySnapshot(msg.time, msg.ents, msg.tgs);
        if (msg.me) {
          this.world.me = msg.me;
          const meSnap = msg.ents.find((e) => e.i === msg.me?.id);
          if (meSnap && (msg.me.epoch !== this.epoch || meSnap.d)) {
            // The server moved us (dash, knockback, respawn) or we are down: take its position.
            if (msg.me.epoch !== this.epoch || dist(meSnap, this.local) > 0.05) {
              this.local.x = meSnap.x;
              this.local.y = meSnap.y;
            }
            this.epoch = msg.me.epoch;
          } else if (meSnap && this.local.x === 0 && this.local.y === 0) {
            this.local = { x: meSnap.x, y: meSnap.y, f: meSnap.f };
          }
        }
        break;
      }
      case 'skillFail':
        if (msg.reason !== 'Not ready yet') this.hud.error(msg.reason);
        break;
      case 'chat':
        this.hud.chat(msg.from, msg.text);
        break;
      default:
        break;
    }
  }

  private onEvent(ev: GameEvent): void {
    const w = this.world;
    const pos = (id: number | undefined): { x: number; y: number } | null => {
      if (id === undefined) return null;
      if (id === w.meId) return this.local;
      const e = w.ents.get(id);
      return e ? { x: e.x, y: e.y } : null;
    };
    switch (ev.e) {
      case 'spawn':
        w.addEntity(ev.ent);
        break;
      case 'despawn': {
        const e = w.ents.get(ev.i);
        if (e) {
          e.removed = true;
          if (!e.diedAt) w.ents.delete(ev.i);
        }
        if (this.targetId === ev.i) this.targetId = null;
        break;
      }
      case 'death': {
        const e = w.ents.get(ev.i);
        if (e) e.diedAt = performance.now() / 1000;
        if (e?.spawn.kind === 'boss') this.renderer.shake(1.2);
        if (e?.spawn.team === 'enemy' && this.targetId === ev.i) this.targetId = null;
        break;
      }
      case 'raise': {
        const e = w.ents.get(ev.i);
        if (e) e.diedAt = null;
        const p = pos(ev.i);
        if (p) this.fx.add({ kind: 'buff', x: p.x, y: p.y, x2: 0, y2: 0, follow: ev.i, hue: 50, r: 1, life: 1.2 });
        break;
      }
      case 'dmg': {
        const t = pos(ev.t);
        if (!t) break;
        const target = w.ents.get(ev.t);
        const mine = ev.s === w.meId;
        const onParty = target?.spawn.team === 'party';
        if (onParty) {
          if (ev.t === w.meId || ev.v > 1500) this.fx.text(`-${ev.v}`, t.x, t.y, '#ff6b5b', ev.t === w.meId ? 15 : 12);
          if (ev.t === w.meId && ev.v > 2500) this.renderer.shake(0.6);
        } else if (mine) {
          this.fx.text(`${ev.v}${ev.c ? '!' : ''}`, t.x, t.y, ev.c ? '#ffd76a' : '#ffffff', ev.c ? 19 : 15);
        } else if (ev.v > 0) {
          this.fx.text(String(ev.v), t.x, t.y, 'rgba(220, 225, 235, 0.65)', 11);
        }
        break;
      }
      case 'heal': {
        const t = pos(ev.t);
        if (!t || ev.v <= 0) break;
        if (ev.t === w.meId || ev.s === w.meId) this.fx.text(`+${ev.v}${ev.c ? '!' : ''}`, t.x, t.y, '#8ff0a4', ev.c ? 16 : 13);
        break;
      }
      case 'fx': {
        const s = pos(ev.s);
        const t = pos(ev.t);
        const hue = ev.hue ?? 40;
        if (ev.k === 'proj' && s && t) this.fx.add({ kind: 'proj', x: s.x, y: s.y, x2: t.x, y2: t.y, follow: null, hue, r: 0.3, life: 0.22 });
        else if (ev.k === 'slash' && (t || ev.x !== undefined)) this.fx.add({ kind: 'slash', x: t?.x ?? (ev.x as number), y: t?.y ?? (ev.y as number), x2: 0, y2: 0, follow: ev.t ?? null, hue, r: Math.min(3, (ev.r ?? 1.2) * 0.6) || 1.2, life: 0.28 });
        else if (ev.k === 'burst' && ev.x !== undefined) this.fx.add({ kind: 'burst', x: ev.x, y: ev.y as number, x2: 0, y2: 0, follow: null, hue, r: ev.r ?? 3, life: 0.45 });
        else if (ev.k === 'impact' && ev.x !== undefined) {
          this.fx.add({ kind: 'impact', x: ev.x, y: ev.y as number, x2: 0, y2: 0, follow: null, hue, r: ev.r ?? 3, life: 0.5 });
          if (dist({ x: ev.x, y: ev.y as number }, this.local) < (ev.r ?? 3) + 4) this.renderer.shake(0.5);
        } else if ((ev.k === 'heal' || ev.k === 'buff') && t) this.fx.add({ kind: ev.k, x: t.x, y: t.y, x2: 0, y2: 0, follow: ev.t ?? null, hue, r: 1, life: 0.9 });
        else if (ev.k === 'dash' && s && ev.x !== undefined) this.fx.add({ kind: 'dash', x: ev.x, y: ev.y as number, x2: s.x, y2: s.y, follow: null, hue, r: 1, life: 0.35 });
        else if (ev.k === 'rift' && ev.x !== undefined) this.fx.add({ kind: 'rift', x: ev.x, y: ev.y as number, x2: 0, y2: 0, follow: null, hue, r: ev.r ?? 1.5, life: 0.9 });
        else if (ev.k === 'shout' && s) this.fx.add({ kind: 'shout', x: s.x, y: s.y, x2: 0, y2: 0, follow: ev.s ?? null, hue, r: 6, life: 0.6 });
        break;
      }
      case 'gate':
        w.setGate(ev.id, ev.open);
        break;
      case 'banner':
        this.hud.showBanner(ev.text, ev.sub, ev.style);
        break;
      case 'log':
        this.hud.log(ev.text, ev.cls ?? 'sys');
        break;
      case 'interrupt': {
        const p = pos(ev.i);
        if (p) this.fx.text('Interrupted', p.x, p.y, '#9fd6ff', 12);
        break;
      }
      case 'duty':
        w.duty = ev.duty;
        break;
      case 'complete':
        setTimeout(() => this.hud.showResults(ev.results, ev.time, ev.wipes, () => this.net.send({ t: 'instance.leave' })), 3500);
        break;
      default:
        break;
    }
  }

  // ── Input ────────────────────────────────────────────────────────────────────────────────

  private bindInput(): void {
    const down = (e: KeyboardEvent): void => {
      if (this.hud.chatFocused()) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (['w', 'a', 's', 'd', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k)) {
        this.keys.add(k);
        e.preventDefault();
        return;
      }
      const slot = SLOT_KEYS.indexOf(k);
      if (slot >= 0) {
        e.preventDefault();
        this.useSlot(slot);
        return;
      }
      if (k === 'f') {
        e.preventDefault();
        this.toggleFollow();
        return;
      }
      if (k === 'Tab') {
        e.preventDefault();
        this.cycleTarget(e.shiftKey);
      } else if (k === 'Escape') {
        this.targetId = null;
        this.net.send({ t: 'target', id: null });
      } else if (k === 'Enter') {
        e.preventDefault();
        this.hud.focusChat();
      } else if (/^F[1-4]$/.test(k)) {
        e.preventDefault();
        const members = this.world.partyMembers().sort((a, b) => (a.id === this.world.meId ? -1 : b.id === this.world.meId ? 1 : 0));
        const m = members[Number(k.slice(1)) - 1];
        if (m) this.setTarget(m.id);
      }
    };
    const up = (e: KeyboardEvent): void => {
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      this.keys.delete(k);
    };
    const blur = (): void => this.keys.clear();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.disposers.push(() => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const id = this.pick(e.clientX, e.clientY);
      if (id != null) this.setTarget(id);
    });
    this.canvas.addEventListener('mousemove', (e) => {
      this.hoverId = this.pick(e.clientX, e.clientY);
      this.canvas.style.cursor = this.hoverId != null ? 'pointer' : 'crosshair';
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = Math.min(64, Math.max(16, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      },
      { passive: false },
    );
  }

  private pick(cx: number, cy: number): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const p = this.renderer.screenToWorld(cx - rect.left, cy - rect.top);
    let best: number | null = null;
    let bestD = Infinity;
    for (const e of this.world.ents.values()) {
      if (e.removed || (e.diedAt && e.spawn.team === 'enemy')) continue;
      const ex = e.id === this.world.meId ? this.local.x : e.x;
      const ey = e.id === this.world.meId ? this.local.y : e.y;
      const d = Math.hypot(p.x - ex, p.y - ey) - e.spawn.radius;
      const bias = e.spawn.team === 'enemy' ? -0.2 : 0;
      if (d < 0.35 && d + bias < bestD) {
        best = e.id;
        bestD = d + bias;
      }
    }
    return best;
  }

  private toggleFollow(): void {
    if (this.followId != null) {
      this.followId = null;
      this.hud.error('Stopped following');
      return;
    }
    const t = this.targetId != null ? this.world.ents.get(this.targetId) : undefined;
    const pick = t && t.spawn.team === 'party' && t.id !== this.world.meId ? t : this.world.partyMembers().find((m) => m.spawn.role === 'tank' && m.id !== this.world.meId);
    if (!pick) return this.hud.error('Target a party member to follow');
    this.followId = pick.id;
    this.followPath = null;
    this.hud.error(`Following ${pick.spawn.name}`);
  }

  private setTarget(id: number | null): void {
    this.targetId = id;
    this.net.send({ t: 'target', id });
  }

  private cycleTarget(back: boolean): void {
    const list = this.world
      .enemies()
      .filter((e) => dist(e, this.local) < 30)
      .sort((a, b) => dist(a, this.local) - dist(b, this.local));
    if (!list.length) return;
    const i = list.findIndex((e) => e.id === this.targetId);
    const next = list[(i + (back ? -1 : 1) + list.length) % list.length];
    if (next) this.setTarget(next.id);
  }

  private useSlot(index: number): void {
    const id = this.world.hotbar[index];
    const def = id ? SKILLS[id] : undefined;
    if (!id || !def) return;
    this.hud.pressed(index);
    let target = this.targetId;
    const t = target != null ? this.world.ents.get(target) : undefined;
    if (def.target === 'enemy' && (!t || t.spawn.team !== 'enemy' || t.diedAt)) {
      // Nothing hostile selected: pick the nearest enemy for convenience.
      const near = this.world
        .enemies()
        .filter((e) => dist(e, this.local) <= def.range + e.spawn.radius + 1)
        .sort((a, b) => dist(a, this.local) - dist(b, this.local))[0];
      if (near) {
        this.setTarget(near.id);
        target = near.id;
      }
    }
    if (def.target === 'deadAlly' && (!t || !t.snap.d)) {
      const fallen = this.world.partyMembers().find((m) => m.snap.d);
      if (fallen) target = fallen.id;
    }
    if (def.target !== 'none' && def.target !== 'ally' && target != null) {
      const tt = this.world.ents.get(target);
      if (tt) this.local.f = angleTo(this.local, tt);
    }
    this.net.send({ t: 'skill', id, target });
  }

  // ── Frame ────────────────────────────────────────────────────────────────────────────────

  private frame(t: number): void {
    const dt = Math.min(0.1, (t - this.last) / 1000);
    this.last = t;
    this.raf = requestAnimationFrame((n) => this.frame(n));
    this.world.interpolate(dt);
    this.updateMovement(dt, t);
    const now = performance.now() / 1000;
    this.fx.prune(now);
    this.renderer.render({ world: this.world, fx: this.fx, me: this.local, targetId: this.targetId, hoverId: this.hoverId, zoom: this.zoom }, dt);
    this.hudTick += dt;
    const full = this.hudTick > 0.1;
    if (full) this.hudTick = 0;
    this.hud.update(this.targetId, this.local, full);
  }

  private updateMovement(dt: number, t: number): void {
    const me = this.world.meEntity();
    const snap = me?.snap;
    if (!snap) return;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('w') || this.keys.has('ArrowUp')) dy -= 1;
    if (this.keys.has('s') || this.keys.has('ArrowDown')) dy += 1;
    if (this.keys.has('a') || this.keys.has('ArrowLeft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('ArrowRight')) dx += 1;
    const statuses = snap.s ?? [];
    const stunned = statuses.some(([id]) => STATUSES[id]?.stun);
    const speedMod = statuses.reduce((s, [id, , stacks]) => s + (STATUSES[id]?.speed ?? 0) * stacks, 0);
    if (dx || dy) this.followId = null;
    else if (this.followId != null && !snap.d) {
      // Auto-follow: walk toward the followed hero, pathing around walls.
      const f = this.world.ents.get(this.followId);
      if (!f || f.removed) this.followId = null;
      else if (dist(f, this.local) > 2.4) {
        if (!this.followPath || t - this.followPathAt > 400) {
          this.followPath = findPath(this.world.map, this.local, f, PLAYER_RADIUS, 30000);
          this.followPathAt = t;
        }
        while (this.followPath && this.followPath.length > 1 && dist(this.followPath[0] as { x: number; y: number }, this.local) < 0.4) this.followPath.shift();
        const wp = this.followPath?.[0] ?? f;
        dx = wp.x - this.local.x;
        dy = wp.y - this.local.y;
      }
    }
    if ((dx || dy) && !snap.d && !stunned) {
      const len = Math.hypot(dx, dy);
      const step = PLAYER_SPEED * Math.max(0.3, 1 + speedMod) * dt;
      const to = moveCircle(this.world.map, this.local, (dx / len) * step, (dy / len) * step, PLAYER_RADIUS);
      this.local.x = to.x;
      this.local.y = to.y;
      this.local.f = Math.atan2(dy, dx);
    } else if (this.targetId != null && !snap.d) {
      const tt = this.world.ents.get(this.targetId);
      if (tt && tt.id !== this.world.meId) this.local.f = angleTo(this.local, tt);
    }
    // Send our position at up to 20 Hz when it changes.
    const changed = Math.abs(this.local.x - this.sent.x) > 0.001 || Math.abs(this.local.y - this.sent.y) > 0.001 || Math.abs(this.local.f - this.sent.f) > 0.05;
    if (changed && t - this.lastSend > 50) {
      this.lastSend = t;
      this.sent = { ...this.local };
      this.net.send({ t: 'move', x: Math.round(this.local.x * 1000) / 1000, y: Math.round(this.local.y * 1000) / 1000, f: Math.round(this.local.f * 100) / 100, ep: this.epoch });
    }
  }
}
