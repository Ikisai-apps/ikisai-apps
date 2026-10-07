/**
 * Uso semántico de funcionalidades (USO.md §2–§3; API de Core en RESPUESTAS 7-10-2026 §7). Mide por función
 * (`data-feedback-id`), nunca contenido:
 * - **Exposición:** el elemento marcado está visible al menos al 50 % durante 1 s (`IntersectionObserver`), sin contar
 *   ocultos ni lo que está dentro de un menú o `<details>` cerrado. Una por función y sesión.
 * - **Activación:** clic o Intro/Espacio sobre un control marcado (botón, enlace, pestaña, campo…). No cuenta lo que hay
 *   dentro de `data-feedback-ignore` ni la propia capa de feedback. Volver a activar lo mismo antes de 2 s cuenta como
 *   intento repetido.
 * - **Éxito y error:** `usage.run('booking.reserva.guardar', async () => …)` en las 5–10 operaciones importantes.
 * - **Contexto** `production | qa | reviewer` según los interruptores del kit (el revisor manda).
 * Guarda **totales acumulados del día por dispositivo** en IndexedDB y los manda a `POST usage/batch` (el servidor se
 * queda con el máximo: un reintento no cuenta dos veces) al volver la red, al pasar a segundo plano y cada pocos minutos.
 * Nunca bloquea ni lanza: si algo falla, se reintenta más tarde. `clear(userId)` al cerrar sesión (`onSessionEnd`).
 */
import type { FeedbackApi } from '../feedback/client.ts';
import { rawRoute } from '../feedback/context.ts';
import { showUsageNotice } from './notice.ts';

export type UsageContext = 'production' | 'qa' | 'reviewer';

export interface UsageTotals {
  exposures: number; activations: number; successes: number; errors: number;
  sessionsExposed: number; sessionsActivated: number; sessionsSucceeded: number; repeatedAttempts: number;
}

export interface UsageItem extends UsageTotals {
  day: string; featureId: string; generation: number; context: UsageContext;
  /** Ruta real (sin consulta) donde se vio o usó por última vez: el revisor la usa para «Ir al sitio» (#238). */
  route?: string;
}

interface UsageRecord extends UsageItem { key: string; userId: string; app: string; dirty: boolean }

export interface UsageOptions {
  app: string;
  /** `client.api` de `sync-client` (rutas relativas a `/api/v1`). */
  api: FeedbackApi;
  userId: () => string | null;
  /** Por defecto: `reviewer` con el modo revisor encendido, `qa` con «Señalar para comentar», si no `production`. */
  context?: () => UsageContext;
  /** Generación de la función, si la app la conoce (por defecto 1; el servidor la corrige con su catálogo). */
  generation?: (featureId: string) => number;
  /** Cada cuánto se envía (ms); por defecto 3 minutos. */
  flushEveryMs?: number;
  /** Aviso al equipo la primera vez (`GET/POST usage/consent`). Por defecto `true`; los portales pasan `false`. */
  notice?: boolean;
  /** Dónde observar; por defecto `document`. */
  root?: Document | HTMLElement;
  /** Dónde montar el aviso; por defecto `document.body`. */
  container?: () => HTMLElement;
}

export interface Usage {
  /** Ejecuta una operación importante y cuenta éxito o error (relanza el error). */
  run<T>(featureId: string, fn: () => T | Promise<T>): Promise<T>;
  /** Cuenta un resultado sin envolver (p. ej. una importación que termina en otro sitio). */
  track(featureId: string, outcome?: 'success' | 'error'): void;
  /** Cuenta una activación a mano (controles que no son clicables, gestos propios). */
  activate(featureId: string): void;
  flush(): Promise<void>;
  /** Totales de hoy en este dispositivo (para depurar y para las pruebas). */
  today(): UsageItem[];
  clear(userId: string): Promise<void>;
  destroy(): void;
}

const DB_NAME = 'ikisai-usage';
const DEVICE_KEY = 'ikisai-usage-device';
const SESSION_KEY = 'ikisai-usage-session';
const EXPOSURE_MS = 1000;
const REPEAT_MS = 2000;
const MAX = 32767;
const KEEP_DAYS = 3;
const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){0,7}$/;
const CONTROL = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="option"], [role="link"], [tabindex]:not([tabindex="-1"])';
const EXCLUDED = '[data-feedback-ignore], .ikisai-fb-layer';

