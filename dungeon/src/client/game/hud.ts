/**
 * The in-dungeon interface: party list, target frame, duty objectives, minimap, hotbar with
 * cooldowns, your health and cast bar, battle log, banners and the results screen.
 */
import { ROLES, SKILLS, WEAPONS, type RoleId } from '../../shared/content/classes.js';
import { STATUSES } from '../../shared/content/statuses.js';
import { T_FLOOR, T_GATE } from '../../shared/map.js';
import type { EntitySnap, MemberResult } from '../../shared/protocol.js';
import { clear, fmtNum, fmtTime, h } from '../dom.js';
import { roleIcon, skillIcon, statusIcon } from '../icons.js';
import { hideTooltip, skillTooltip, withTooltip } from '../ui/common.js';
import type { ClientEntity, World } from './world.js';

export interface HudHandlers {
  useSlot(index: number): void;
  setTarget(id: number | null): void;
  leave(): void;
  chat(text: string): void;
}

export const SLOT_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];

interface MemberRow {
  el: HTMLElement;
  name: HTMLElement;
  hp: HTMLElement;
  fill: HTMLElement;
  ghost: HTMLElement;
  shield: HTMLElement;
  mpBar: HTMLElement | null;
  mpFill: HTMLElement | null;
  status: HTMLElement;
  extra: HTMLElement;
}

interface SlotEl {
  el: HTMLElement;
  cd: HTMLElement;
  cdt: HTMLElement;
  id: string;
}

function statusChips(list: EntitySnap['s'], max = 10): HTMLElement[] {
  return (list ?? [])
    .filter(([id]) => STATUSES[id])
    .slice(0, max)
    .map(([id, left, stacks]) => {
      const chip = h('div', { class: 'status-chip' }, h('img', { src: statusIcon(id), alt: '' }), left < 900 ? h('span', { class: 't' }, String(Math.ceil(left))) : null, stacks > 1 ? h('span', { class: 'n' }, String(stacks)) : null);
      return withTooltip(chip, () => h('div', null, h('div', { class: 'tt-name' }, STATUSES[id]?.name ?? id), h('div', null, STATUSES[id]?.description ?? '')));
    });
}

export class Hud {
  readonly el: HTMLElement;
  private world: World;
  private handlers: HudHandlers;
  private party = h('div', { class: 'hud-panel party-list interactive' });
  private rows = new Map<number, MemberRow>();
  private target = h('div', { class: 'hud-panel target-frame' });
  private tName = h('span', { class: 'tf-name' });
  private tSub = h('span', { class: 'tf-sub' });
  private tPct = h('span', { class: 'tf-pct' });
  private tBar = h('div', { class: 'bar enemy' });
  private tFill = h('div', { class: 'fill' });
  private tGhost = h('div', { class: 'ghost' });
  private tCast = h('div', { class: 'tf-cast' });
  private tCastName = h('div', { class: 'tf-cast-name' });
  private tCastFill = h('div', { class: 'fill' });
  private tStatus = h('div', { class: 'tf-status' });
  private tTot = h('div', { class: 'tf-tot' });
  private dutyName = h('div', { class: 'duty-name' });
  private dutyMeta = h('div', { class: 'duty-meta' });
  private dutyObj = h('div', { class: 'duty-obj' });
  private mini = h('canvas', { width: 540, height: 400 });
  private miniImg: HTMLCanvasElement | null = null;
  private miniVersion = -1;
  private slots: SlotEl[] = [];
  private hpLbl = h('span');
  private hpVal = h('span');
  private hpFill = h('div', { class: 'fill' });
  private hpGhost = h('div', { class: 'ghost' });
  private hpShield = h('div', { class: 'shield' });
  private mpWrap = h('div', { class: 'me-bar' });
  private mpVal = h('span');
  private mpFill = h('div', { class: 'fill' });
  private castBar = h('div', { class: 'cast-bar' });
  private castName = h('span');
  private castTime = h('span');
  private castFill = h('div', { class: 'fill' });
  private errorEl = h('div', { class: 'skill-error' });
  private logLines = h('div', { class: 'log-lines' });
  private chatInput = h('input', { class: 'input interactive', placeholder: 'Press Enter to chat', maxlength: '200', 'aria-label': 'Chat' });
  private banner = h('div', { class: 'banner' });
  private countdown = h('div', { class: 'countdown' });
  private ko = h('div', { class: 'hud-panel ko-note' }, 'You have been knocked out. A Dawn Staff mage can raise you, or you will revive when the encounter ends.');
  private flash = h('div', { class: 'raid-flash' });
  private modal = h('div', { class: 'interactive' });
  private errorTimer = 0;
  private bannerQueue: { text: string; sub?: string; style: string }[] = [];
  private bannerBusy = false;
  private dutyKey = '';

