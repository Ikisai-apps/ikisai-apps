import type { SyncStatus } from '@ikisai/sync-client';
import { clearGuideLink, readGuideLink } from '../guide/link.ts';
import { createFieldPointer } from '../guide/point.ts';
import { createGuide } from '../guide/guide.ts';
import { flowGuideSource, type GuideApiClient, type GuideSource } from '../guide/flow-source.ts';
import { el, replace } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { createStatusBar, statusBanners, type StatusBannersOptions, type StatusBarOptions } from '../status/status-bar.ts';
import { kt } from '../i18n/i18n.ts';
import { installKeyboardInsets } from '../overlay/keyboard.ts';
import { installBackNavigation, type BackNavigationOptions } from './back-navigation.ts';
import { openSheet, type Sheet } from '../overlay/sheet.ts';
import type { AppLauncher } from './launcher.ts';
import { createAppMenu, type AppMenu, type AppMenuOptions } from './app-menu.ts';
import { clearReturnTo, readReturnTo } from './return-to.ts';

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
  /**
   * Nombre corto para la barra de abajo («Cobro» por «Pedido y cobro»). Se usa solo si los nombres no caben (seis secciones a
   * 390 px); el lector de pantalla sigue diciendo el nombre entero.
   */
  short?: string;
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
  /** El botón de salir también en el móvil (portales). Por defecto, solo en el ordenador. */
  logoutOnMobile?: boolean;
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
   * «Atrás» dentro de la app (FB_2026_025): vuelve a la pantalla anterior o al inicio, y desde el inicio pregunta
   * «¿Cerrar la app?». Por defecto activado; `false` lo desactiva; `{ home }` fija la URL del inicio.
   */
  backNavigation?: boolean | BackNavigationOptions;
  /**
   * Máximo de entradas en la barra inferior contando «Más» (los portales: 5). Lo que sobre de `nav` pasa a «Más».
   * Sin límite por defecto (las apps internas no cambian).
   */
  maxNav?: number;
  /**
   * Menú lateral común (MUELA-013, K7): la marca abre el cajón del menú en vez de la hoja de apps (el lanzador va dentro,
   * en `menu.launcher`). Sin esta opción, la cabecera es la de siempre.
   */
  menu?: AppMenuOptions;
  /**
   * Búsqueda en la cabecera (K8): lupa en el móvil y caja «Buscar en {app}… Ctrl K» en el ordenador. La app abre su
   * paleta en `onOpen` (Ctrl K lo sigue llevando la paleta).
   */
  search?: { label?: string; onOpen: () => void; feedbackId?: string };
  /**
   * En el ordenador, la navegación: `side` (columna, como siempre) o `bar` (K12: la barra de abajo también en el
   * ordenador, horizontal). Con la columna del menú (`menu.column`), siempre `bar`.
   */
  navLayout?: 'side' | 'bar';
  /**
   * «‹ Volver a…» (K9): si se llegó desde otra app con `?desde=…&volver=…&titulo=…`, una línea arriba vuelve allí, y
   * «atrás» desde el inicio también (sin preguntar «¿Cerrar la app?»). Por defecto, no. Ver `withReturnTo`.
   */
  returnTo?: boolean | { feedbackId?: string };
  /**
   * Guiado (`src/guide/`): al llegar con `?campo=…&paso=…` (`withGuideLink`), una línea arriba explica el paso y el campo se
   * señala. Implica `returnTo`. Por defecto, no.
   * Con `?guia=<ejecución>` y `client` (el `SyncClient` de la app) y `app`, monta la guía completa (`createGuide`) con los
   * pasos de esa app, leídos de Flow (`flow.guide_read`) y confirmados en Flow (`flow.guide_confirm`), sin valores.
   * Una app lo monta en una línea: `guide: { feedbackId: '<app>.cabecera.guia' }` (nivel mínimo). El id va bajo `cabecera`, raíz que
   * todas las apps ya reconocen como pieza de la cáscara; sus botones son `.ver` y `.cerrar`. Guía completa: añadir `client` y `app`.
   */
  guide?: boolean | { feedbackId?: string; client?: GuideApiClient; app?: string; source?: GuideSource };
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
  /** El menú lateral, si se pidió (`menu`): abrir, cerrar, `refresh()` tras cambiar recientes o recuentos. */
  menu: AppMenu | null;
  destroy(): void;
}

