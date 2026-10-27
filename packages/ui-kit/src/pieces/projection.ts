/**
 * Proyección (encargo de Core del 27-10 para el catálogo de piezas de Flow; diseño en
 * `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`). Es un carril que pinta las filas leídas de otra app y tiene una acción
 * por fila que invoca una capacidad del catálogo. Con ella, «Trabajos de hoy», «Recepción» o «Avance por aplicaciones» se
 * componen sin pantallas hechas a mano. **No copia datos**: la verdad vive en la app dueña.
 * - Lectura: `read` invoca una capacidad (`POST capabilities/<id>/invoke` con el cliente de la app y el token de la persona),
 *   y `rows(result)` la convierte en filas. Se vuelve a leer cada `refreshMs`, al volver a la pestaña y tras cada acción.
 * - Acción: idempotente (`requestId` estable por fila y acción). Mientras dura, la fila dice «Haciendo…». Al acabar **no se
 *   marca como hecha en local**: se vuelve a leer y manda lo que diga la app dueña. Los errores se dicen en palabras.
 * - Sin red: la última lectura con «Sin conexión: puede no estar al día» y sin acciones. Nada queda en cola fingiendo éxito.
 * - `onCount(n)` es para el recuento del carril (`createLanes`).
 * Prefijo de clases: `proj-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { confirmDialog } from '../overlay/dialog.ts';

export interface ProjectionClient {
  api<T = unknown>(path: string, init?: { method?: string; json?: unknown }): Promise<T>;
}

export interface ProjectionRow {
  id: string;
  title: string;
  meta?: string | string[] | null;
  chip?: string | { text: string; tone?: 'ok' | 'warn' | 'bad' | 'info' } | null;
  /** Enlace a la ficha en la app dueña (`https://…ikisai.com/…` o ruta interna). */
  href?: string | null;
  /** Lo que haga falta para la acción (`input(row)`) o `when(row)`; no se pinta. */
  data?: Record<string, unknown>;
}

export interface ProjectionAction {
  label: string | ((row: ProjectionRow) => string);
  capability: string;
  input: (row: ProjectionRow) => Record<string, unknown>;
  /** Solo en las filas que cumplan esto. */
  when?: (row: ProjectionRow) => boolean;
  /** Confirmar antes (cobros, acciones críticas): `true` o el texto de la pregunta. */
  confirm?: boolean | ((row: ProjectionRow) => string);
}

export interface ProjectionOptions {
  label: string;
  client: ProjectionClient;
  read: { capability: string; input?: () => Record<string, unknown> };
  rows: (result: unknown) => ProjectionRow[];
  action?: ProjectionAction | null;
  /** Nombre de la app dueña para los mensajes («Booking»). */
  appName?: string;
  /** Cada cuánto se vuelve a leer; 0, nunca. Por defecto, 30 s. */
  refreshMs?: number;
  empty?: string;
  onCount?: (n: number) => void;
  /** ¿Hay red? Por defecto, `navigator.onLine`. */
  isOnline?: () => boolean;
  feedbackId?: string;
}

export interface Projection {
  element: HTMLElement;
  refresh(): Promise<void>;
  rows(): ProjectionRow[];
  destroy(): void;
}

const CAPABILITY = /^[a-z]+\.[a-z0-9_]+$/;
const ROW_ID = /^[A-Za-z0-9_.:-]{1,80}$/;

