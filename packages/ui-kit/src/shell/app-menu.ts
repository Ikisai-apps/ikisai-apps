/**
 * Menú lateral común (MUELA-013, K7 y K8; aprobado por el usuario): la marca abre un cajón (izquierda, en el móvil y en
 * el ordenador) y, en el ordenador, puede quedarse además como columna fija a toda altura. De arriba abajo:
 * - Perfil y rol, con la línea de sincronización debajo (pulsable; en rojo si hay problema) y el botón de tema.
 * - Recientes (3), Secciones como azulejos que despliegan sus filas debajo (no saltan), los bloques propios de la app
 *   (`blocks`), Apps de Ikisai (el lanzador sin la app actual), «Comentarios y ayuda» y «Cerrar sesión».
 * Nada repite la barra de pestañas. Lo que va en cada sección, sus destinos y recuentos son de la app.
 * Accesible como diálogo modal: `aria-expanded` en la marca, foco a la primera entrada al abrir y de vuelta a la marca al
 * cerrar, Tab atrapado, Escape, el fondo y «atrás» cierran.
 * Prefijo de clases: `appmenu-` (sobre `navmenu-head`, `navmenu-close` y `navmenu-backdrop` del kit).
 */
import type { SyncStatus } from '@ikisai/sync-client';
import { el, replace, type Child } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { focusFirst, lockScroll, trapFocus } from '../overlay/focus.ts';
import { effectiveTheme, toggleTheme } from '../theme.ts';
import { kitLayer } from '../layer.ts';
import { trackOverlay, type OverlayHandle } from './back-navigation.ts';
import type { AppLauncher } from './launcher.ts';

export interface AppMenuRow {
  label: string;
  /** Línea pequeña («Obligación · hace 5 min»). */
  sub?: string | null;
  icon?: IconName | null;
  href?: string;
  onClick?: () => void;
  /** Recuento escrito («2 vencidas»), con tono. */
  count?: { text: string; tone?: 'alert' | 'warn' | null } | null;
  feedbackId?: string;
}

export interface AppMenuSection {
  key: string;
  label: string;
  icon?: IconName | null;
  /** Resumen bajo el nombre del azulejo. */
  summary?: string | null;
  /** Encabezado del panel al abrir. */
  head?: string | null;
  rows: AppMenuRow[];
  /** Recuento del azulejo (avisos). */
  badge?: { text: string; tone?: 'alert' | 'warn' | null } | null;
}

export interface AppMenuOptions {
  /** «Menú de Central»; por defecto «Menú de {app}». */
  label?: string;
  profile?: { name: string; role: string; href?: string; onOpen?: () => void } | null;
  /** Botón de tema claro/oscuro en la cabecera del menú. */
  theme?: boolean;
  recents?: () => AppMenuRow[];
  sections?: () => AppMenuSection[];
  /** Bloques propios de la app, tras las secciones (K8). */
  blocks?: () => Child[];
  /** Apps de Ikisai y los modos de feedback (`createAppLauncher`), dentro del menú, sin la app actual. */
  launcher?: AppLauncher;
  /** «Señalar un fallo aquí»: comentario sobre la pantalla actual. */
  signalHere?: () => void;
  /** Tocar la línea de sincronización (por defecto: con conflictos, `onResolveConflicts`; si no, sincronizar). */
  onSyncLine?: (status: SyncStatus | null) => void;
  onResolveConflicts?: () => void;
  /** En el ordenador (≥ 1024 px), además, columna fija a la izquierda. Por defecto, no. */
  column?: boolean;
  /** Base de las marcas (`central.menu`). */
  feedbackId?: string;
}

export interface AppMenuContext {
  appName: string;
  onLogout?: () => void | Promise<void>;
  onSync?: () => void | Promise<void>;
  navigate: (hash: string) => void;
}

export interface AppMenu {
  /** El cajón (fuera de la página hasta que se abre). */
  drawer: HTMLElement;
  /** La columna fija del ordenador (o `null`). */
  column: HTMLElement | null;
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Vuelve a pintar (recientes, recuentos, rol). */
  refresh(): void;
  setStatus(status: SyncStatus): void;
  /** Engancha la marca: `aria-haspopup`, `aria-controls`, `aria-expanded` y clic. */
  attach(trigger: HTMLElement): void;
  destroy(): void;
}

