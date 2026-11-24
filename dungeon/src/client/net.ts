/** The WebSocket connection to the game server, with automatic reconnects. */
import type { ClientMsg, ServerMsg } from '../shared/protocol.js';

const TOKEN_KEY = 'lumenfall.token';
const NAME_KEY = 'lumenfall.name';

function store(key: string, value?: string): string | null {
  try {
    if (value !== undefined) localStorage.setItem(key, value);
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const savedName = (): string => store(NAME_KEY) ?? '';

export type NetStatus = 'connecting' | 'online' | 'offline';

export class Net {
  private ws: WebSocket | null = null;
  private listeners: ((msg: ServerMsg) => void)[] = [];
  private statusListeners: ((s: NetStatus) => void)[] = [];
  private name = '';
  private retry = 0;
  private closedByUs = false;
  playerId: string | null = null;

  onMessage(fn: (msg: ServerMsg) => void): void {
    this.listeners.push(fn);
  }

  onStatus(fn: (s: NetStatus) => void): void {
    this.statusListeners.push(fn);
  }

  connect(name: string): void {
    this.name = name;
    store(NAME_KEY, name);
    this.open();
  }

  private open(): void {
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('online');
      this.send({ t: 'hello', name: this.name, token: store(TOKEN_KEY) ?? undefined });
    };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'welcome') {
        store(TOKEN_KEY, msg.token);
        this.playerId = msg.playerId;
      }
      for (const fn of this.listeners) fn(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus('offline');
      if (this.closedByUs) return;
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => this.open(), delay);
    };
  }

  private setStatus(s: NetStatus): void {
    for (const fn of this.statusListeners) fn(s);
  }

  send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}