  constructor(world: World, handlers: HudHandlers) {
    this.world = world;
    this.handlers = handlers;
    // Target frame.
    this.tBar.append(this.tGhost, this.tFill);
    const castBar = h('div', { class: 'bar cast' }, this.tCastFill);
    this.tCast.append(this.tCastName, castBar);
    this.target.append(h('div', { class: 'tf-head' }, this.tName, this.tSub, this.tPct), this.tBar, this.tCast, this.tStatus, this.tTot);
    // Hotbar.
    const hotbar = h('div', { class: 'hud-panel hotbar interactive' });
    world.hotbar.forEach((id, i) => {
      const cd = h('div', { class: 'cd' });
      const cdt = h('div', { class: 'cdt' });
      const el = h('div', { class: 'slot', 'data-skill': id }, h('img', { src: skillIcon(id), alt: SKILLS[id]?.name ?? id, draggable: false }), cd, cdt, h('span', { class: 'key' }, SLOT_KEYS[i] ?? ''));
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        handlers.useSlot(i);
      });
      withTooltip(el, () => skillTooltip(id));
      this.slots.push({ el, cd, cdt, id });
      hotbar.appendChild(el);
      if (i === 5 || i === 7) hotbar.appendChild(h('div', { class: 'slot-sep' }));
    });
    const me = world.meEntity();
    const role = (me?.spawn.role ?? 'tank') as RoleId;
    const hpBar = h('div', { class: 'bar' }, this.hpGhost, this.hpFill, this.hpShield);
    this.hpLbl.textContent = 'HP';
    const hpWrap = h('div', { class: 'me-bar' }, h('div', { class: 'lbl' }, this.hpLbl, this.hpVal), hpBar);
    this.mpWrap.append(h('div', { class: 'lbl' }, h('span', null, ROLES[role].mp > 0 ? 'MP' : ''), this.mpVal), h('div', { class: 'bar mp' }, this.mpFill));
    if (ROLES[role].mp === 0) this.mpWrap.style.visibility = 'hidden';
    this.castBar.append(h('div', { class: 'lbl' }, this.castName, this.castTime), h('div', { class: 'bar cast' }, this.castFill));
    const meBars = h('div', { class: 'me-bars' }, hpWrap, this.mpWrap);
    // Log and chat.
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        if (this.chatInput.value.trim()) handlers.chat(this.chatInput.value);
        this.chatInput.value = '';
        this.chatInput.blur();
      } else if (e.key === 'Escape') this.chatInput.blur();
    });
    const leave = h('button', { class: 'btn ghost small', onclick: () => confirm('Leave the dungeon? An AI companion will take your place.') && handlers.leave() }, 'Leave dungeon');
    const weapon = WEAPONS[me?.spawn.weapon ?? ''];
    this.el = h(
      'div',
      { class: 'hud' },
      this.flash,
      h(
        'div',
        { class: 'left-col' },
        h('div', { class: 'top-actions interactive' }, leave, h('span', { class: 'who-am-i' }, `${ROLES[role].name} · ${weapon?.name ?? ''}`)),
        this.party,
        h('div', { class: 'keys-help' }, 'WASD move · Click or Tab to target · 1–0 skills · F1–F4 select party · F follow · Wheel zoom · Enter chat'),
      ),
      this.target,
      h('div', { style: 'right:16px;top:16px;width:270px;display:flex;flex-direction:column;gap:10px' }, h('div', { class: 'hud-panel duty-panel', style: 'position:static;width:auto' }, this.dutyName, this.dutyMeta, this.dutyObj), h('div', { class: 'hud-panel minimap', style: 'position:static;width:auto' }, this.mini)),
      h('div', { class: 'hotbar-wrap' }, this.errorEl, this.castBar, meBars, hotbar),
      h('div', { class: 'hud-panel log interactive' }, this.logLines, this.chatInput),
      this.banner,
      this.countdown,
      this.ko,
      this.modal,
    );
    this.party.addEventListener('mouseleave', hideTooltip);
  }

  focusChat(): void {
    this.chatInput.focus();
  }

  chatFocused(): boolean {
    return document.activeElement === this.chatInput;
  }

  log(text: string, cls = 'sys'): void {
    this.logLines.appendChild(h('div', { class: cls }, text));
    while (this.logLines.childElementCount > 120) this.logLines.firstElementChild?.remove();
    this.logLines.scrollTop = this.logLines.scrollHeight;
  }

  chat(from: string, text: string): void {
    this.logLines.appendChild(h('div', { class: 'chat' }, h('span', { class: 'from' }, `${from}: `), text));
    this.logLines.scrollTop = this.logLines.scrollHeight;
  }

  error(text: string): void {
    this.errorEl.textContent = text;
    this.errorEl.style.opacity = '1';
    clearTimeout(this.errorTimer);
    this.errorTimer = window.setTimeout(() => (this.errorEl.style.opacity = '0'), 1400);
  }

  pressed(index: number): void {
    const s = this.slots[index];
    if (!s) return;
    s.el.classList.add('pressed');
    setTimeout(() => s.el.classList.remove('pressed'), 110);
  }

  showBanner(text: string, sub: string | undefined, style: string): void {
    this.bannerQueue.push({ text, sub, style });
    if (!this.bannerBusy) this.nextBanner();
  }

  private nextBanner(): void {
    const b = this.bannerQueue.shift();
    if (!b) {
      this.bannerBusy = false;
      return;
    }
    this.bannerBusy = true;
    clear(this.banner, h('div', { class: 'b-text' }, b.text), b.sub ? h('div', { class: 'b-sub' }, b.sub) : null, h('div', { class: 'b-rule' }));
    this.banner.className = `banner ${b.style} show`;
    const hold = b.style === 'complete' || b.style === 'boss' ? 3200 : 2200;
    setTimeout(() => {
      this.banner.classList.remove('show');
      setTimeout(() => this.nextBanner(), 500);
    }, hold);
  }

  showResults(results: MemberResult[], time: number, wipes: number, onLeave: () => void): void {
    const total = results.reduce((s, r) => s + r.damage, 0) || 1;
    clear(
      this.modal,
      h(
        'div',
        { class: 'modal-shade' },
        h(
          'div',
          { class: 'panel modal results' },
          h('div', { class: 'panel-title' }, 'Duty Complete', h('span', { class: 'sub' }, this.world.duty.name)),
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'stats' }, h('div', null, h('b', null, fmtTime(time)), h('span', { class: 'muted small' }, 'Clear time')), h('div', null, h('b', null, String(this.world.duty.bossCount)), h('span', { class: 'muted small' }, 'Bosses defeated')), h('div', null, h('b', null, String(wipes)), h('span', { class: 'muted small' }, 'Wipes'))),
            h(
              'table',
              null,
              h('thead', null, h('tr', null, h('th', null, 'Hero'), h('th', null, 'Weapon'), h('th', { class: 'num' }, 'Damage'), h('th', { class: 'num' }, 'DPS'), h('th', { class: 'num' }, 'Healing'), h('th', { class: 'num' }, 'KOs'))),
              h(
                'tbody',
                null,
                results.map((r) => {
                  const icon = h('span');
                  icon.innerHTML = roleIcon(r.role, 18);
                  return h(
                    'tr',
                    null,
                    h('td', null, icon, ' ', r.name, r.bot ? h('span', null, ' ', h('span', { class: 'ai-badge' }, 'AI')) : null),
                    h('td', { class: 'muted' }, WEAPONS[r.weapon]?.name ?? r.weapon),
                    h('td', { class: 'num' }, `${fmtNum(r.damage)} `, h('span', { class: 'muted small' }, `${Math.round((r.damage / total) * 100)}%`)),
                    h('td', { class: 'num' }, fmtNum(r.damage / Math.max(1, time))),
                    h('td', { class: 'num' }, fmtNum(r.healing)),
                    h('td', { class: 'num' }, String(r.deaths)),
                  );
                }),
              ),
            ),
            h('div', { class: 'ready-actions' }, h('button', { class: 'btn primary', onclick: onLeave }, 'Return to lobby'), h('button', { class: 'btn ghost', onclick: () => clear(this.modal) }, 'Stay a while')),
          ),
        ),
      ),
    );
  }

  // ── Per-frame update ─────────────────────────────────────────────────────────────────────

  update(targetId: number | null, me: { x: number; y: number }, full: boolean): void {
    const world = this.world;
    const now = world.serverNow();
    const meEnt = world.meEntity();
    const meSnap = meEnt?.snap;
    this.updateHotbar(targetId, me, now);
    if (meSnap) {
      const hpPct = (meSnap.hp / meSnap.mh) * 100;
      this.hpVal.textContent = `${fmtNum(meSnap.hp)} / ${fmtNum(meSnap.mh)}`;
      this.hpFill.style.width = `${hpPct}%`;
      this.hpGhost.style.width = `${((meEnt?.ghostHp ?? meSnap.hp) / meSnap.mh) * 100}%`;
      this.hpShield.style.width = `${Math.min(100, ((meSnap.b ?? 0) / meSnap.mh) * 100)}%`;
      if (meSnap.mm) {
        this.mpVal.textContent = `${fmtNum(meSnap.mp ?? 0)} / ${fmtNum(meSnap.mm)}`;
        this.mpFill.style.width = `${((meSnap.mp ?? 0) / meSnap.mm) * 100}%`;
      }
      const c = meSnap.c;
      if (c) {
        const p = Math.min(1, Math.max(0, (now - c[1]) / Math.max(0.01, c[2] - c[1])));
        this.castBar.classList.add('show');
        this.castName.textContent = c[0];
        this.castTime.textContent = `${Math.max(0, c[2] - now).toFixed(1)}s`;
        this.castFill.style.width = `${p * 100}%`;
      } else this.castBar.classList.remove('show');
      this.ko.classList.toggle('show', !!meSnap.d);
    }
    this.updateTarget(targetId, now);
    // Raidwide warning: flash the screen edges just before it lands.
    const raid = world.telegraphs.some((t) => t.style === 'raidwide' && t.end - now < 0.9 && t.end - now > 0);
    this.flash.classList.toggle('on', raid);
    if (!full) return;
    this.updateParty(targetId);
    this.updateDuty(now);
    this.drawMinimap(me);
  }

  private updateHotbar(targetId: number | null, me: { x: number; y: number }, now: number): void {
    const world = this.world;
    const mine = world.me;
    const meSnap = world.meEntity()?.snap;
    const statuses = new Set((meSnap?.s ?? []).map((s) => s[0]));
    const target = targetId != null ? world.ents.get(targetId) : undefined;
    for (const slot of this.slots) {
      const def = SKILLS[slot.id];
      if (!def || !mine) continue;
      let remaining = 0;
      let total = 1;
      const cd = mine.cds[slot.id];
      if (cd && cd > now) {
        remaining = cd - now;
        total = def.recast;
      }
      if (def.kind !== 'ability' && mine.gcd[1] > now && mine.gcd[1] - now > remaining) {
        remaining = mine.gcd[1] - now;
        total = Math.max(0.1, mine.gcd[1] - mine.gcd[0]);
      }
      const frac = Math.min(1, remaining / Math.max(0.01, total));
      slot.cd.style.background = frac > 0 ? `conic-gradient(rgba(0,0,0,0.05) ${(1 - frac) * 360}deg, rgba(6, 8, 14, 0.72) 0deg)` : '';
      slot.cdt.textContent = remaining > 1 && def.recast > 0 && cd && cd > now ? String(Math.ceil(remaining)) : '';
      const noMp = def.mp > (meSnap?.mp ?? 0);
      const needs = def.requires ? !statuses.has(def.requires) : false;
      slot.el.classList.toggle('unusable', noMp || needs || !!meSnap?.d);
      let outOfRange = false;
      if (def.target === 'enemy' && target && target.spawn.team === 'enemy') outOfRange = Math.hypot(target.x - me.x, target.y - me.y) - target.spawn.radius - 0.45 > def.range + 0.5;
      slot.el.classList.toggle('range', outOfRange);
      const glow = (def.combo && mine.combo === def.combo.from) || (def.requires && statuses.has(def.requires)) || (def.instantWith && statuses.has(def.instantWith));
      slot.el.classList.toggle('glow', !!glow && frac < 1);
      slot.el.classList.toggle('queued', mine.queued === slot.id);
    }
  }

  private updateTarget(targetId: number | null, now: number): void {
    const t = targetId != null ? this.world.ents.get(targetId) : undefined;
    if (!t || t.removed) {
      this.target.classList.remove('show');
      return;
    }
    this.target.classList.add('show');
    const s = t.snap;
    const enemy = t.spawn.team === 'enemy';
    this.tName.textContent = t.spawn.name;
    this.tSub.textContent = t.spawn.kind === 'boss' ? `Boss ${t.spawn.bossNumber ?? ''}` : enemy ? (t.spawn.mob === 'elite' ? 'Elite' : '') : `${ROLES[(t.spawn.role ?? 'tank') as RoleId].name}${t.spawn.bot ? ' · AI' : ''}`;
    this.tPct.textContent = `${((s.hp / s.mh) * 100).toFixed(1)}%`;
    this.tBar.className = enemy ? 'bar enemy' : 'bar';
    this.tFill.style.width = `${(s.hp / s.mh) * 100}%`;
    this.tGhost.style.width = `${(t.ghostHp / s.mh) * 100}%`;
    if (s.c) {
      const p = Math.min(1, Math.max(0, (now - s.c[1]) / Math.max(0.01, s.c[2] - s.c[1])));
      this.tCast.className = `tf-cast show${s.c[3] ? ' interruptible' : ''}`;
      clear(this.tCastName, h('span', null, s.c[0]), h('span', null, `${Math.max(0, s.c[2] - now).toFixed(1)}s`));
      this.tCastFill.style.width = `${p * 100}%`;
    } else this.tCast.className = 'tf-cast';
    const key = JSON.stringify((s.s ?? []).map((x) => [x[0], Math.ceil(x[1]), x[2]]));
    if (this.tStatus.dataset.key !== key) {
      this.tStatus.dataset.key = key;
      clear(this.tStatus, statusChips(s.s, 14));
    }
    const tot = s.t != null ? this.world.ents.get(s.t) : undefined;
    this.tTot.textContent = tot ? `Targeting ${tot.id === this.world.meId ? 'you' : tot.spawn.name}` : '';
  }

  private updateParty(targetId: number | null): void {
    const world = this.world;
    const members = world.partyMembers().sort((a, b) => (a.id === world.meId ? -1 : b.id === world.meId ? 1 : 0));
    // Which party member each targeted enemy is attacking.
    const aggroOn = targetId != null ? world.ents.get(targetId)?.snap.a : undefined;
    for (const [i, m] of members.entries()) {
      let row = this.rows.get(m.id);
      if (!row) {
        row = this.makeRow(m, i);
        this.rows.set(m.id, row);
        this.party.appendChild(row.el);
      }
      const s = m.snap;
      row.el.classList.toggle('dead', !!s.d);
      row.el.classList.toggle('targeted', targetId === m.id);
      row.hp.textContent = s.d ? 'KO' : fmtNum(s.hp);
      row.fill.style.width = `${(s.hp / s.mh) * 100}%`;
      row.ghost.style.width = `${(m.ghostHp / s.mh) * 100}%`;
      row.shield.style.width = `${Math.min(100, ((s.b ?? 0) / s.mh) * 100)}%`;
      if (row.mpFill && s.mm) row.mpFill.style.width = `${((s.mp ?? 0) / s.mm) * 100}%`;
      const key = JSON.stringify((s.s ?? []).map((x) => [x[0], Math.ceil(x[1]), x[2]]));
      if (row.status.dataset.key !== key) {
        row.status.dataset.key = key;
        clear(row.status, statusChips(s.s, 8));
      }
      const cast = s.c ? h('span', { class: 'cast-mini' }, `▸ ${s.c[0]}`) : null;
      const aggro = aggroOn === m.id ? h('span', { class: 'aggro-pip', title: 'Your target is attacking this hero' }, '◆') : null;
      const extraKey = `${s.c?.[0] ?? ''}|${aggroOn === m.id}|${s.ai ?? ''}`;
      if (row.extra.dataset.key !== extraKey) {
        row.extra.dataset.key = extraKey;
        clear(row.extra, aggro, cast, s.ai && !m.spawn.bot ? h('span', { class: 'ai-badge', title: 'AI is playing for this hero' }, 'AUTO') : null);
      }
    }
  }

  private makeRow(m: ClientEntity, index: number): MemberRow {
    const role = (m.spawn.role ?? 'tank') as RoleId;
    const icon = h('div', { class: 'pl-icon' });
    icon.innerHTML = roleIcon(role, 22);
    const name = h('span', { class: 'pl-name' }, m.spawn.name);
    const hp = h('span', { class: 'pl-hp' });
    const fill = h('div', { class: 'fill' });
    const ghost = h('div', { class: 'ghost' });
    const shield = h('div', { class: 'shield' });
    const extra = h('span');
    const status = h('div', { class: 'pl-status' });
    const hasMp = ROLES[role].mp > 0;
    const mpFill = hasMp ? h('div', { class: 'fill' }) : null;
    const mpBar = hasMp ? h('div', { class: 'bar mp' }, mpFill) : null;
    const el = h(
      'div',
      { class: `pl-member${m.id === this.world.meId ? ' me' : ''}`, title: `F${index + 1}` },
      icon,
      h('div', { class: 'pl-top' }, name, m.spawn.bot ? h('span', { class: 'ai-badge' }, 'AI') : null, extra, hp),
      h('div', { class: 'pl-bars' }, h('div', { class: 'bar' }, ghost, fill, shield), mpBar),
      status,
    );
    el.addEventListener('click', () => this.handlers.setTarget(m.id));
    return { el, name, hp, fill, ghost, shield, mpBar, mpFill, status, extra };
  }

  private updateDuty(now: number): void {
    const d = this.world.duty;
    const elapsed = d.phase === 'countdown' ? 0 : (d.completedAt ?? now) - d.startsAt;
    this.dutyName.textContent = d.name;
    clear(this.dutyMeta, h('span', null, `Bosses ${d.bossesDefeated}/${d.bossCount}${d.wipes ? ` · Wipes ${d.wipes}` : ''}`), h('span', null, fmtTime(elapsed)));
    const key = JSON.stringify(d.rooms.map((r) => [r.status, r.wave])) + d.phase + d.sealed;
    if (key !== this.dutyKey) {
      this.dutyKey = key;
      const current = d.rooms.find((r) => r.status !== 'cleared');
      clear(
        this.dutyObj,
        d.rooms
          .filter((r) => r.kind !== 'entrance')
          .map((r) => {
            const done = r.status === 'cleared';
            const isCur = r === current;
            const label = r.kind === 'boss' ? `Defeat ${r.bossName ?? 'the boss'}` : `Clear the ${r.name}`;
            const right = r.kind === 'trash' && r.status === 'active' ? `${Math.min(r.wave + 1, r.waves)}/${r.waves}` : r.kind === 'boss' && r.status === 'active' && d.sealed ? 'Sealed' : '';
            return h('div', { class: `obj${done ? ' done' : ''}${isCur ? ' current' : ''}${r.kind === 'boss' ? ' boss' : ''}` }, h('span', { class: 'mk' }, done ? '✓' : isCur ? '▸' : r.kind === 'boss' ? '♛' : '·'), h('span', null, label), h('span', { class: 'on' }, right));
          }),
      );
    }
    if (d.phase === 'countdown') {
      const left = Math.max(0, Math.ceil(d.startsAt - now));
      clear(this.countdown, 'The way will open in', h('b', null, String(left)));
    } else if (this.countdown.childElementCount) clear(this.countdown);
  }

  private drawMinimap(me: { x: number; y: number }): void {
    const world = this.world;
    const map = world.map;
    if (this.miniVersion !== world.mapVersion || !this.miniImg) {
      this.miniVersion = world.mapVersion;
      const c = document.createElement('canvas');
      c.width = map.w;
      c.height = map.h;
      const g = c.getContext('2d') as CanvasRenderingContext2D;
      const img = g.createImageData(map.w, map.h);
      for (let i = 0; i < map.tiles.length; i++) {
        const t = map.tiles[i];
        const o = i * 4;
        if (t === T_FLOOR) img.data.set([120, 130, 150, 255], o);
        else if (t === T_GATE) img.data.set([236, 211, 145, 255], o);
        else img.data.set([0, 0, 0, 0], o);
      }
      g.putImageData(img, 0, 0);
      this.miniImg = c;
    }
    const g = this.mini.getContext('2d') as CanvasRenderingContext2D;
    const W = this.mini.width;
    const H = this.mini.height;
    g.clearRect(0, 0, W, H);
    // A 90x66 tile window around you.
    const viewW = 90;
    const viewH = (viewW * H) / W;
    const scale = W / viewW;
    const ox = me.x - viewW / 2;
    const oy = me.y - viewH / 2;
    g.imageSmoothingEnabled = false;
    g.globalAlpha = 0.85;
    g.drawImage(this.miniImg, -ox * scale, -oy * scale, map.w * scale, map.h * scale);
    g.globalAlpha = 1;
    const dot = (x: number, y: number, r: number, color: string): void => {
      g.fillStyle = color;
      g.beginPath();
      g.arc((x - ox) * scale, (y - oy) * scale, r, 0, Math.PI * 2);
      g.fill();
    };
    // Objectives.
    const current = world.duty.rooms.find((r) => r.status !== 'cleared');
    if (current) {
      g.strokeStyle = 'rgba(236, 211, 145, 0.9)';
      g.lineWidth = 3;
      g.setLineDash([8, 6]);
      g.beginPath();
      g.arc((current.center.x - ox) * scale, (current.center.y - oy) * scale, 18, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    for (const e of world.ents.values()) {
      if (e.removed || e.diedAt) continue;
      if (e.spawn.team === 'enemy') {
        if (e.spawn.kind === 'boss') dot(e.x, e.y, 9, '#ff5b4a');
        else dot(e.x, e.y, 4, '#ff8f6a');
      }
    }
    for (const e of world.partyMembers()) if (e.id !== world.meId) dot(e.x, e.y, 6, ROLES[(e.spawn.role ?? 'tank') as RoleId].color);
    dot(me.x, me.y, 8, '#fff3d0');
  }
}
