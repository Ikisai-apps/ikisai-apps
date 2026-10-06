import type { SyncStatus } from '@ikisai/sync-client';
import { el, replace } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { createStatusBar, statusBanners, type StatusBannersOptions, type StatusBarOptions } from '../status/status-bar.ts';

export interface NavItem {
  /** Destino, normalmente un hash de ruta: `#/facturas`. */
  hash: string;
  label: string;
  icon: IconName;
  /** Rutas que mantienen este elemento activo. Por defecto, solo `hash`. */
  matches?: readonly string[];
  /** Marca «fase 1» cuando la sección aún no existe. */
  soon?: boolean;
  /** Contador (conflictos, pendientes). */
  badge?: number;
}

export interface AppShellOptions {
  /** Nombre de la app: «Invoices». La cabecera muestra «Ikisai Invoices». */
  appName: string;
  /** Texto pequeño bajo el nombre (perfil, área activa). */
  subtitle?: string;
  /** Icono de la marca de la app (`bed`, `chef`, `invoice`, `tasks`); por defecto el genérico. */
  markIcon?: IconName;
  nav: readonly NavItem[];
  /** Barra de estado: cliente o estado inicial, acción de sincronizar, clic. */
  status?: StatusBarOptions;
  /** Botón «Cerrar sesión» (escritorio). */
  onLogout?: () => void | Promise<void>;
  /** Herramientas extra en la cabecera (tema, alias, menú). */
  tools?: HTMLElement[];
  /** Texto de ayuda al pie de la navegación en escritorio. */
  navFoot?: string;
  /** Navegación: por defecto cambia `location.hash`. */
  navigate?: (hash: string) => void;
}

export interface AppShell {
  element: HTMLElement;
  header: HTMLElement;
  nav: HTMLElement;
  banners: HTMLElement;
  main: HTMLElement;
  /** Marca el elemento de navegación activo para la ruta dada. */
  setRoute(hash: string): void;
  /** Cambia el subtítulo de la cabecera. */
  setSubtitle(text: string): void;
  /** Vuelve a pintar la barra de estado (si se creó sin cliente). */
  setStatus(status: SyncStatus): void;
  /** Sustituye los banners por los derivados del estado más los extra. */
  setBanners(status: SyncStatus, options?: StatusBannersOptions, extra?: HTMLElement[]): void;
  /** Actualiza contadores de la navegación. */
  setBadge(hash: string, count: number): void;
  destroy(): void;
}

/** Cabecera, navegación (inferior en móvil, lateral en escritorio), zona de banners y `<main>`. */
export function createAppShell(root: HTMLElement, options: AppShellOptions): AppShell {
  const navigate = options.navigate ?? ((hash: string) => { location.hash = hash; });
  const subtitle = el('small', { id: 'shellSubtitle' }, options.subtitle ?? '');
  const status = createStatusBar(options.status ?? {});
  const logoutButton = options.onLogout
    ? el('button', { class: 'iconbtn desktop-only', type: 'button', id: 'logoutButton', 'aria-label': 'Cerrar sesión', title: 'Cerrar sesión', onclick: () => void options.onLogout?.() }, icon('logout'))
    : null;
  const header = el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 20)),
      el('h1', null, `Ikisai ${options.appName}`, subtitle),
    ),
    status.element,
    el('div', { class: 'tools' }, ...(options.tools ?? []), logoutButton),
  );

  const links = new Map<string, HTMLAnchorElement>();
  const nav = el('nav', { class: 'nav', 'aria-label': 'Secciones' },
    ...options.nav.map((item) => {
      const link = el('a', { class: 'navbtn', href: item.hash, dataset: { hash: item.hash }, onclick: (event: Event) => { event.preventDefault(); navigate(item.hash); } },
        icon(item.icon),
        el('span', null, item.label),
        item.soon ? el('span', { class: 'soon', 'aria-label': 'pendiente de la fase 1' }, 'fase 1') : null,
        item.badge ? el('span', { class: 'badge', 'aria-label': `${item.badge} avisos` }, String(item.badge)) : null,
      );
      links.set(item.hash, link);
      return link;
    }),
    options.navFoot ? el('div', { class: 'navfoot' }, options.navFoot) : null,
  );

  const banners = el('div', { class: 'banners' });
  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  const element = el('div', { class: `shell${options.nav.length ? '' : ' nonav'}` }, header, nav, el('div', null, banners, main));
  replace(root, element);

  return {
    element,
    header,
    nav,
    banners,
    main,
    setRoute(hash) {
      for (const item of options.nav) {
        const link = links.get(item.hash);
        if (!link) continue;
        const active = (item.matches ?? [item.hash]).includes(hash);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
    setSubtitle(text) {
      subtitle.textContent = text;
    },
    setStatus(next) {
      status.update(next);
    },
    setBanners(next, bannerOptions, extra = []) {
      replace(banners, ...statusBanners(next, bannerOptions), ...extra);
    },
    setBadge(hash, count) {
      const link = links.get(hash);
      if (!link) return;
      link.querySelector('.badge')?.remove();
      if (count > 0) link.append(el('span', { class: 'badge', 'aria-label': `${count} avisos` }, String(count)));
    },
    destroy() {
      status.destroy();
      element.remove();
    },
  };
}
