import type { SyncStatus } from '@ikisai/sync-client';
import { el, replace } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { createStatusBar, statusBanners, type StatusBannersOptions, type StatusBarOptions } from '../status/status-bar.ts';
import { kt } from '../i18n/i18n.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';
import type { AppLauncher } from './launcher.ts';

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
  /** Lanzador de apps (`createAppLauncher`): la marca de la cabecera pasa a ser un botón que lo abre. */
  launcher?: AppLauncher;
  /**
   * Secciones que van en «Más» (portales, U5 de Guests): en móvil, la barra lleva `nav` y un botón «Más» que abre una
   * hoja con estas; en escritorio, la barra lateral las enseña todas, debajo, en su propio grupo.
   */
  more?: readonly NavItem[];
  /**
   * Máximo de entradas en la barra inferior contando «Más» (los portales: 5). Lo que sobre de `nav` pasa a «Más».
   * Sin límite por defecto (las apps internas no cambian).
   */
  maxNav?: number;
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
  /** Cambia las secciones (portales: según los módulos que active el organizador). */
  setNav(nav: readonly NavItem[], more?: readonly NavItem[]): void;
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
      options.launcher
        ? (() => { const b = el('button', { type: 'button', class: 'mark markbtn', id: 'appLauncher' }, icon(options.markIcon ?? 'mark', 20)); options.launcher.attach(b); return b; })()
        : el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 20)),
      el('h1', null, `Ikisai ${options.appName}`, subtitle),
    ),
    status.element,
    el('div', { class: 'tools' }, ...(options.tools ?? []), logoutButton),
  );

  const links = new Map<string, HTMLElement>();
  const badges = new Map<string, number>();
  let mainItems: readonly NavItem[] = options.nav;
  let extraItems: readonly NavItem[] = [];
  let currentRoute = '';
  let moreSheet: Sheet | null = null;
  const nav = el('nav', { class: 'nav', 'aria-label': kt('Secciones') });
  const moreButton = el('button', { type: 'button', class: 'navbtn navmore', 'aria-haspopup': 'dialog', onclick: () => openMore() }) as HTMLButtonElement;

  function navLink(item: NavItem, extra = false): HTMLElement {
    const count = badges.get(item.hash) ?? item.badge ?? 0;
    const link = el('a', { class: `navbtn${extra ? ' navextra' : ''}`, href: item.hash, dataset: { hash: item.hash }, onclick: (event: Event) => { event.preventDefault(); navigate(item.hash); } },
      icon(item.icon),
      el('span', null, item.label),
      item.soon ? el('span', { class: 'soon', 'aria-label': kt('pendiente de la fase 1') }, kt('fase 1')) : null,
      count ? el('span', { class: 'badge', 'aria-label': kt('{count} avisos', { count }) }, String(count)) : null,
    );
    links.set(item.hash, link);
    return link;
  }
  const isActive = (item: NavItem, hash: string) => (item.matches ?? [item.hash]).includes(hash);

  function paintMoreButton(): void {
    const count = extraItems.reduce((n, i) => n + (badges.get(i.hash) ?? i.badge ?? 0), 0);
    replace(moreButton, icon('more'), el('span', null, kt('Más')), count ? el('span', { class: 'badge', 'aria-label': kt('{count} avisos', { count }) }, String(count)) : null);
    if (extraItems.some((i) => isActive(i, currentRoute))) moreButton.setAttribute('aria-current', 'page');
    else moreButton.removeAttribute('aria-current');
  }

  /** Reparte `nav` + `more` entre la barra y «Más» según `maxNav`, y repinta. */
  function paintNav(items: readonly NavItem[], more: readonly NavItem[] = []): void {
    const max = options.maxNav ?? Infinity;
    const needsMore = more.length > 0 || items.length > max;
    const visible = needsMore ? items.slice(0, Math.max(1, Math.min(items.length, max - 1))) : items;
    mainItems = visible;
    extraItems = [...items.slice(visible.length), ...more];
    links.clear();
    replace(nav,
      ...visible.map((item) => navLink(item)),
      needsMore ? moreButton : null,
      extraItems.length ? el('div', { class: 'navextra-group', role: 'group', 'aria-label': kt('Más') }, ...extraItems.map((item) => navLink(item, true))) : null,
      options.navFoot ? el('div', { class: 'navfoot' }, options.navFoot) : null,
    );
    nav.hidden = !items.length && !more.length;
    element?.classList.toggle('nonav', nav.hidden);
    nav.classList.toggle('has-more', needsMore);
    paintMoreButton();
    setRoute(currentRoute);
  }

  /** «Más» en móvil: hoja con el resto de secciones. */
  function openMore(): void {
    moreSheet = openSheet({
      title: kt('Más'),
      body: el('ul', { class: 'navmore-list' }, ...extraItems.map((item) => {
        const count = badges.get(item.hash) ?? item.badge ?? 0;
        return el('li', null, el('a', {
          class: 'navmore-item', href: item.hash, dataset: { hash: item.hash }, 'aria-current': isActive(item, currentRoute) ? 'page' : null,
          onclick: (event: Event) => { event.preventDefault(); void moreSheet?.close(true); navigate(item.hash); },
        }, icon(item.icon, 20), el('span', null, item.label), count ? el('span', { class: 'badge' }, String(count)) : null, icon('chevronRight', 16)));
      })),
    });
  }

  function setRoute(hash: string): void {
    currentRoute = hash;
    for (const item of [...mainItems, ...extraItems]) {
      const link = links.get(item.hash);
      if (!link) continue;
      if (isActive(item, hash)) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (extraItems.some((i) => isActive(i, hash))) moreButton.setAttribute('aria-current', 'page');
    else moreButton.removeAttribute('aria-current');
  }

  const banners = el('div', { class: 'banners' });
  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  let element: HTMLElement | null = null;
  paintNav(options.nav, options.more);
  element = el('div', { class: `shell${nav.hidden ? ' nonav' : ''}` }, header, nav, el('div', null, banners, main));
  replace(root, element);

  return {
    element,
    header,
    nav,
    banners,
    main,
    setRoute,
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
      badges.set(hash, count);
      const link = links.get(hash);
      if (link) {
        link.querySelector('.badge')?.remove();
        if (count > 0) link.append(el('span', { class: 'badge', 'aria-label': kt('{count} avisos', { count }) }, String(count)));
      }
      paintMoreButton();
    },
    setNav(items, more) { paintNav(items, more); },
    destroy() {
      status.destroy();
      element!.remove();
    },
  };
}