const minutesAgo = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return Number.isFinite(m) && m > 0 ? m : null;
};
const ago = (m: number) => (m < 60 ? kt('hace {n} min', { n: String(m) }) : m < 1440 ? kt('hace {n} h', { n: String(Math.round(m / 60)) }) : kt('hace {n} días', { n: String(Math.round(m / 1440)) }));

/** Texto de la línea de sincronización y si es un problema (en rojo). Lo más urgente primero. */
export function syncLine(status: SyncStatus | null): { text: string; problem: boolean; action: 'resolve' | 'sync' } {
  if (!status) return { text: kt('Sincronizado'), problem: false, action: 'sync' };
  const pending = status.pendingCommands + status.pendingBlobs;
  const since = minutesAgo(status.lastPullAt);
  if (status.network === 'syncing') return { text: kt('Sincronizando…'), problem: false, action: 'sync' };
  if (status.conflicts > 0) return { text: status.conflicts === 1 ? kt('1 conflicto · toca para resolver') : kt('{n} conflictos · toca para resolver', { n: String(status.conflicts) }), problem: true, action: 'resolve' };
  if (status.network === 'error' || status.lastError) return { text: since ? kt('Error al sincronizar · {ago}', { ago: ago(since) }) : kt('Error al sincronizar'), problem: true, action: 'sync' };
  if (status.network === 'offline') return { text: pending ? kt('Sin conexión · {n} sin enviar', { n: String(pending) }) : kt('Sin conexión'), problem: true, action: 'sync' };
  if (pending) return { text: `${pending === 1 ? kt('1 cambio pendiente') : kt('{n} cambios pendientes', { n: String(pending) })}${since ? ` · ${kt('sincronizado {ago}', { ago: ago(since) })}` : ''}`, problem: false, action: 'sync' };
  return { text: since ? kt('Sincronizado {ago}', { ago: ago(since) }) : kt('Sincronizado'), problem: false, action: 'sync' };
}

let uid = 0;