/** Cabecera, navegación (inferior en móvil, lateral en escritorio), zona de banners y `<main>`. */
export function createAppShell(root: HTMLElement, options: AppShellOptions): AppShell {
  installKeyboardInsets();
  if (options.backNavigation !== false) installBackNavigation({ ...(typeof options.backNavigation === 'object' ? options.backNavigation : {}), ...(options.returnTo || options.guide ? { returnTo: true } : {}) });
  const origin = options.returnTo || options.guide ? readReturnTo() : null;
  const returnLink = origin
    ? el('a', { class: 'return-link', href: origin.url, ...(typeof options.returnTo === 'object' && options.returnTo.feedbackId ? { 'data-feedback-id': options.returnTo.feedbackId, 'data-feedback-label': 'Volver a la otra app' } : {}), onclick: () => { clearReturnTo(); clearGuideLink(); } },
      icon('chevronLeft', 18), el('span', null, kt('Volver a {place}', { place: origin.title ?? origin.from ?? kt('la app anterior') })))
    : null;
  const navigate = options.navigate ?? ((hash: string) => { location.hash = hash; });
  const guideLink = options.guide ? readGuideLink() : null;
  const guideOptions = typeof options.guide === 'object' ? options.guide : {};
  const guideSource = guideOptions.source ?? (guideOptions.client ? flowGuideSource(guideOptions.client, { app: guideOptions.app ?? null }) : null);
  const guideRun = guideLink?.run ?? null;
  // Guía completa si hay ejecución y de dónde leerla; si no, el nivel mínimo (el campo señalado).
  const guide = guideRun && guideSource
    ? createGuide({
      load: () => guideSource.load(guideRun),
      onConfirmed: (step, info) => guideSource.confirm(guideRun, step, info),
      onSkipped: guideSource.skip ? (step) => guideSource.skip!(guideRun, step) : undefined,
      navigate: (route) => navigate(route),
      feedbackId: guideOptions.feedbackId,
    })
    : null;
  const pointer = !guide && guideLink?.field ? createFieldPointer(guideLink, { feedbackId: guideOptions.feedbackId }) : null;
  const subtitle = el('small', { id: 'shellSubtitle' }, options.subtitle ?? '');
  const status = createStatusBar(options.status ?? {});
  const logoutButton = options.onLogout
    ? el('button', { class: `iconbtn${options.logoutOnMobile ? '' : ' desktop-only'}`, type: 'button', id: 'logoutButton', 'aria-label': kt('Cerrar sesión'), title: kt('Cerrar sesión'), onclick: () => void options.onLogout?.() }, icon('logout'))
    : null;
  const menu: AppMenu | null = options.menu
    ? createAppMenu(options.menu, { appName: options.appName, onLogout: options.onLogout, onSync: options.status?.onSync, navigate: (hash) => navigate(hash) })
    : null;
  if (menu && options.status?.client) {
    menu.setStatus(options.status.client.status());
    options.status.client.onStatus((s) => menu.setStatus(s));
  } else if (menu && options.status?.status) menu.setStatus(options.status.status);
  const searchLabel = options.search?.label ?? kt('Buscar en {app}…', { app: options.appName });
  const search = options.search
    ? el('button', { type: 'button', class: 'appmenu-search', 'aria-haspopup': 'dialog', 'aria-label': searchLabel, ...(options.search.feedbackId ? { 'data-feedback-id': options.search.feedbackId, 'data-feedback-label': 'Buscar' } : {}), onclick: () => options.search!.onOpen() },
      icon('search', 20), el('span', { class: 'appmenu-searchtext', 'aria-hidden': 'true' }, searchLabel), el('kbd', { class: 'appmenu-searchkey', 'aria-hidden': 'true' }, 'Ctrl K'))
    : null;
  const header = el('header', { class: 'topbar' },
    el('div', { class: 'brand' },
      menu
        ? (() => { const b = el('button', { type: 'button', class: 'mark markbtn', id: 'appLauncher' }, icon(options.markIcon ?? 'mark', 20)); menu.attach(b); return b; })()
        : options.launcher
          ? (() => { const b = el('button', { type: 'button', class: 'mark markbtn', id: 'appLauncher' }, icon(options.markIcon ?? 'mark', 20)); options.launcher.attach(b); return b; })()
          : el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(options.markIcon ?? 'mark', 20)),
      // «Ikisai» se esconde a la vista (no al lector) si el nombre no cabe junto a las herramientas (revisión móvil del 27-10).
      el('h1', null, el('span', { class: 'brand-ikisai' }, 'Ikisai '), options.appName, subtitle),
    ),
    search,
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
      el('span', { class: 'navlabel' }, item.label),
      item.short ? el('span', { class: 'navshort', 'aria-hidden': 'true' }, item.short) : null,
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
  const bar = options.navLayout === 'bar' || !!menu?.column;
  /** Si el título o los nombres de la barra no caben: la forma apretada (sin «Ikisai» a la vista; nombres cortos). */
  function fit(): void {
    if (!header.isConnected) return;
    const h1 = header.querySelector('h1');
    header.classList.remove('brand-tight');
    if (h1 && h1.scrollWidth > h1.clientWidth + 1) header.classList.add('brand-tight');
    nav.classList.remove('navtight');
    if (nav.querySelector('.navshort') && [...nav.querySelectorAll<HTMLElement>('.navlabel')].some((s) => s.scrollWidth > s.clientWidth + 1)) nav.classList.add('navtight');
  }
  const fitObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  fitObserver?.observe(header);
  fitObserver?.observe(nav);
  requestAnimationFrame(() => fit());
  element = el('div', { class: `shell${nav.hidden ? ' nonav' : ''}${bar ? ' nav-bar' : ''}${menu ? ' has-appmenu' : ''}${menu?.column ? ' has-appcol' : ''}` }, menu?.column ?? null, header, nav, el('div', { class: menu?.column || bar ? 'shell-content' : null }, returnLink, pointer?.element ?? null, banners, main));
  // La app pinta su pantalla después: el campo se busca cuando aparezca.
  if (pointer) queueMicrotask(() => void pointer.point());
  if (guide) { element.append(guide.element); queueMicrotask(() => void guide.start()); }
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
      menu?.setStatus(next);
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
    menu,
    destroy() {
      fitObserver?.disconnect();
      guide?.destroy();
      menu?.destroy();
      status.destroy();
      element!.remove();
    },
  };
}
