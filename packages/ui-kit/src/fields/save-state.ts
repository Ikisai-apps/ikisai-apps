/**
 * Estado de guardado por campo y global (portales Organizers y Guests): «Guardando…», «Guardado», «Pendiente» (sin red:
 * se guardará al volver la conexión) y «No se guardó · Reintentar». Reutilizable por cualquier app.
 *
 *   const saves = createSaveState();
 *   header.append(saves.element);                       // resumen global
 *   field.append(saves.field('nombre').element);         // junto al campo
 *   await saves.track('nombre', api.save(...), { retry: () => api.save(...) });
 *
 * `track` decide solo: éxito → guardado; error de red (o sin conexión) → pendiente; otro error → error con reintento.
 * Las apps con cola sin red (sync-client) pueden marcar «pendiente» a mano con `set(key, 'pending')`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon } from '../icons.ts';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'pending' | 'error';

export interface SaveField {
  element: HTMLElement;
  status(): SaveStatus;
  set(status: SaveStatus, message?: string): void;
}

export interface SaveState {
  /** Resumen global: lo más grave de todos los campos (error > guardando > pendiente > guardado). */
  element: HTMLElement;
  field(key: string): SaveField;
  set(key: string, status: SaveStatus, message?: string): void;
  /** Sigue una promesa de guardado; con `retry`, el error ofrece «Reintentar». */
  track<T>(key: string, work: Promise<T>, options?: { retry?: () => Promise<unknown> }): Promise<T>;
  status(): SaveStatus;
  onChange(listener: (status: SaveStatus) => void): () => void;
}

export interface SaveStateOptions {
  /** Cuánto se ve «Guardado» antes de desaparecer (ms); por defecto 2500. 0 = no desaparece. */
  savedMs?: number;
  /** ¿Es un error de red? Por defecto: `code` `NETWORK`/`OFFLINE`, `TypeError` de `fetch` o `navigator.onLine === false`. */
  isNetworkError?: (error: unknown) => boolean;
}

const ORDER: SaveStatus[] = ['error', 'saving', 'pending', 'saved', 'idle'];

function defaultIsNetwork(error: unknown): boolean {
  const e = error as { code?: string; name?: string; status?: number } | null;
  return navigator.onLine === false || e?.code === 'NETWORK' || e?.code === 'OFFLINE' || e?.name === 'TypeError' || e?.status === 0;
}

function texts(status: SaveStatus): { text: string; icon: string | null } {
  switch (status) {
    case 'saving': return { text: kt('Guardando…'), icon: 'sync' };
    case 'saved': return { text: kt('Guardado'), icon: 'check' };
    case 'pending': return { text: kt('Pendiente: se guardará con conexión'), icon: 'offline' };
    case 'error': return { text: kt('No se guardó'), icon: 'warn' };
    default: return { text: '', icon: null };
  }
}

export function createSaveState(options: SaveStateOptions = {}): SaveState {
  const savedMs = options.savedMs ?? 2500;
  const isNetwork = options.isNetworkError ?? defaultIsNetwork;
  const fields = new Map<string, SaveField & { retry?: () => Promise<unknown> }>();
  const listeners = new Set<(status: SaveStatus) => void>();
  const element = el('span', { class: 'save-state save-global', role: 'status', 'aria-live': 'polite', dataset: { status: 'idle' } });

  function global(): SaveStatus {
    const all = [...fields.values()].map((f) => f.status());
    return ORDER.find((s) => all.includes(s)) ?? 'idle';
  }
  function paintGlobal(): void {
    const status = global();
    element.dataset.status = status;
    const t = status === 'error' ? kt('Hay cambios sin guardar') : texts(status).text;
    replace(element, texts(status).icon ? icon(texts(status).icon!, 14) : null, t ? el('span', null, t) : null);
    for (const l of listeners) l(status);
  }

  function field(key: string): SaveField & { retry?: () => Promise<unknown> } {
    const existing = fields.get(key);
    if (existing) return existing;
    let status: SaveStatus = 'idle';
    let timer: ReturnType<typeof setTimeout> | null = null;
    const node = el('span', { class: 'save-state', role: 'status', 'aria-live': 'polite', dataset: { status, field: key } });
    const f: SaveField & { retry?: () => Promise<unknown> } = {
      element: node,
      status: () => status,
      set(next, message) {
        status = next;
        if (timer) { clearTimeout(timer); timer = null; }
        node.dataset.status = next;
        const t = texts(next);
        const retry = next === 'error' && f.retry
          ? el('button', { type: 'button', class: 'linkbtn save-retry', onclick: () => { const r = f.retry!; void track(key, r(), { retry: r }).catch(() => null); } }, kt('Reintentar'))
          : null;
        replace(node, t.icon ? icon(t.icon, 14) : null, t.text ? el('span', null, message ?? t.text) : null, retry);
        if (next === 'saved' && savedMs) timer = setTimeout(() => f.set('idle'), savedMs);
        paintGlobal();
      },
    };
    fields.set(key, f);
    return f;
  }

  async function track<T>(key: string, work: Promise<T>, opts?: { retry?: () => Promise<unknown> }): Promise<T> {
    const f = field(key);
    if (opts?.retry) f.retry = opts.retry;
    f.set('saving');
    try {
      const value = await work;
      f.set('saved');
      return value;
    } catch (error) {
      f.set(isNetwork(error) ? 'pending' : 'error');
      throw error;
    }
  }

  paintGlobal();
  return {
    element,
    field,
    set: (key, status, message) => field(key).set(status, message),
    track,
    status: global,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
}