const ZERO: UsageTotals = { exposures: 0, activations: 0, successes: 0, errors: 0, sessionsExposed: 0, sessionsActivated: 0, sessionsSucceeded: 0, repeatedAttempts: 0 };

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('daily', { keyPath: 'key' });
      store.createIndex('user', 'userId');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((database) => new Promise((resolve, reject) => {
    const t = database.transaction('daily', mode);
    const request = work(t.objectStore('daily'));
    t.oncomplete = () => resolve(request ? request.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** Día local `AAAA-MM-DD` (el uso se agrega por día de calendario de quien trabaja). */
export function usageDay(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

let volatileDevice: string | null = null;
/** Id aleatorio (uuid) por instalación (por origen: cada app tiene el suyo). Sin almacenamiento, uno por carga. */
export function usageDeviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
    return id;
  } catch { return (volatileDevice ??= crypto.randomUUID()); }
}

function defaultContext(): UsageContext {
  const html = document.documentElement.classList;
  if (html.contains('fb-reviewing')) return 'reviewer';
  if (html.contains('fb-mode')) return 'qa';
  return 'production';
}

/** ¿Se ve de verdad? Sin `hidden`, sin `display:none`, fuera de `<details>` y menús cerrados. */
function reallyVisible(element: Element): boolean {
  if (!element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const closedDetails = element.parentElement?.closest('details:not([open])');
  if (closedDetails && !element.closest('summary')) return false;
  if (element.closest('[role="menu"][aria-expanded="false"], [aria-expanded="false"] + [role="menu"]')) return false;
  const html = element as HTMLElement;
  if (typeof html.checkVisibility === 'function') return html.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true } as CheckVisibilityOptions);
  return !!(html.offsetWidth || html.offsetHeight || html.getClientRects().length);
}

export function createUsage(options: UsageOptions): Usage {
  const root = options.root ?? document;
  const context = options.context ?? defaultContext;
  const records = new Map<string, UsageRecord>();
  let loadedFor: string | null = null;
  let loading: Promise<void> | null = null;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let flushing: Promise<void> | null = null;
  const lastActivation = new Map<string, number>();
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();

  // --- Sesión (pestaña): qué se expuso, activó o tuvo éxito ya en esta sesión --------------------------
  const session: Record<'exposed' | 'activated' | 'succeeded', Set<string>> = { exposed: new Set(), activated: new Set(), succeeded: new Set() };
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as Record<string, string[]> | null;
    if (saved) for (const k of ['exposed', 'activated', 'succeeded'] as const) for (const v of saved[k] ?? []) session[k].add(v);
  } catch { /* sin almacenamiento de sesión */ }
  const saveSession = () => { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ exposed: [...session.exposed], activated: [...session.activated], succeeded: [...session.succeeded] })); } catch { /* */ } };

  async function load(user: string): Promise<void> {
    if (loadedFor === user) return;
    loading ??= (async () => {
      records.clear();
      try {
        const all = (await tx<UsageRecord[]>('readonly', (s) => s.index('user').getAll(IDBKeyRange.only(user)) as IDBRequest<UsageRecord[]>)) ?? [];
        for (const r of all) if (r.app === options.app) records.set(r.key, r);
      } catch { /* sin IndexedDB: solo memoria */ }
      loadedFor = user;
    })().finally(() => { loading = null; });
    return loading;
  }

  function scheduleSave(): void {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; void save(); }, 400);
  }
  async function save(): Promise<void> {
    const list = [...records.values()];
    try { await tx('readwrite', (s) => { for (const r of list) s.put(r); }); } catch { /* reintento en el próximo cambio */ }
  }

  /** Suma en el total de hoy (día, función, contexto) de la cuenta actual. */
  function bump(featureId: string, change: Partial<UsageTotals>): void {
    const user = options.userId();
    // Solo ids de esta app (`<app>.…`): el servidor rechaza el lote entero si llega uno ajeno.
    if (!user || !ID.test(featureId) || !featureId.startsWith(`${options.app}.`)) return;
    const apply = () => {
      const day = usageDay();
      const ctx = context();
      const key = `${user}|${day}|${featureId}|${ctx}`;
      const r = records.get(key) ?? { key, userId: user, app: options.app, day, featureId, generation: options.generation?.(featureId) ?? 1, context: ctx, ...ZERO, dirty: true };
      for (const [k, v] of Object.entries(change) as [keyof UsageTotals, number][]) r[k] = Math.min(MAX, r[k] + v);
      r.route = rawRoute();
      r.dirty = true;
      records.set(key, r);
      scheduleSave();
    };
    if (loadedFor === user) apply(); else void load(user).then(apply);
  }

  // --- Exposición ------------------------------------------------------------------------------------
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const element = entry.target;
      const id = element.getAttribute('data-feedback-id');
      if (!id || session.exposed.has(id)) { io?.unobserve(element); continue; }
      if (entry.isIntersecting && entry.intersectionRatio >= 0.5) {
        if (!timers.has(element)) timers.set(element, setTimeout(() => {
          timers.delete(element);
          if (session.exposed.has(id) || !reallyVisible(element)) return;
          session.exposed.add(id); saveSession();
          bump(id, { exposures: 1, sessionsExposed: 1 });
          for (const other of document.querySelectorAll(`[data-feedback-id="${CSS.escape(id)}"]`)) io?.unobserve(other);
        }, EXPOSURE_MS));
      } else {
        const t = timers.get(element);
        if (t) { clearTimeout(t); timers.delete(element); }
      }
    }
  }, { threshold: [0, 0.5, 1] }) : null;

  const observed = new WeakSet<Element>();
  function observeTree(node: ParentNode): void {
    if (!io) return;
    const found = node instanceof Element && node.matches('[data-feedback-id]') ? [node, ...node.querySelectorAll('[data-feedback-id]')] : [...node.querySelectorAll('[data-feedback-id]')];
    for (const element of found) {
      const id = element.getAttribute('data-feedback-id');
      if (!id || observed.has(element) || session.exposed.has(id) || element.closest(EXCLUDED)) continue;
      observed.add(element);
      io.observe(element);
    }
  }
  const mo = new MutationObserver((list) => {
    for (const record of list) for (const node of record.addedNodes) if (node instanceof Element) observeTree(node);
  });

  // --- Activación ------------------------------------------------------------------------------------
  function activationTarget(target: EventTarget | null): string | null {
    if (!(target instanceof Element) || target.closest(EXCLUDED)) return null;
    const marked = target.closest('[data-feedback-id]');
    if (!marked) return null;
    // El marcado es el control, o el control está dentro del marcado sin otro marcado entre medias (botón con icono).
    const control = target.closest(CONTROL);
    if (!control) return null;
    if (control !== marked && !marked.contains(control) && !control.contains(marked)) return null;
    if (control !== marked && control.closest('[data-feedback-id]') !== marked) return null;
    return marked.getAttribute('data-feedback-id');
  }
  function activate(id: string): void {
    const now = Date.now();
    const last = lastActivation.get(id);
    lastActivation.set(id, now);
    const change: Partial<UsageTotals> = { activations: 1 };
    if (last !== undefined && now - last < REPEAT_MS) change.repeatedAttempts = 1;
    if (!session.activated.has(id)) { session.activated.add(id); saveSession(); change.sessionsActivated = 1; }
    bump(id, change);
  }
  const onClick = (e: Event) => { const id = activationTarget(e.target); if (id) activate(id); };
  const onKey = (e: Event) => {
    const k = (e as KeyboardEvent).key;
    if (k !== 'Enter' && k !== ' ') return;
    const t = e.target as Element | null;
    // Intro sobre un botón ya produce un clic: solo se cuenta aquí lo que no lo produce (pestañas y roles sin clic nativo).
    if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || (t instanceof HTMLInputElement && k === ' ')) return;
    const id = activationTarget(t);
    if (id && t?.getAttribute('role')) activate(id);
  };

  function outcome(id: string, ok: boolean): void {
    if (ok) {
      const change: Partial<UsageTotals> = { successes: 1 };
      if (!session.succeeded.has(id)) { session.succeeded.add(id); saveSession(); change.sessionsSucceeded = 1; }
      bump(id, change);
    } else bump(id, { errors: 1 });
  }

  // --- Envío -----------------------------------------------------------------------------------------
  async function flush(): Promise<void> {
    if (flushing) return flushing;
    flushing = (async () => {
      const user = options.userId();
      if (!user) return;
      await load(user);
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; await save(); }
      const dirty = [...records.values()].filter((r) => r.dirty && r.userId === user);
      if (!dirty.length) return;
      const items: UsageItem[] = dirty.map(({ day, featureId, generation, context: ctx, exposures, activations, successes, errors, sessionsExposed, sessionsActivated, sessionsSucceeded, repeatedAttempts, route }) =>
        ({ day, featureId, generation, context: ctx, exposures, activations, successes, errors, sessionsExposed, sessionsActivated, sessionsSucceeded, repeatedAttempts, ...(route ? { route } : {}) }));
      try {
        await options.api('/usage/batch', { method: 'POST', json: { deviceId: usageDeviceId(), items } });
      } catch { return; /* sin red o servidor caído: se reintenta con el próximo disparador */ }
      // Lo enviado queda limpio salvo que haya cambiado mientras tanto (el total nuevo saldrá en el siguiente envío).
      for (const sent of dirty) {
        const now = records.get(sent.key);
        const item = items.find((i) => i.day === sent.day && i.featureId === sent.featureId && i.context === sent.context);
        if (now && item && (Object.keys(ZERO) as (keyof UsageTotals)[]).every((k) => now[k] === item[k])) now.dirty = false;
      }
      const oldest = usageDay(new Date(Date.now() - KEEP_DAYS * 86_400_000));
      const stale = [...records.values()].filter((r) => !r.dirty && r.day < oldest);
      for (const r of stale) records.delete(r.key);
      try { await tx('readwrite', (s) => { for (const r of stale) s.delete(r.key); for (const r of records.values()) s.put(r); }); } catch { /* */ }
    })().finally(() => { flushing = null; });
    return flushing;
  }

  const onHidden = () => { if (document.visibilityState === 'hidden') void flush(); };
  const onOnline = () => { void flush(); };
  const onPageHide = () => { void flush(); };
  root.addEventListener('click', onClick, true);
  root.addEventListener('keydown', onKey, true);
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('online', onOnline);
  window.addEventListener('pagehide', onPageHide);
  const interval = setInterval(() => void flush(), options.flushEveryMs ?? 180_000);
  const body = root instanceof Document ? root.body : root;
  observeTree(body);
  mo.observe(body, { childList: true, subtree: true });
  const user = options.userId();
  if (user) void load(user).then(() => flush());
  if (options.notice !== false) void showUsageNotice({ api: options.api, userId: options.userId, container: options.container });

  return {
    async run(featureId, fn) {
      try { const value = await fn(); outcome(featureId, true); return value; }
      catch (error) { outcome(featureId, false); throw error; }
    },
    track(featureId, result = 'success') { outcome(featureId, result === 'success'); },
    activate,
    flush,
    today() {
      const day = usageDay();
      const u = options.userId();
      return [...records.values()].filter((r) => r.day === day && r.userId === u).map(({ key, userId, app, dirty, ...item }) => { void key; void userId; void app; void dirty; return item; });
    },
    async clear(userId) {
      for (const [key, r] of records) if (r.userId === userId) records.delete(key);
      if (loadedFor === userId) loadedFor = null;
      session.exposed.clear(); session.activated.clear(); session.succeeded.clear(); saveSession();
      try {
        const keys = (await tx<IDBValidKey[]>('readonly', (s) => s.index('user').getAllKeys(IDBKeyRange.only(userId)) as IDBRequest<IDBValidKey[]>)) ?? [];
        await tx('readwrite', (s) => { for (const k of keys) s.delete(k); });
      } catch { /* */ }
      try { localStorage.removeItem(`ikisai-usage-notice:${userId}`); } catch { /* */ }
    },
    destroy() {
      io?.disconnect(); mo.disconnect(); clearInterval(interval);
      for (const t of timers.values()) clearTimeout(t);
      root.removeEventListener('click', onClick, true);
      root.removeEventListener('keydown', onKey, true);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pagehide', onPageHide);
    },
  };
}
