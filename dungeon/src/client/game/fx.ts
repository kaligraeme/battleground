/** Short-lived visual effects and floating combat text, all in world coordinates. */

export interface Fx {
  kind: 'proj' | 'slash' | 'burst' | 'heal' | 'buff' | 'dash' | 'rift' | 'impact' | 'shout' | 'spark';
  x: number;
  y: number;
  /** Destination or second point. */
  x2: number;
  y2: number;
  /** Entity to follow (heal/buff sparkles). */
  follow: number | null;
  hue: number;
  r: number;
  born: number;
  life: number;
  seed: number;
}

export interface FlyText {
  text: string;
  x: number;
  y: number;
  color: string;
  size: number;
  born: number;
  life: number;
  dx: number;
}

export class Effects {
  fx: Fx[] = [];
  texts: FlyText[] = [];

  add(f: Omit<Fx, 'born' | 'seed'> & { born?: number }): void {
    this.fx.push({ ...f, born: f.born ?? performance.now() / 1000, seed: Math.random() * 1000 });
    if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
  }

  text(text: string, x: number, y: number, color: string, size = 14): void {
    // Spread simultaneous numbers on the same spot so they stay readable.
    const now = performance.now() / 1000;
    const crowd = this.texts.filter((t) => now - t.born < 0.35 && Math.hypot(t.x - x, t.y - y) < 1).length;
    this.texts.push({ text, x, y, color, size, born: now, life: 1.25, dx: (crowd % 2 ? 1 : -1) * Math.min(crowd, 4) * 0.35 });
    if (this.texts.length > 120) this.texts.shift();
  }

  prune(now: number): void {
    this.fx = this.fx.filter((f) => now - f.born < f.life);
    this.texts = this.texts.filter((t) => now - t.born < t.life);
  }
}
