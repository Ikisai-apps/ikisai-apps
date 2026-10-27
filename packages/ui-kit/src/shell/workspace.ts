/**
 * Barra de espacio de trabajo: piezas sin estado para apps con áreas, vistas guardadas y un menú agrupado (Tasks).
 * Cada función devuelve un elemento; la app puede montarlo o, como Tasks en su paso 1, serializarlo y repintarlo entero
 * en cada `render()`. Ningún manejador se engancha aquí: los atributos (`attrs`) llevan los ganchos de la app.
 *
 *   header.topbar.workspace
 *     .topbar-row  (marca, nombre, .spacer, herramientas)
 *     .tabstrip    (pestañas de área: .tabpill, .tabtool, .tabcount)
 *     .viewstrip   (vistas guardadas: .viewpill)
 *   nav.navmenu    (menú agrupado: desplegable en móvil con .show, barra lateral fija en escritorio)
 *   nav.tabbar     (navegación inferior en móvil: .navbtn)
 */
import { el, type Child } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { itemColorStyle } from '../theme.ts';

export type HookAttrs = Record<string, string | number | boolean | null | undefined>;
/** Icono del kit por nombre, o un nodo propio de la app (p. ej. su SVG). */
export type IconLike = IconName | Node | null | undefined;

function iconOf(value: IconLike, size = 19): Node | null {
  if (value == null) return null;
  return typeof value === 'string' ? icon(value as IconName, size) : value;
}

function cls(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export interface WorkspaceBarOptions {
  /** Nombre corto junto a la marca («Ikisai»). */
  name: string;
  /** Texto pequeño junto al nombre («Tareas»). */
  sub?: string;
  markIcon?: IconName;
  /** Herramientas a la derecha del `.spacer` (estado, menú). */
  tools?: Child[];
  /** Filas debajo de la de marca (`renderAreaTabs`, `renderQuickViews`). */
  rows?: Child[];
  /** Clase extra de la fila de marca (gancho de la app, p. ej. `brandrow`). */
  rowClass?: string;
  /** La marca como botón (`#appLauncher`), para engancharle el lanzador de apps con `launcher.attach`. */
  markButton?: boolean;
  attrs?: HookAttrs;
}

/** Cabecera apilada: fila de marca con `.spacer` y herramientas, y filas extra debajo. */
export function renderWorkspaceBar(options: WorkspaceBarOptions): HTMLElement {
  return el('header', { class: 'topbar workspace', ...(options.attrs ?? {}) },
    el('div', { class: cls('topbar-row', options.rowClass) },
      options.markButton
        ? el('button', { type: 'button', class: 'mark markbtn', id: 'appLauncher', 'aria-label': 'Abrir otra app de Ikisai', 'aria-haspopup': 'dialog' }, icon(options.markIcon ?? 'mark', 20))
        : el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 20)),
      el('div', { class: 'brand-name' }, options.name),
      options.sub ? el('span', { class: 'brand-sub' }, options.sub) : null,
      el('div', { class: 'spacer' }),
      ...(options.tools ?? []),
    ),
    ...(options.rows ?? []),
  );
}

export interface AreaTab {
  label: string;
  active?: boolean;
  /** Color propio del área: la pestaña activa lo toma, con tinta calculada. */
  color?: string | null;
  /** Pendientes del área. */
  count?: number;
  /** Qué cuenta la cifra («3 por cobrar»); por defecto «{n} pendientes». Se lee siempre y, en columnas, también se ve. */
  countText?: string;
  /** Pestaña especial (p. ej. «General»): borde discontinuo. */
  general?: boolean;
  attrs?: HookAttrs;
}

