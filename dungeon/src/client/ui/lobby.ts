/** The lobby: character (role and weapon), party, expedition queue, ready check and chat. */
import { READY_CHECK_SECONDS } from '../../shared/constants.js';
import { ROLE_ORDER, ROLES, SKILLS, WEAPONS, type RoleId } from '../../shared/content/classes.js';
import type { AiFill, LobbyState } from '../../shared/protocol.js';
import { clear, fmtTime, h, toast } from '../dom.js';
import { roleIcon, skillIcon } from '../icons.js';
import type { Net } from '../net.js';
import { skillTooltip, withTooltip } from './common.js';

const FILL_OPTIONS: { label: string; value: AiFill }[] = [
  { label: 'Now', value: 0 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '60s', value: 60 },
  { label: 'Never', value: null },
];

export class LobbyView {
  readonly el: HTMLElement;
  private state: LobbyState | null = null;
  private aiFill: AiFill = 15;
  private clockOffset = 0;
  private timer: number;

  private statusEl = h('span');
  private onlineEl = h('span');
  private rejoinBtn = h('button', { class: 'btn small', style: 'display:none' }, 'Return to dungeon');
  private rolesEl = h('div', { class: 'roles' });
  private roleDescEl = h('p', { class: 'role-desc' });
  private weaponsEl = h('div', { class: 'weapons' });
  private skillsEl = h('div', { class: 'skill-list' });
  private codeEl = h('span', { class: 'code' }, '-----');
  private slotsEl = h('div', { class: 'party-slots' });
  private joinInput = h('input', { class: 'input', placeholder: 'Party code', maxlength: '5', 'aria-label': 'Party code' });
  private leaveBtn = h('button', { class: 'btn ghost small' }, 'Leave party');
  private chatLines = h('div', { class: 'chat-lines' });
  private chatInput = h('input', { class: 'input', placeholder: 'Say something to your party…', maxlength: '200', 'aria-label': 'Party chat' });
  private fillEl = h('div', { class: 'fill-options' });
  private queueBtn = h('button', { class: 'btn primary' }, 'Join Queue');
  private queueEl = h('div');
  private queueHint = h('p', { class: 'hint' });
  private modalHost = h('div');
  private lastRoleRendered: RoleId | null = null;
  private lastWeaponRendered: string | null = null;