/** Enlace seguro: `https:` de `*.ikisai.com` o ruta interna. */
function safeHref(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const h = href.trim();
  if (/^(#\/|\/(?!\/))\S*$/.test(h)) return h;
  try { const u = new URL(h); return u.protocol === 'https:' && (u.hostname === 'ikisai.com' || u.hostname.endsWith('.ikisai.com')) ? h : null; } catch { return null; }
}

export function createProjection(options: ProjectionOptions): Projection {
  if (!CAPABILITY.test(options.read.capability)) throw new Error(`createProjection: capacidad no válida «${options.read.capability}»`);
  if (options.action && !CAPABILITY.test(options.action.capability)) throw new Error(`createProjection: capacidad no válida «${options.action.capability}»`);
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const online = options.isOnline ?? (() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  const app = options.appName ?? kt('la otra app');
  let rows: ProjectionRow[] = [];
  let loaded = false;
  let destroyed = false;
  const busy = new Set<string>();
  const errors = new Map<string, string>();
  let readError: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const status = el('p', { class: 'proj-status', role: 'status', 'aria-live': 'polite' });
  const list = el('ul', { class: 'proj-list' });
  const element = el('section', { class: 'proj-box', 'aria-label': options.label, 'aria-busy': 'true', ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) }, status, list);

  const invoke = <T>(capability: string, json: Record<string, unknown>) =>
    options.client.api<{ result: T }>(`/capabilities/${capability}/invoke`, { method: 'POST', json }).then((o) => o.result);

  function messageOf(error: unknown): string {
    const e = error as { code?: string; status?: number; message?: string } | null;
    if (e?.code === 'NEEDS_ACCESS' || e?.status === 403) return kt('Tu cuenta no puede hacer esto en {app}.', { app });
    if (e?.code === 'APP_UNAVAILABLE' || e?.status === 503) return kt('{app} no responde ahora mismo. Prueba en un rato.', { app });
    if (e instanceof TypeError || e?.code === 'NETWORK') return kt('Sin conexión: no se ha hecho.');
    return typeof e?.message === 'string' && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : kt('{app} no lo ha aceptado.', { app });
  }

  function clean(raw: ProjectionRow[]): ProjectionRow[] {
    const seen = new Set<string>();
    const out: ProjectionRow[] = [];
    for (const r of Array.isArray(raw) ? raw.slice(0, 300) : []) {
      if (!r || typeof r.id !== 'string' || !ROW_ID.test(r.id) || seen.has(r.id) || typeof r.title !== 'string' || !r.title.trim()) continue;
      seen.add(r.id);
      out.push({ ...r, title: r.title.trim().slice(0, 200), href: safeHref(r.href) });
    }
    return out;
  }

  function paint(): void {
    const isOnline = online();
    element.setAttribute('aria-busy', loaded ? 'false' : 'true');
    status.textContent = !loaded ? kt('Cargando…') : readError ? readError : !isOnline ? kt('Sin conexión: puede no estar al día.') : '';
    element.dataset.state = !loaded ? 'loading' : readError ? 'error' : !isOnline ? 'offline' : 'ok';
    if (loaded && !rows.length) {
      replace(list, el('li', { class: 'proj-empty' }, readError ? '' : options.empty ?? kt('Nada por ahora.')));
      return;
    }
    replace(list, ...rows.map((row) => {
      const meta = Array.isArray(row.meta) ? row.meta.filter(Boolean).join(' · ') : row.meta ?? '';
      const chip = typeof row.chip === 'string' ? { text: row.chip } : row.chip ?? null;
      const action = options.action && (!options.action.when || options.action.when(row)) ? options.action : null;
      const label = action ? (typeof action.label === 'function' ? action.label(row) : action.label) : '';
      const doing = busy.has(row.id);
      const err = errors.get(row.id);
      return el('li', { class: 'proj-row', dataset: { row: row.id, busy: String(doing) } },
        el('div', { class: 'proj-main' },
          row.href ? el('a', { class: 'proj-title', href: row.href, ...mark('abrir', 'Abrir en la app') }, row.title) : el('span', { class: 'proj-title' }, row.title),
          meta ? el('span', { class: 'proj-meta' }, meta) : null,
          err ? el('span', { class: 'fielderror proj-error', role: 'alert' }, err) : null),
        chip ? el('span', { class: `chip proj-chip${chip.tone ? ` ${chip.tone}` : ''}` }, chip.text) : null,
        action ? el('button', { type: 'button', class: 'ghost small proj-action', disabled: doing || !isOnline, 'aria-label': `${label}: ${row.title}`, ...mark('accion', 'Acción de la fila'),
          onclick: () => void act(row, action) }, doing ? kt('Haciendo…') : label) : null);
    }));
  }

  async function load(): Promise<void> {
    try {
      const result = await invoke<unknown>(options.read.capability, options.read.input?.() ?? {});
      if (destroyed) return;
      rows = clean(options.rows(result));
      readError = null;
    } catch (e) {
      if (destroyed) return;
      // Sin red se queda la última lectura; otro fallo se dice.
      readError = online() && !(e instanceof TypeError) ? messageOf(e) : null;
    }
    loaded = true;
    // Los errores de acción de filas que ya no están, fuera.
    for (const id of [...errors.keys()]) if (!rows.some((r) => r.id === id)) errors.delete(id);
    paint();
    options.onCount?.(rows.length);
  }

  async function act(row: ProjectionRow, action: ProjectionAction): Promise<void> {
    if (busy.has(row.id) || !online()) return;
    if (action.confirm) {
      const label = typeof action.label === 'function' ? action.label(row) : action.label;
      const ok = await confirmDialog({ title: typeof action.confirm === 'function' ? action.confirm(row) : kt('¿{action}: {title}?', { action: label, title: row.title }), confirmLabel: label, cancelLabel: kt('Cancelar') });
      if (!ok) return;
    }
    busy.add(row.id);
    errors.delete(row.id);
    paint();
    try {
      await invoke(action.capability, { requestId: `proj:${action.capability}:${row.id}`, ...action.input(row) });
    } catch (e) {
      errors.set(row.id, messageOf(e));
    }
    busy.delete(row.id);
    // Manda lo que diga la app dueña: se vuelve a leer.
    await load();
    list.querySelector<HTMLElement>(`.proj-row[data-row="${CSS.escape(row.id)}"] .proj-action, .proj-row[data-row="${CSS.escape(row.id)}"] .proj-title`)?.focus({ preventScroll: true });
  }

  const onVisible = () => { if (document.visibilityState === 'visible') void load(); };
  const onNet = () => { paint(); if (online()) void load(); };
  document.addEventListener('visibilitychange', onVisible);
  addEventListener('online', onNet);
  addEventListener('offline', onNet);
  if ((options.refreshMs ?? 30_000) > 0) timer = setInterval(() => { if (document.visibilityState !== 'hidden') void load(); }, options.refreshMs ?? 30_000);
  paint();
  void load();

  return {
    element,
    refresh: load,
    rows: () => rows.slice(),
    destroy() {
      destroyed = true;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      removeEventListener('online', onNet);
      removeEventListener('offline', onNet);
    },
  };
}