export interface AreaTabsOptions {
  label: string;
  items: AreaTab[];
  /** Botones antes de las pestañas (`.tabtool`, p. ej. gestionar áreas). */
  leading?: Child[];
  attrs?: HookAttrs;
  /**
   * `columns` (etapas con su cifra, MUELA-075 pieza 15): en el móvil sigue siendo la tira; desde 1024 px, una columna por
   * etapa con la cifra grande y lo que cuenta escrito. Por defecto `strip`, igual que siempre.
   */
  layout?: 'strip' | 'columns';
}

/** Pestañas de área desplazables en horizontal (o en columnas en escritorio, con `layout: 'columns'`). */
export function renderAreaTabs(options: AreaTabsOptions): HTMLElement {
  const columns = options.layout === 'columns';
  return el('div', { class: cls('tabstrip', columns && 'columns'), role: 'group', 'aria-label': options.label, ...(options.attrs ?? {}) },
    ...(options.leading ?? []),
    ...options.items.map((tab) => el('button', {
      type: 'button',
      class: cls('tabpill', tab.general && 'general', tab.color && 'colored', tab.active && 'active'),
      style: tab.color ? itemColorStyle(tab.color) : null,
      'aria-pressed': String(!!tab.active),
      ...(tab.attrs ?? {}),
    }, tab.label,
    columns
      ? el('span', { class: 'tabcount', 'aria-label': tab.countText ?? `${tab.count ?? 0} pendientes` }, String(tab.count ?? 0))
      : tab.count ? el('span', { class: 'tabcount', 'aria-label': tab.countText ?? `${tab.count} pendientes` }, String(tab.count)) : null,
    columns && tab.countText ? el('span', { class: 'tabcount-text', 'aria-hidden': 'true' }, tab.countText) : null)),
  );
}

/** Botón de herramienta para la tira de pestañas o de vistas (`.tabtool`). */
export function renderStripTool(options: { label: string; icon: IconLike; attrs?: HookAttrs; className?: string }): HTMLElement {
  return el('button', { type: 'button', class: cls('tabtool', options.className), 'aria-label': options.label, title: options.label, ...(options.attrs ?? {}) }, iconOf(options.icon, 18));
}

export interface QuickView {
  label: string;
  active?: boolean;
  icon?: IconLike;
  className?: string;
  attrs?: HookAttrs;
}

/** Tira de vistas guardadas: pastillas que aplican un filtro con un toque. */
export function renderQuickViews(options: { label: string; items: QuickView[]; leading?: Child[]; attrs?: HookAttrs }): HTMLElement {
  return el('div', { class: 'viewstrip', role: 'group', 'aria-label': options.label, ...(options.attrs ?? {}) },
    ...(options.leading ?? []),
    ...options.items.map((view) => el('button', {
      type: 'button', class: cls('viewpill', view.className, view.active && 'active'), 'aria-pressed': String(!!view.active), ...(view.attrs ?? {}),
    }, iconOf(view.icon, 15), view.label)),
  );
}

export interface NavMenuItem {
  label: string;
  icon?: IconLike;
  active?: boolean;
  disabled?: boolean;
  attrs?: HookAttrs;
}

export interface NavMenuGroup {
  label: string;
  icon?: IconLike;
  open?: boolean;
  items: NavMenuItem[];
  attrs?: HookAttrs;
}

export interface NavMenuOptions {
  label: string;
  groups: NavMenuGroup[];
  /** Contenido de la cabecera (alias, tema); el botón de cerrar va al final. */
  header?: Child[];
  /** Nota al pie («Área actual: …»). */
  hint?: Child;
  /** Atributos del botón de cerrar (gancho de la app, p. ej. `id`). */
  closeAttrs?: HookAttrs;
  /** Clases extra de la cabecera y de cada grupo/elemento, por compatibilidad con ganchos existentes. */
  headerClass?: string;
  groupClass?: string;
  itemClass?: string;
  attrs?: HookAttrs;
}

/**
 * Menú agrupado: en móvil es un panel desplegable (visible con la clase `show`, junto a `renderNavBackdrop`); en
 * escritorio es la barra lateral fija de ancho `--sidebar-width` (264 px). Los grupos son `details` plegables.
 */
