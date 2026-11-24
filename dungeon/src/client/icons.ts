/** Role emblems (SVG) and generated skill and status icons. */
import { ROLES, SKILLS, type RoleId } from '../shared/content/classes.js';
import { STATUSES } from '../shared/content/statuses.js';

const ROLE_PATHS: Record<RoleId, string> = {
  tank: '<path d="M12 2.5 19.5 5.2V11c0 5-3.2 8.8-7.5 10.5C7.7 19.8 4.5 16 4.5 11V5.2Z" fill="currentColor"/><path d="M12 6v12M8 10h8" stroke="rgba(0,0,0,.45)" stroke-width="1.6" fill="none"/>',
  mage: '<path d="M12 2 14.2 9.8 22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2Z" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="rgba(0,0,0,.4)"/>',
  ranger: '<path d="M7 2.5c9 3 9 16 0 19" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M7 2.5v19" stroke="currentColor" stroke-width="1" opacity=".7"/><path d="M3 12h16m-4-4 4 4-4 4" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  melee: '<path d="M4.5 3.5 15 14M19.5 3.5 9 14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><path d="M12.5 16.5l4 4M11.5 16.5l-4 4M14 12.5l3.5-1.2M10 12.5l-3.5-1.2" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
};

/** An inline SVG emblem for a role, coloured with the role colour unless told otherwise. */
export function roleIcon(role: RoleId, size = 20, color?: string): string {
  return `<svg class="role-icon" width="${size}" height="${size}" viewBox="0 0 24 24" style="color:${color ?? ROLES[role].color}" aria-label="${ROLES[role].name}">${ROLE_PATHS[role]}</svg>`;
}

const cache = new Map<string, string>();

function glyphIcon(key: string, glyph: string, hue: number, frame: string, size = 64): string {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  if (!g) return '';
  const r = size * 0.16;
  const path = new Path2D();
  path.roundRect(2, 2, size - 4, size - 4, r);
  const grad = g.createRadialGradient(size * 0.35, size * 0.3, 2, size / 2, size / 2, size * 0.75);
  grad.addColorStop(0, `hsl(${hue} 70% 58%)`);
  grad.addColorStop(0.55, `hsl(${hue} 62% 32%)`);
  grad.addColorStop(1, `hsl(${hue} 70% 12%)`);
  g.fillStyle = grad;
  g.fill(path);
  // Sheen.
  const sheen = g.createLinearGradient(0, 0, 0, size);
  sheen.addColorStop(0, 'rgba(255,255,255,.28)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0)');
  g.fillStyle = sheen;
  g.fill(path);
  g.lineWidth = 3;
  g.strokeStyle = frame;
  g.stroke(path);
  g.font = `700 ${Math.round(size * 0.5)}px "Segoe UI Symbol", "Noto Sans Symbols 2", "Noto Sans Symbols", "DejaVu Sans", sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = `hsl(${hue} 100% 70%)`;
  g.shadowBlur = 10;
  g.fillStyle = '#fff8e6';
  g.fillText(glyph, size / 2, size / 2 + size * 0.03);
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

export function skillIcon(id: string): string {
  const s = SKILLS[id];
  if (!s) return '';
  const frame = s.kind === 'ability' ? 'rgba(160, 200, 255, .9)' : s.kind === 'spell' ? 'rgba(230, 180, 255, .9)' : 'rgba(240, 210, 140, .95)';
  return glyphIcon(`skill:${id}`, s.glyph, s.hue, frame);
}

export function statusIcon(id: string): string {
  const s = STATUSES[id];
  if (!s) return '';
  const hue = hueOf(s.color);
  return glyphIcon(`status:${id}`, s.glyph, hue, s.debuff ? 'rgba(255,110,110,.95)' : 'rgba(255,230,160,.95)', 40);
}

function hueOf(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return 40;
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x as string, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 40;
  const d = max - min;
  let hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue *= 60;
  return Math.round(hue);
}