  constructor(private net: Net) {
    this.rejoinBtn.addEventListener('click', () => net.send({ t: 'instance.rejoin' }));
    this.leaveBtn.addEventListener('click', () => net.send({ t: 'party.leave' }));
    const join = (): void => {
      const code = this.joinInput.value.trim().toUpperCase();
      if (code.length !== 5) return toast('Party codes have 5 characters.', 'error');
      net.send({ t: 'party.join', code });
      this.joinInput.value = '';
    };
    this.joinInput.addEventListener('keydown', (e) => e.key === 'Enter' && join());
    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !this.chatInput.value.trim()) return;
      net.send({ t: 'chat', text: this.chatInput.value });
      this.chatInput.value = '';
    });
    this.queueBtn.addEventListener('click', () => {
      if (this.state?.queue) net.send({ t: 'queue.leave' });
      else net.send({ t: 'queue.join', aiFill: this.aiFill });
    });
    for (const role of ROLE_ORDER) {
      const def = ROLES[role];
      const card = h('button', { class: 'role-card', 'data-role': role, style: `--rc:${def.color}`, onclick: () => this.pickRole(role) });
      card.innerHTML = roleIcon(role, 30);
      card.append(h('span', { class: 'rname' }, def.name), h('span', { class: 'rtag' }, def.tagline));
      this.rolesEl.appendChild(card);
    }
    this.renderFill();

    const copyBtn = h('button', { class: 'btn ghost small', onclick: () => this.copyCode() }, 'Copy');
    this.el = h(
      'div',
      { class: 'lobby' },
      h('div', { class: 'topbar' }, h('span', { class: 'mini-logo' }, 'LUMENFALL'), h('span', { class: 'spacer' }), this.rejoinBtn, h('span', { class: 'who' }, this.onlineEl, this.statusEl)),
      h(
        'div',
        { class: 'lobby-grid' },
        h(
          'section',
          { class: 'panel' },
          h('div', { class: 'panel-title' }, 'Character', h('span', { class: 'sub' }, 'Role and weapon')),
          h('div', { class: 'section' }, h('div', { class: 'label' }, 'Role'), this.rolesEl, this.roleDescEl),
          h('div', { class: 'section' }, h('div', { class: 'label' }, 'Weapon'), this.weaponsEl),
          h('div', { class: 'section' }, h('div', { class: 'label' }, 'Skills'), this.skillsEl),
        ),
        h(
          'section',
          { class: 'panel' },
          h('div', { class: 'panel-title' }, 'Party', h('span', { class: 'sub' }, 'Up to four heroes')),
          h(
            'div',
            { class: 'section stack' },
            h('div', { class: 'code-box' }, h('div', null, h('div', { class: 'label', style: 'margin:0' }, 'Your party code'), this.codeEl), copyBtn),
            this.slotsEl,
            h('div', { class: 'row' }, this.joinInput, h('button', { class: 'btn small', onclick: join }, 'Join'), this.leaveBtn),
            h('div', { class: 'chat' }, h('div', { class: 'label' }, 'Party chat'), this.chatLines, this.chatInput),
          ),
        ),
        h(
          'section',
          { class: 'panel' },
          h('div', { class: 'panel-title' }, 'Expedition Finder'),
          h(
            'div',
            { class: 'section stack' },
            h('div', { class: 'duty-art' }, h('div', { class: 'dname' }, 'Random Dungeon Expedition')),
            h('div', { class: 'duty-facts' }, h('div', null, h('b', null, '3–4'), h('span', null, 'Bosses')), h('div', null, h('b', null, '4'), h('span', null, 'Heroes')), h('div', null, h('b', null, '∞'), h('span', null, 'Layouts'))),
            h('p', { class: 'hint' }, 'Each run is a freshly generated dungeon: fight through waves of monsters, then face bosses whose attacks are marked on the ground before they land. The arena seals once a boss fight begins.'),
            h('div', null, h('div', { class: 'label' }, 'AI companions fill empty roles'), this.fillEl),
            this.queueBtn,
            this.queueEl,
            this.queueHint,
          ),
        ),
      ),
      this.modalHost,
    );
    this.timer = window.setInterval(() => this.tickTimers(), 250);
  }

  destroy(): void {
    clearInterval(this.timer);
  }

  setStatus(online: boolean): void {
    clear(this.statusEl, h('span', { class: `status-dot${online ? '' : ' off'}` }), online ? 'Connected' : 'Reconnecting…');
  }

  addChat(from: string, text: string): void {
    const line = from === 'System' ? h('div', { class: 'sys' }, text) : h('div', null, h('span', { class: 'from' }, `${from}: `), text);
    this.chatLines.appendChild(line);
    this.chatLines.scrollTop = this.chatLines.scrollHeight;
  }

  private copyCode(): void {
    const code = this.state?.party.code;
    if (!code) return;
    navigator.clipboard?.writeText(code).then(
      () => toast(`Party code ${code} copied.`),
      () => toast(`Your party code is ${code}.`),
    );
  }

  private pickRole(role: RoleId): void {
    if (!this.state) return;
    const current = this.state.you;
    if (current.role === role) return;
    this.net.send({ t: 'loadout', role, weapon: ROLES[role].weapons[0] as string });
  }

  private renderFill(): void {
    clear(
      this.fillEl,
      FILL_OPTIONS.map((o) => h('button', { class: o.value === this.aiFill ? 'selected' : '', onclick: () => ((this.aiFill = o.value), this.renderFill()), disabled: !!this.state?.queue }, o.label)),
    );
  }

  update(state: LobbyState): void {
    this.state = state;
    this.clockOffset = state.now - Date.now();
    clear(this.onlineEl, `${state.online} online`);
    this.rejoinBtn.style.display = state.instanceId ? '' : 'none';

    // Character.
    for (const card of this.rolesEl.children) card.classList.toggle('selected', (card as HTMLElement).dataset.role === state.you.role);
    const role = ROLES[state.you.role];
    this.roleDescEl.textContent = role.description;
    if (this.lastRoleRendered !== state.you.role || this.lastWeaponRendered !== state.you.weapon) {
      this.lastRoleRendered = state.you.role;
      this.lastWeaponRendered = state.you.weapon;
      clear(
        this.weaponsEl,
        role.weapons.map((wid) => {
          const w = WEAPONS[wid];
          if (!w) return null;
          return h(
            'button',
            { class: `weapon-card${wid === state.you.weapon ? ' selected' : ''}`, onclick: () => this.net.send({ t: 'loadout', role: state.you.role, weapon: wid }) },
            h('span', { class: 'wname' }, w.name, w.healer ? h('span', { class: 'healer-tag' }, 'HEALER') : null),
            h('span', { class: 'wstyle' }, w.style),
            h('span', { class: 'wdesc' }, w.description),
          );
        }),
      );
      const weapon = WEAPONS[state.you.weapon];
      clear(
        this.skillsEl,
        [...(weapon?.skills ?? []), ...role.roleSkills].map((sid) => {
          const row = h('div', { class: 'skill-row' }, h('img', { src: skillIcon(sid), alt: '' }), h('div', null, h('div', { class: 'sname' }, SKILLS[sid]?.name ?? sid), h('div', { class: 'skind' }, weapon?.skills.includes(sid) ? weapon.style : 'Role skill')));
          return withTooltip(row, () => skillTooltip(sid));
        }),
      );
    }

    // Party.
    this.codeEl.textContent = state.party.code;
    const youLead = state.party.leaderId === state.you.id;
    const slots: HTMLElement[] = [];
    for (const m of state.party.members) {
      const icon = h('span');
      icon.innerHTML = roleIcon(m.role, 28);
      slots.push(
        h(
          'div',
          { class: 'party-slot' },
          icon,
          h('div', null, h('div', { class: 'pname' }, m.name, m.leader ? h('span', { class: 'leader-crown', title: 'Party leader' }, '♛') : null, m.playerId === state.you.id ? h('span', { class: 'muted small' }, ' (you)') : null), h('div', { class: 'pmeta' }, `${ROLES[m.role].name} · ${WEAPONS[m.weapon]?.name ?? ''}${m.online ? '' : ' · offline'}`)),
          youLead && m.playerId !== state.you.id ? h('button', { class: 'btn ghost small', onclick: () => this.net.send({ t: 'party.kick', playerId: m.playerId }) }, 'Remove') : h('span'),
        ),
      );
    }
    for (let i = state.party.members.length; i < 4; i++) slots.push(h('div', { class: 'party-slot empty' }, h('span'), h('div', null, 'Open slot', h('div', { class: 'pmeta' }, 'Share your code, or let AI fill it')), h('span')));
    clear(this.slotsEl, slots);
    this.leaveBtn.style.display = state.party.members.length > 1 ? '' : 'none';

    // Queue.
    this.renderFill();
    const roles = state.party.members.map((m) => m.role);
    const dupes = new Set(roles).size !== roles.length;
    this.queueBtn.textContent = state.queue ? 'Withdraw' : 'Join Queue';
    this.queueBtn.className = state.queue ? 'btn danger' : 'btn primary';
    this.queueBtn.disabled = !state.queue && (!youLead || dupes || !!state.instanceId);
    this.queueHint.textContent = state.instanceId
      ? 'You are in a dungeon.'
      : !youLead
        ? 'Your party leader starts the queue.'
        : dupes
          ? 'Each party member needs a different role.'
          : state.queue
            ? 'Searching for heroes to fill the other roles…'
            : state.party.members.length === 4
              ? 'Your party is complete. Set out!'
              : 'Pick “Now” to set out at once with AI companions, or wait to be matched with other players.';
    this.renderQueue();

    // Ready check.
    this.renderReady();
  }

  private renderQueue(): void {
    const q = this.state?.queue;
    if (!q) return clear(this.queueEl);
    const lights = ROLE_ORDER.map((r) => {
      const on = q.filledRoles.includes(r);
      const el = h('div', { class: `role-light${on ? ' on' : ''}`, style: `--rc:${ROLES[r].color}` });
      el.innerHTML = roleIcon(r, 18, on ? undefined : '#555c6b');
      el.append(h('span', null, ROLES[r].name), h('span', null, on ? '✓' : `${q.queuedByRole[r]} queued`));
      return el;
    });
    clear(
      this.queueEl,
      h(
        'div',
        { class: 'queue-status' },
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('span', { class: 'label', style: 'margin:0' }, 'In queue'), h('span', { class: 'qtime', 'data-since': String(q.since) }, '0:00')),
        h('div', { class: 'role-lights' }, lights),
        h('div', { class: 'hint', 'data-fill': String(q.aiFill) }, q.aiFill === null ? 'Waiting for players only.' : 'AI companions will fill empty roles soon.'),
      ),
    );
    this.tickTimers();
  }

  private renderReady(): void {
    const rc = this.state?.readyCheck;
    if (!rc) return clear(this.modalHost);
    const me = rc.slots.find((s) => s.you);
    const answered = me?.accepted === true;
    const slots = rc.slots.map((s) => {
      const icon = h('span');
      icon.innerHTML = roleIcon(s.role, 26);
      return h(
        'div',
        { class: `ready-slot${s.accepted === true ? ' ok' : s.accepted === false ? ' no' : ''}` },
        icon,
        h('div', null, h('b', null, s.name), s.bot ? h('div', null, h('span', { class: 'ai-badge' }, 'AI')) : null),
        h('div', { class: 'muted' }, WEAPONS[s.weapon]?.name ?? ''),
        h('div', { class: 'mark' }, s.accepted === true ? '✔' : s.accepted === false ? '✖' : '…'),
      );
    });
    const bar = h('div', { style: 'width:100%' });
    bar.dataset.deadline = String(rc.deadline);
    clear(
      this.modalHost,
      h(
        'div',
        { class: 'modal-shade' },
        h(
          'div',
          { class: 'panel modal' },
          h('div', { class: 'panel-title' }, 'Expedition Ready', h('span', { class: 'sub ready-left' }, '')),
          h(
            'div',
            { class: 'body' },
            h('div', { class: 'ready-title' }, 'Your party has been formed'),
            h('div', { class: 'ready-dungeon' }, rc.dungeon),
            h('div', { class: 'ready-slots' }, slots),
            h('div', { class: 'ready-bar' }, bar),
            h(
              'div',
              { class: 'ready-actions' },
              h('button', { class: 'btn primary', disabled: answered, onclick: () => this.net.send({ t: 'ready', accept: true }) }, answered ? 'Waiting…' : 'Commence'),
              h('button', { class: 'btn ghost', onclick: () => this.net.send({ t: 'ready', accept: false }) }, 'Withdraw'),
            ),
          ),
        ),
      ),
    );
    this.tickTimers();
  }

  private tickTimers(): void {
    const now = Date.now() + this.clockOffset;
    const qt = this.queueEl.querySelector<HTMLElement>('.qtime');
    if (qt?.dataset.since) qt.textContent = fmtTime((now - Number(qt.dataset.since)) / 1000);
    const bar = this.modalHost.querySelector<HTMLElement>('[data-deadline]');
    if (bar) {
      const left = Math.max(0, (Number(bar.dataset.deadline) - now) / 1000);
      bar.style.width = `${(left / READY_CHECK_SECONDS) * 100}%`;
      const lbl = this.modalHost.querySelector('.ready-left');
      if (lbl) lbl.textContent = `${Math.ceil(left)}s`;
    }
  }
}
