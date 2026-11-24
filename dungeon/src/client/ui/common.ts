/** Shared UI pieces: the animated backdrop, tooltips and skill descriptions. */
import { SKILLS } from '../../shared/content/classes.js';
import { h } from '../dom.js';

/** Drifting motes of light behind the title and lobby screens. */
export function createBackdrop(): { el: HTMLCanvasElement; stop: () => void } {
  const el = h('canvas', { class: 'backdrop' });
  const g = el.getContext('2d') as CanvasRenderingContext2D;
  const motes = Array.from({ length: 90 }, () => ({ x: Math.random(), y: Math.random(), r: 0.5 + Math.random() * 2.2, s: 0.004 + Math.random() * 0.012, p: Math.random() * Math.PI * 2 }));
  let raf = 0;
  let last = performance.now();
  const draw = (now: number): void => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const w = (el.width = el.clientWidth * devicePixelRatio);
    const hgt = (el.height = el.clientHeight * devicePixelRatio);
    const bg = g.createRadialGradient(w * 0.5, hgt * 0.42, 0, w * 0.5, hgt * 0.5, Math.max(w, hgt) * 0.75);
    bg.addColorStop(0, '#16203a');
    bg.addColorStop(0.5, '#0a0f1d');
    bg.addColorStop(1, '#030409');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, hgt);
    // A slow rune circle.
    const t = now / 1000;
    g.save();
    g.translate(w * 0.5, hgt * 0.42);
    g.rotate(t * 0.03);
    g.strokeStyle = 'rgba(236, 211, 145, 0.07)';
    g.lineWidth = 1.5 * devicePixelRatio;
    const R = Math.min(w, hgt) * 0.34;
    for (const k of [1, 0.82, 0.64]) {
      g.beginPath();
      g.arc(0, 0, R * k, 0, Math.PI * 2);
      g.stroke();
    }
    for (let i = 0; i < 12; i++) {
      g.rotate(Math.PI / 6);
      g.beginPath();
      g.moveTo(R * 0.64, 0);
      g.lineTo(R, 0);
      g.stroke();
    }
    g.restore();
    for (const m of motes) {
      m.y -= m.s * dt * 6;
      m.x += Math.sin(t * 0.5 + m.p) * 0.0004;
      if (m.y < -0.02) {
        m.y = 1.02;
        m.x = Math.random();
      }
      const a = 0.35 + 0.35 * Math.sin(t * 1.5 + m.p);
      const x = m.x * w;
      const y = m.y * hgt;
      const rr = m.r * devicePixelRatio * 4;
      const glow = g.createRadialGradient(x, y, 0, x, y, rr);
      glow.addColorStop(0, `rgba(255, 228, 160, ${a})`);
      glow.addColorStop(1, 'rgba(255, 228, 160, 0)');
      g.fillStyle = glow;
      g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
    }
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return { el, stop: () => cancelAnimationFrame(raf) };
}

let tip: HTMLElement | null = null;

export function showTooltip(x: number, y: number, content: Node): void {
  if (!tip) {
    tip = h('div', { class: 'tooltip' });
    document.body.appendChild(tip);
  }
  tip.replaceChildren(content);
  tip.style.display = 'block';
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, x + 14)}px`;
  tip.style.top = `${Math.max(8, Math.min(window.innerHeight - r.height - 8, y - r.height - 10))}px`;
}

export function hideTooltip(): void {
  if (tip) tip.style.display = 'none';
}

export function withTooltip<T extends HTMLElement>(el: T, content: () => Node): T {
  el.addEventListener('mousemove', (e) => showTooltip(e.clientX, e.clientY, content()));
  el.addEventListener('mouseleave', hideTooltip);
  return el;
}

export function skillTooltip(id: string): Node {
  const s = SKILLS[id];
  if (!s) return h('div', null, id);
  const kind = s.kind === 'weaponskill' ? 'Weaponskill' : s.kind === 'spell' ? 'Spell' : 'Ability';
  const bits = [kind, s.cast > 0 ? `Cast ${s.cast}s` : 'Instant', s.recast > 0 ? `Recast ${s.recast}s` : s.kind === 'ability' ? '' : 'Global cooldown', s.mp ? `${s.mp} MP` : '', s.range > 0 ? `Range ${s.range}` : ''].filter(Boolean);
  return h('div', null, h('div', { class: 'tt-name' }, s.name), h('div', { class: 'tt-meta' }, bits.join(' · ')), h('div', null, s.description));
}
