import { createStore } from './store';

export interface ToastItem {
  id: number;
  kind: 'ok' | 'error' | 'warn';
  text: string;
}

export const toasts = createStore<ToastItem[]>([]);
let seq = 0;

function push(kind: ToastItem['kind'], text: string, ms: number): void {
  const id = ++seq;
  toasts.set(list => [...list.slice(-3), { id, kind, text }]);
  setTimeout(() => dismiss(id), ms);
}

export const dismiss = (id: number): void => toasts.set(list => list.filter(t => t.id !== id));
export const toast = {
  ok: (text: string): void => push('ok', text, 4000),
  /** Worked, but there is something to read afterwards. */
  warn: (text: string): void => push('warn', text, 9000),
  error: (text: string): void => push('error', text, 9000),
};