export function createAppMenu(options: AppMenuOptions, ctx: AppMenuContext): AppMenu {
  const id = `appMenu${uid ? `-${uid}` : ''}`;
  uid += 1;
  const label = options.label ?? kt('Menú de {app}', { app: ctx.appName });
  const base = options.feedbackId;
  const mark = (suffix: string | null, text: string): Record<string, string> => (base ? { 'data-feedback-id': suffix ? `${base}.${suffix}` : base, 'data-feedback-label': text } : {});
  let status: SyncStatus | null = null;
  let isOpen = false;
  let trigger: HTMLElement | null = null;
  let unlock: (() => void) | null = null;
  let history: OverlayHandle | null = null;
  // Cada contenedor (cajón y columna) tiene su propio azulejo abierto.
  const openTile = new Map<HTMLElement, string | null>();

  const go = (row: AppMenuRow) => (e: Event) => {
    if (row.onClick) { e.preventDefault(); close(); row.onClick(); return; }
    if (row.href?.startsWith('#')) { e.preventDefault(); close(); ctx.navigate(row.href); return; }
    close();
  };
  const rowEl = (row: AppMenuRow) => el('a', { class: 'navitem appmenu-row', href: row.href ?? '#', ...(row.feedbackId ? { 'data-feedback-id': row.feedbackId, 'data-feedback-label': row.label } : {}), onclick: go(row) },
    row.icon ? icon(row.icon, 19) : null,
    el('span', { class: 'appmenu-rowtext' }, el('span', null, row.label), row.sub ? el('small', null, row.sub) : null),
    row.count ? el('em', { class: `appmenu-count${row.count.tone ? ` ${row.count.tone}` : ''}` }, row.count.text) : icon('chevronRight', 16));

  function syncButton(): HTMLElement {
    const line = syncLine(status);
    return el('button', {
      type: 'button', class: `appmenu-sync${line.problem ? ' error' : ''}${status?.network === 'syncing' ? ' syncing' : ''}`,
      'aria-label': `${line.text}. ${line.action === 'resolve' ? kt('Resolver') : kt('Sincronizar ahora')}`, ...mark('estado', 'Estado de sincronización'),
      onclick: () => {
        if (options.onSyncLine) { close(); options.onSyncLine(status); return; }
        if (line.action === 'resolve' && options.onResolveConflicts) { close(); options.onResolveConflicts(); return; }
        void ctx.onSync?.();
      },
    }, icon(line.problem ? 'warn' : 'sync', 14), el('span', null, line.text));
  }

  function head(inColumn: boolean): HTMLElement {
    const p = options.profile;
    const themeBtn = options.theme ? el('button', {
      type: 'button', class: 'iconbtn appmenu-theme', 'aria-pressed': String(effectiveTheme() === 'dark'),
      'aria-label': effectiveTheme() === 'dark' ? kt('Cambiar a tema claro') : kt('Cambiar a tema oscuro'), ...mark('tema', 'Tema'),
      onclick: () => { toggleTheme(); paintAll(); },
    }, icon(effectiveTheme() === 'dark' ? 'sun' : 'moon', 20)) : null;
    return el('div', { class: 'navmenu-head appmenu-head' },
      p ? el(p.href ? 'a' : 'div', {
        class: 'appmenu-profile', ...(p.href ? { href: p.href, onclick: (e: Event) => { if (p.onOpen) { e.preventDefault(); close(); p.onOpen(); } else if (p.href?.startsWith('#')) { e.preventDefault(); close(); ctx.navigate(p.href); } } } : {}),
        'aria-label': kt('Tu cuenta: {name}, {role}', { name: p.name, role: p.role }), ...mark('cuenta', 'Tu cuenta'),
      }, el('span', { class: 'appmenu-avatar', 'aria-hidden': 'true' }, (p.name.trim()[0] ?? '·').toLocaleUpperCase()), el('span', { class: 'appmenu-who' }, el('strong', null, p.name), el('small', null, p.role))) : el('strong', { class: 'appmenu-title' }, label),
      themeBtn,
      inColumn ? null : el('button', { type: 'button', class: 'iconbtn navmenu-close appmenu-close', 'aria-label': kt('Cerrar el menú'), ...mark('cerrar', 'Cerrar el menú'), onclick: () => close() }, icon('close', 20)),
      syncButton());
  }

  function group(key: string, title: string, iconName: IconName | null, ...children: Child[]): HTMLElement {
    const hid = `${id}-${key}-h`;
    return el('section', { class: `appmenu-group appmenu-${key}`, 'aria-labelledby': hid },
      el('h3', { class: 'appmenu-grouplabel', id: hid }, iconName ? icon(iconName, 18) : null, title), ...children);
  }

  function sectionsBlock(host: HTMLElement): HTMLElement | null {
    const list = options.sections?.() ?? [];
    if (!list.length) return null;
    const open = openTile.get(host) ?? null;
    const rows: Child[] = [];
    for (let i = 0; i < list.length; i += 3) {
      const chunk = list.slice(i, i + 3);
      rows.push(el('div', { class: 'appmenu-tiles' }, ...chunk.map((s) => el('button', {
        type: 'button', class: `appmenu-tile${s.key === open ? ' open' : ''}`, 'aria-expanded': String(s.key === open), 'aria-controls': `${id}-${host === drawer ? 'd' : 'c'}-sec-${s.key}`,
        ...mark(`secciones.${s.key}`, s.label),
        onclick: () => { openTile.set(host, open === s.key ? null : s.key); paint(host); host.querySelector<HTMLElement>(`.appmenu-tile[aria-controls$="sec-${s.key}"]`)?.focus(); },
      },
      el('span', { class: 'appmenu-tilemark', 'aria-hidden': 'true' }, s.icon ? icon(s.icon, 22) : null),
      el('span', { class: 'appmenu-tiletext' }, s.label),
      s.summary ? el('small', null, s.summary) : null,
      s.badge ? el('em', { class: `appmenu-count${s.badge.tone ? ` ${s.badge.tone}` : ''}` }, s.badge.text) : null))));
      const opened = chunk.find((s) => s.key === open);
      if (opened) rows.push(el('div', { class: 'appmenu-panel', id: `${id}-${host === drawer ? 'd' : 'c'}-sec-${opened.key}`, role: 'region', 'aria-label': opened.label },
        opened.head ? el('p', { class: 'appmenu-panelhead' }, opened.head) : null, ...opened.rows.map(rowEl)));
    }
    return group('secciones', kt('Secciones'), 'grid', ...rows);
  }

  function body(host: HTMLElement): HTMLElement {
    const recents = options.recents?.() ?? null;
    const apps = options.launcher ? el('div', { class: 'appmenu-apps', ...mark('apps', 'Apps de Ikisai') }) : null;
    if (apps) void options.launcher!.mount(apps, { hideCurrent: true, onLeave: () => close(), part: 'apps' });
    const feedback = options.launcher ? el('div', { class: 'appmenu-feedback' }) : null;
    if (feedback) void options.launcher!.mount(feedback, { onLeave: () => close(), part: 'feedback' });
    return el('div', { class: 'appmenu-body' },
      recents ? group('recientes', kt('Recientes'), 'history',
        recents.length ? el('div', { class: 'appmenu-rows' }, ...recents.slice(0, 3).map(rowEl)) : el('p', { class: 'hint appmenu-empty' }, kt('Todavía nada reciente. Lo que abras aparecerá aquí.'))) : null,
      sectionsBlock(host),
      ...(options.blocks?.() ?? []),
      apps ? group('apps', kt('Apps de Ikisai'), 'grid', apps) : null,
      options.signalHere || feedback ? group('ayuda', kt('Comentarios y ayuda'), 'help',
        options.signalHere ? el('button', { type: 'button', class: 'appmenu-signal', ...mark('ayuda.senalar', 'Señalar un fallo aquí'), onclick: () => { close(); options.signalHere!(); } }, icon('warn', 18), kt('Señalar un fallo aquí')) : null,
        feedback) : null,
      ctx.onLogout ? el('div', { class: 'appmenu-logout' }, el('button', { type: 'button', class: 'navitem appmenu-row', ...mark('cuenta.salir', 'Cerrar sesión'), onclick: () => { close(); void ctx.onLogout?.(); } }, icon('logout', 19), el('span', { class: 'appmenu-rowtext' }, el('span', null, kt('Cerrar sesión'))))) : null);
  }

  function paint(host: HTMLElement): void {
    const scroller = host.querySelector('.appmenu-body');
    const top = scroller?.scrollTop ?? 0;
    replace(host, head(host === column), body(host));
    const next = host.querySelector('.appmenu-body');
    if (next) next.scrollTop = top;
  }
  function paintAll(): void { if (isOpen) paint(drawer); if (column) paint(column); }

  const backdrop = el('button', { type: 'button', class: 'navmenu-backdrop show appmenu-backdrop', tabindex: '-1', 'aria-label': kt('Cerrar el menú'), onclick: () => close() });
  const drawer = el('nav', { class: 'appmenu-drawer', id, role: 'dialog', 'aria-modal': 'true', 'aria-label': label, ...mark(null, 'Menú'),
    onkeydown: (e: Event) => { const k = e as KeyboardEvent; if (k.key === 'Escape') { e.preventDefault(); close(); } else if (k.key === 'Tab') trapFocus(k, drawer); } });
  const column = options.column ? el('aside', { class: 'appmenu-column', 'aria-label': label, ...mark('columna', 'Menú lateral') }) : null;

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    paint(drawer);
    kitLayer().append(backdrop, drawer);
    unlock = lockScroll();
    trigger?.setAttribute('aria-expanded', 'true');
    focusFirst(drawer, drawer.querySelector<HTMLElement>('.appmenu-body a, .appmenu-body button'));
    history = trackOverlay(() => { history = null; close(); });
  }
  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    history?.release();
    history = null;
    backdrop.remove();
    drawer.remove();
    unlock?.();
    unlock = null;
    trigger?.setAttribute('aria-expanded', 'false');
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  if (column) paint(column);
  return {
    drawer, column, open, close,
    isOpen: () => isOpen,
    refresh: paintAll,
    setStatus(next) {
      status = next;
      // Solo la línea: no se repinta todo (se perdería el foco del cajón).
      for (const host of [isOpen ? drawer : null, column]) host?.querySelector('.appmenu-sync')?.replaceWith(syncButton());
    },
    attach(t) {
      trigger = t;
      t.setAttribute('aria-haspopup', 'dialog');
      t.setAttribute('aria-controls', id);
      t.setAttribute('aria-expanded', 'false');
      t.setAttribute('aria-label', kt('Abrir el menú de {app}', { app: ctx.appName }));
      t.addEventListener('click', (e) => { e.preventDefault(); if (isOpen) close(); else open(); });
    },
    destroy() { close(); column?.remove(); },
  };
}