export function renderNavMenu(options: NavMenuOptions): HTMLElement {
  return el('nav', { class: 'navmenu', 'aria-label': options.label, ...(options.attrs ?? {}) },
    el('div', { class: cls('navmenu-head', options.headerClass) },
      ...(options.header ?? []),
      el('button', { type: 'button', class: 'iconbtn small navmenu-close', 'aria-label': 'Cerrar menú', ...(options.closeAttrs ?? {}) }, icon('close', 18)),
    ),
    ...options.groups.map((group) => el('details', { class: cls('navgroup', options.groupClass), open: !!group.open, ...(group.attrs ?? {}) },
      el('summary', null, iconOf(group.icon), el('span', null, group.label), icon('chevronDown', 16)),
      el('div', { class: 'navgroup-items' },
        ...group.items.map((item) => el('button', {
          type: 'button', class: cls('navitem', options.itemClass, item.active && 'active'), disabled: !!item.disabled,
          'aria-current': item.active ? 'page' : null, ...(item.attrs ?? {}),
        }, iconOf(item.icon), el('span', null, item.label))),
      ),
    )),
    options.hint ? el('div', { class: 'navmenu-hint' }, options.hint) : null,
  );
}

/** Fondo que cierra el menú desplegable en móvil (visible con `show`). */
export function renderNavBackdrop(attrs: HookAttrs = {}): HTMLElement {
  return el('button', { type: 'button', class: 'navmenu-backdrop', 'aria-label': 'Cerrar menú', tabindex: '-1', ...attrs });
}

export interface TabBarItem {
  label: string;
  icon: IconLike;
  active?: boolean;
  attrs?: HookAttrs;
}

/**
 * En la app instalada (`display-mode: standalone`, K2 · FB_2026_075):
 * - `'flush'`: los botones bajan hasta el borde; sin franja de papel vacía en el área segura.
 * - `'autohide'`: se esconde al bajar y vuelve al subir (ver `bindTabBarAutoHide`).
 * - `'both'`: las dos cosas.
 * En el navegador no cambia nada.
 */
export type TabBarStandalone = 'flush' | 'autohide' | 'both';

/** Navegación inferior en móvil (en escritorio la sustituye el menú lateral). */
export function renderTabBar(options: { label: string; items: TabBarItem[]; attrs?: HookAttrs; className?: string; standalone?: TabBarStandalone }): HTMLElement {
  const mode = options.standalone;
  const nav = el('nav', { class: cls('tabbar', (mode === 'flush' || mode === 'both') && 'tabbar-flush', options.className), 'aria-label': options.label, ...(options.attrs ?? {}) },
    ...options.items.map((item) => el('button', {
      type: 'button', class: cls('navbtn', item.active && 'active'), 'aria-current': item.active ? 'page' : null, ...(item.attrs ?? {}),
    }, iconOf(item.icon, 22), el('span', null, item.label))),
  );
  if (mode === 'autohide' || mode === 'both') bindTabBarAutoHide(nav);
  return nav;
}

/* Un solo vigilante para toda la página: la app puede volver a pintar la barra en cada render sin sumar oyentes. */
const autoHide = { installed: false, hidden: false, down: 0, touchY: null as number | null };
const lastScroll = new WeakMap<object, number>();
const AUTOHIDE_DOWN = 24;
const AUTOHIDE_EDGE = 24;

