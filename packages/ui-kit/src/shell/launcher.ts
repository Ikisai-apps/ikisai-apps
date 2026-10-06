/**
 * Lanzador de apps (contrato §3.3): al pulsar el icono de la app abre una hoja con las apps de la cuenta
 * (`GET /api/v1/apps` → `{ items: [{ id, name, domain, aliasDomain, kind, description, role }], current }`), en el orden
 * del catálogo: internas arriba y portales debajo. Cada una enlaza a `https://<domain>/` en la misma pestaña (en la PWA, el
 * sistema decide si abre la app instalada); gracias a la sesión única no pide contraseña. Sin red, muestra la última lista
 * guardada en este dispositivo. Los iconos son del kit (se ven también sin red); la app puede dar los suyos.
 */
import { el, replace } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';

export interface LauncherApp {
  id: string;
  name: string;
  domain: string;
  aliasDomain?: string | null;
  kind?: 'internal' | 'portal' | string;
  description?: string | null;
  role?: string | null;
}

export interface LauncherCatalog {
  items: LauncherApp[];
  current?: string | null;
}

export interface AppLauncherOptions {
  /** Pide el catálogo (`GET /api/v1/apps` con la sesión de la app). */
  fetchApps: () => Promise<LauncherCatalog>;
  /** Id de esta app, por si el catálogo no lo trae en `current`. */
  current?: string;
  /** Clave de la copia local; por defecto `ikisai-launcher-apps`. */
  storageKey?: string;
  /** Icono propio de una app (URL de imagen o nodo); por defecto, el del kit según su id. */
  appIcon?: (app: LauncherApp) => string | Node | null | undefined;
  /** Título de la hoja; por defecto «Apps de Ikisai». */
  title?: string;
}

export interface AppLauncher {
  open(): Promise<Sheet>;
  /** Engancha el lanzador a un botón (p. ej. la marca de la cabecera): `aria-haspopup` y clic. */
  attach(trigger: HTMLElement): void;
}

const KIT_ICONS: Record<string, IconName> = {
  tasks: 'tasks', booking: 'bed', food: 'chef', invoices: 'invoice', finance: 'invoice',
  central: 'grid', guests: 'people', organizers: 'calendar',
};
const ROLE_LABELS: Record<string, string> = { owner: 'Propietaria', editor: 'Edición', reader: 'Solo lectura' };

function readCache(key: string): LauncherCatalog | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as { catalog?: LauncherCatalog; savedAt?: string };
    return value.catalog && Array.isArray(value.catalog.items) ? value.catalog : null;
  } catch { return null; }
}
function writeCache(key: string, catalog: LauncherCatalog): void {
  try { localStorage.setItem(key, JSON.stringify({ catalog, savedAt: new Date().toISOString() })); } catch { /* sin almacenamiento */ }
}

function appMark(app: LauncherApp, custom?: string | Node | null): HTMLElement {
  const mark = el('span', { class: 'launcher-mark', 'aria-hidden': 'true', dataset: { app: app.id } });
  if (custom instanceof Node) mark.append(custom);
  else if (typeof custom === 'string' && custom) mark.append(el('img', { src: custom, alt: '', width: '40', height: '40', loading: 'lazy' }));
  else mark.append(icon(KIT_ICONS[app.id] ?? 'grid', 22));
  return mark;
}

/** Hoja de apps con la actual marcada; `attach(trigger)` la engancha a la marca de la cabecera. */
export function createAppLauncher(options: AppLauncherOptions): AppLauncher {
  const key = options.storageKey ?? 'ikisai-launcher-apps';

  function row(app: LauncherApp, current: string | null): HTMLElement {
    const here = app.id === current;
    const role = app.role ? ROLE_LABELS[app.role] ?? app.role : null;
    const body = [
      appMark(app, options.appIcon?.(app)),
      el('span', { class: 'launcher-text' },
        el('strong', null, app.name, here ? el('span', { class: 'chip small ok' }, el('span', null, 'Aquí')) : null),
        app.description ? el('small', null, app.description) : null,
        role && app.role !== 'owner' ? el('small', { class: 'launcher-role' }, role) : null,
      ),
      here ? null : icon('chevronRight', 16),
    ];
    return el('li', null, here
      ? el('div', { class: 'launcher-app current', 'aria-current': 'page', dataset: { app: app.id } }, ...body)
      : el('a', { class: 'launcher-app', href: `https://${app.domain}/`, dataset: { app: app.id } }, ...body));
  }

  function paint(host: HTMLElement, catalog: LauncherCatalog | null, state: 'loading' | 'fresh' | 'cached' | 'offline-empty'): void {
    const current = catalog?.current ?? options.current ?? null;
    const items = catalog?.items ?? [];
    const internal = items.filter((a) => a.kind !== 'portal');
    const portals = items.filter((a) => a.kind === 'portal');
    replace(host,
      state === 'cached' ? el('div', { class: 'banner info launcher-note' }, icon('offline', 18), el('span', null, 'Sin conexión: es la última lista guardada en este dispositivo.')) : null,
      state === 'offline-empty' ? el('div', { class: 'banner warn launcher-note' }, icon('offline', 18), el('span', null, 'Sin conexión y sin lista guardada. Vuelve a intentarlo con red.')) : null,
      state === 'loading' && !items.length ? el('p', { class: 'hint' }, 'Cargando tus apps…') : null,
      internal.length ? el('ul', { class: 'launcher-list', 'aria-label': 'Apps' }, ...internal.map((a) => row(a, current))) : null,
      portals.length ? el('h3', { class: 'launcher-group' }, 'Portales') : null,
      portals.length ? el('ul', { class: 'launcher-list', 'aria-label': 'Portales' }, ...portals.map((a) => row(a, current))) : null,
    );
  }

  async function open(): Promise<Sheet> {
    const host = el('div', { class: 'launcher' });
    const cached = readCache(key);
    paint(host, cached, cached ? 'fresh' : 'loading');
    const sheet = openSheet({ title: options.title ?? 'Apps de Ikisai', body: host });
    try {
      const catalog = await options.fetchApps();
      writeCache(key, catalog);
      if (sheet.isOpen()) paint(host, catalog, 'fresh');
    } catch {
      if (sheet.isOpen()) paint(host, cached, cached ? 'cached' : 'offline-empty');
    }
    return sheet;
  }

  return {
    open,
    attach(trigger) {
      trigger.setAttribute('aria-haspopup', 'dialog');
      if (!trigger.getAttribute('aria-label')) trigger.setAttribute('aria-label', 'Abrir otra app de Ikisai');
      trigger.addEventListener('click', (e) => { e.preventDefault(); void open(); });
    },
  };
}
