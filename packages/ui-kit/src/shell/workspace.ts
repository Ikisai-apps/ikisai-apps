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
}

/** Pestañas de área desplazables en horizontal. */
export function renderAreaTabs(options: AreaTabsOptions): HTMLElement {
  return el('div', { class: 'tabstrip', role: 'group', 'aria-label': options.label, ...(options.attrs ?? {}) },
    ...(options.leading ?? []),
    ...options.items.map((tab) => el('button', {
      type: 'button',
      class: cls('tabpill', tab.general && 'general', tab.color && 'colored', tab.active && 'active'),
      style: tab.color ? itemColorStyle(tab.color) : null,
      'aria-pressed': String(!!tab.active),
      ...(tab.attrs ?? {}),
    }, tab.label, tab.count ? el('span', { class: 'tabcount', 'aria-label': `${tab.count} pendientes` }, String(tab.count)) : null)),
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

/** Navegación inferior en móvil (en escritorio la sustituye el menú lateral). */
export function renderTabBar(options: { label: string; items: TabBarItem[]; attrs?: HookAttrs; className?: string }): HTMLElement {
  return el('nav', { class: cls('tabbar', options.className), 'aria-label': options.label, ...(options.attrs ?? {}) },
    ...options.items.map((item) => el('button', {
      type: 'button', class: cls('navbtn', item.active && 'active'), 'aria-current': item.active ? 'page' : null, ...(item.attrs ?? {}),
    }, iconOf(item.icon, 22), el('span', null, item.label))),
  );
}