function standaloneNow(): boolean {
  return typeof matchMedia === 'function' && (matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
}
function autoHideBars(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.tabbar.tabbar-autohide')].filter((n) => n.isConnected);
}
function paintAutoHide(): void {
  const hidden = autoHide.hidden && standaloneNow();
  const bars = autoHideBars();
  for (const nav of bars) nav.classList.toggle('tabbar-hidden', hidden);
  const root = document.documentElement;
  if (!bars.length) { root.style.removeProperty('--tabbar-offset'); return; }
  if (!standaloneNow()) { root.style.removeProperty('--tabbar-offset'); return; }
  root.style.setProperty('--tabbar-offset', hidden ? '0px' : `${Math.round(bars[0]!.getBoundingClientRect().height)}px`);
}
function setAutoHidden(hidden: boolean): void {
  autoHide.down = 0;
  if (autoHide.hidden === hidden) return;
  autoHide.hidden = hidden;
  paintAutoHide();
}
/* Lo que se desplaza: la página o una columna de la app. No cuentan las hojas, los diálogos ni lo que se mueve en horizontal. */
function scrollState(target: EventTarget | null): { key: object; y: number; end: boolean } | null {
  const box = target instanceof HTMLElement && target !== document.documentElement && target !== document.body ? target : null;
  if (box) {
    if (box.closest('.sheetback, .dialogback, .palette-back, .navmenu, .tabbar')) return null;
    if (box.scrollHeight <= box.clientHeight + 1) return null;
    return { key: box, y: box.scrollTop, end: box.scrollTop + box.clientHeight >= box.scrollHeight - 2 };
  }
  const doc = document.scrollingElement ?? document.documentElement;
  return { key: document, y: doc.scrollTop, end: doc.scrollTop + innerHeight >= doc.scrollHeight - 2 };
}
function installAutoHide(): void {
  if (autoHide.installed) return;
  autoHide.installed = true;
  document.addEventListener('scroll', (event) => {
    if (!standaloneNow() || !autoHideBars().length) return;
    // El navegador ya agrupa los `scroll` por fotograma: se atiende cada uno, sin esperar a otro.
    const state = scrollState(event.target);
    if (!state) return;
    const { key, y, end } = state;
    const dy = y - (lastScroll.get(key) ?? y);
    lastScroll.set(key, y);
    if (y <= 0 || end || dy < 0) { setAutoHidden(false); return; }
    autoHide.down += dy;
    if (autoHide.down > AUTOHIDE_DOWN) setAutoHidden(true);
  }, { capture: true, passive: true });
  // Deslizar hacia arriba desde el borde inferior la trae.
  document.addEventListener('touchstart', (event) => {
    const t = event.touches[0];
    autoHide.touchY = t && t.clientY >= innerHeight - AUTOHIDE_EDGE ? t.clientY : null;
  }, { passive: true });
  document.addEventListener('touchmove', (event) => {
    const t = event.touches[0];
    if (autoHide.touchY !== null && t && autoHide.touchY - t.clientY > 16) { autoHide.touchY = null; setAutoHidden(false); }
  }, { passive: true });
  document.addEventListener('focusin', (event) => {
    if (event.target instanceof Element && event.target.closest('.tabbar.tabbar-autohide')) setAutoHidden(false);
  });
  if (typeof matchMedia === 'function') matchMedia('(display-mode: standalone)').addEventListener?.('change', paintAutoHide);
  addEventListener('resize', paintAutoHide);
}

/**
 * La barra se esconde al desplazarse hacia abajo y vuelve al subir, al llegar al final, al deslizar hacia arriba desde el
 * borde inferior o cuando el foco entra en ella. Solo en la app instalada; en el navegador no hace nada. Pone en `:root`
 * `--tabbar-offset` (lo que ocupa la barra a la vista; 0 escondida), que usa el `.fab` del kit. `renderTabBar` la llama
 * con `standalone: 'autohide' | 'both'`. Devuelve la barra.
 */
export function bindTabBarAutoHide(nav: HTMLElement): HTMLElement {
  nav.classList.add('tabbar-autohide');
  installAutoHide();
  if (!lastScroll.has(document)) lastScroll.set(document, (document.scrollingElement ?? document.documentElement).scrollTop);
  if (autoHide.hidden && standaloneNow()) nav.classList.add('tabbar-hidden');
  queueMicrotask(paintAutoHide);
  return nav;
}
