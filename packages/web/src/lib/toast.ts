import { create } from 'zustand';

export type ToastTone = 'info' | 'ok' | 'err' | 'warn';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  body?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (toast: Omit<Toast, 'id'>, ttlMs?: number) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push: (toast, ttlMs) => {
    const id = nextId++;
    set({ toasts: [...get().toasts.slice(-3), { ...toast, id }] });
    const ttl = ttlMs ?? (toast.tone === 'err' ? 9000 : 4500);
    setTimeout(() => get().dismiss(id), ttl);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  info: (title: string, body?: string) => useToasts.getState().push({ tone: 'info', title, body }),
  ok: (title: string, body?: string) => useToasts.getState().push({ tone: 'ok', title, body }),
  warn: (title: string, body?: string) => useToasts.getState().push({ tone: 'warn', title, body }),
  err: (title: string, body?: string) => useToasts.getState().push({ tone: 'err', title, body }),
};
