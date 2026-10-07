/**
 * Contexto técnico con lista blanca (especificación §9 y §10; FEEDBACK.md §2.7 y §6): versión de `version.json`, ruta
 * saneada, nodo, viewport, clase de dispositivo, en línea, rol, service worker, últimos errores de JS y últimos fallos HTTP.
 * Nunca HTML, texto de la página, valores de campos, almacenamiento, cookies, cabeceras ni cuerpos. Como mucho 8 KB.
 */
import { FEEDBACK_MAX_CONTEXT_BYTES } from './constants.ts';
import type { FeedbackNode } from './node.ts';

const MAX_EVENTS = 5;
const MAX_STEPS = 10;
/** Pasos para reproducir (FEEDBACK.md §8.5): ruta y nodo de las últimas acciones, nunca valores. */
const steps: ({ at: string; kind: 'route'; route: string } | { at: string; kind: 'tap'; nodeId: string; path: string[] })[] = [];
const errors: { at: string; type: string; message: string }[] = [];
const httpFailures: { at: string; method: string; path: string; status: number }[] = [];
let observing = false;
let versionCache: Promise<{ release?: string; commit?: string } | null> | null = null;

/**
 * Ruta saneada: sin `?` ni `#…?`, y con los tramos que parecen datos (uuid, números, códigos largos, correos) como `:id`.
 * `/api/v1/reservations/3f0c…/guests?x=1` → `/api/v1/reservations/:id/guests`.
 */
export function sanitizePath(raw: string): string {
  let path = raw;
  try { path = new URL(raw, location.origin).pathname; } catch { path = raw.split('?')[0]!; }
  return path.split('/').map((part) => {
    if (!part) return part;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part)) return ':id';
    if (/^\d+$/.test(part) || /@/.test(part) || /^[A-Za-z0-9_-]{20,}$/.test(part) || /\d{4,}/.test(part)) return ':id';
    return part;
  }).join('/').slice(0, 160);
}

/** Ruta de la app saneada: la del hash si la app navega por hash, si no la del `pathname`. */
export function sanitizedRoute(): string {
  const hash = location.hash.replace(/^#/, '').split('?')[0]!;
  return hash ? `#${sanitizePath(hash.startsWith('/') ? hash : `/${hash}`)}` : sanitizePath(location.pathname);
}

function push<T>(list: T[], item: T): void {
  list.push(item);
  if (list.length > MAX_EVENTS) list.shift();
}

/** Empieza a observar errores de JS y fallos HTTP (una vez por página). Solo guarda tipo, mensaje corto, método, ruta y estado. */
export function observeFeedbackContext(): void {
  if (observing) return;
  observing = true;
  const route = () => { const r = sanitizedRoute(); const last = steps[steps.length - 1]; if (!last || last.kind !== 'route' || last.route !== r) { steps.push({ at: new Date().toISOString(), kind: 'route', route: r }); if (steps.length > MAX_STEPS) steps.shift(); } };
  route();
  window.addEventListener('hashchange', route);
  window.addEventListener('popstate', route);
  document.addEventListener('click', (e) => {
    const node = e.target instanceof Element ? e.target.closest('[data-feedback-id]') : null;
    if (!node) return;
    const chain: string[] = [];
    for (let el: Element | null = node; el; el = el.parentElement) if (el.hasAttribute('data-feedback-id')) chain.unshift(el.getAttribute('data-feedback-label') || (el.getAttribute('data-feedback-id') ?? '').split('.').pop() || '');
    steps.push({ at: new Date().toISOString(), kind: 'tap', nodeId: node.getAttribute('data-feedback-id')!, path: chain.slice(-6) });
    if (steps.length > MAX_STEPS) steps.shift();
    setTimeout(route, 0);
  }, true);
  window.addEventListener('error', (e) => push(errors, { at: new Date().toISOString(), type: (e.error as Error | undefined)?.name ?? 'Error', message: String(e.message ?? '').slice(0, 160) }));
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { name?: string; message?: string; code?: string } | undefined;
    push(errors, { at: new Date().toISOString(), type: reason?.code ?? reason?.name ?? 'Rejection', message: String(reason?.message ?? '').slice(0, 160) });
  });
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    try {
      const response = await original(input, init);
      if (!response.ok) push(httpFailures, { at: new Date().toISOString(), method, path: sanitizePath(url), status: response.status });
      return response;
    } catch (error) {
      push(httpFailures, { at: new Date().toISOString(), method, path: sanitizePath(url), status: 0 });
      throw error;
    }
  };
}

/** `release` y `commit` de `/version.json` de la app (null si no hay). */
export async function appVersion(): Promise<{ release?: string; commit?: string } | null> {
  versionCache ??= fetch('/version.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((v: { release?: unknown; commit?: unknown } | null) => (v ? { release: typeof v.release === 'string' ? v.release : undefined, commit: typeof v.commit === 'string' ? v.commit : undefined } : null))
    .catch(() => null);
  return versionCache;
}

export interface FeedbackContextInput {
  app: string;
  node?: FeedbackNode | null;
  role?: string | null;
  /** Estado de sincronización de `sync-client` (`getSyncSummary()`); solo se copian los campos de la lista blanca. */
  sync?: { pending?: number; conflicts?: number; rejected?: number; lastSyncAt?: string | null; online?: boolean } | null;
}

/** Contexto listo para `POST feedback` (`context`), recortado a 8 KB quitando primero lo menos útil. */
export async function collectFeedbackContext(input: FeedbackContextInput): Promise<Record<string, unknown>> {
  const version = await appVersion();
  const sw = navigator.serviceWorker?.controller?.scriptURL;
  const context: Record<string, unknown> = {
    app: input.app,
    appVersion: version?.release ?? null,
    commit: version?.commit ?? null,
    route: sanitizedRoute(),
    nodeId: input.node?.id ?? null,
    nodePath: input.node?.path ?? [],
    deviceClass: matchMedia('(pointer: coarse)').matches ? (innerWidth < 768 ? 'mobile' : 'tablet') : 'desktop',
    viewport: { width: innerWidth, height: innerHeight },
    online: navigator.onLine,
    role: input.role ?? null,
    serviceWorker: sw ? sanitizePath(sw) : null,
    sync: input.sync ? { pending: input.sync.pending ?? null, conflicts: input.sync.conflicts ?? null, rejected: input.sync.rejected ?? null, lastSyncAt: input.sync.lastSyncAt ?? null, online: input.sync.online ?? null } : null,
    steps: steps.slice(),
    errors: errors.slice(),
    httpFailures: httpFailures.slice(),
  };
  const size = () => new Blob([JSON.stringify(context)]).size;
  for (const key of ['steps', 'errors', 'httpFailures'] as const) {
    while (size() > FEEDBACK_MAX_CONTEXT_BYTES && (context[key] as unknown[]).length) (context[key] as unknown[]).shift();
  }
  return context;
}
