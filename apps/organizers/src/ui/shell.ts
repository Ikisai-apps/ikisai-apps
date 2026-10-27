/**
 * Cabecera del kit con el menú lateral común (kit 0.47: la marca abre el cajón con tus retiros, las pestañas del retiro
 * abierto, las apps de Ikisai con «Ayuda y sugerencias» y «Cerrar sesión») y «‹ Volver a…» (0.48), rutas del portal y botón
 * «Guarda tu acceso». Dos niveles (API.md §9): Mis retiros → Retiro (Resumen · Asistentes · Cocina) → ficha del asistente.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { i18n, t } from '../app/i18n.ts';
import { install } from '../app/install.ts';
import { confirmDialog, createAppLauncher, createAppShell, createLanguageSelect, createUsage, el, icon, registerReveal, replace, type AppMenuSection, type LauncherCatalog, type Usage } from '@ikisai/ui-kit';
import { createPortalApi, type PortalApi, type PortalReservation } from '../app/api.ts';
import { describeError } from '../app/client.ts';
import { dateRange, isCancelled } from '../app/labels.ts';
import { cache } from '../app/cache.ts';
import { loadCommonTexts } from '../app/common-texts.ts';
import { clearPosterImages } from '../app/poster.ts';
import { mountRetreats } from './retreats.ts';
import { mountRetreat, type RetreatTab } from './retreat.ts';
import { mountGuest } from './guest.ts';
import { openHelp } from './help.ts';
import { mountAccessButton } from './access.ts';
import { clearDishPhotos } from './menu.ts';
import { fbMark } from './common.ts';
import { resetCatalog } from '../app/guest-view.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
  /** Se acaba de entrar por un enlace: es el momento de ofrecer la instalación. */
  fromLink?: boolean;
}

export interface ViewContext {
  client: SyncClient;
  api: PortalApi;
  main: HTMLElement;
  usage: Usage;
  userId: string;
  navigate(hash: string, replaceHistory?: boolean): void;
  /** La ficha del retiro dice al menú lateral qué pestañas tiene (con su misma regla de visibilidad); `null` al salir. */
  setMenuRetreat(info: MenuRetreat | null): void;
}

/** El retiro abierto, para la sección «Este retiro» del menú lateral. */
export interface MenuRetreat {
  id: string;
  title: string;
  tabs: Array<{ tab: RetreatTab | 'resumen'; label: string; count?: number }>;
}

export type ViewMount = (ctx: ViewContext) => () => void;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Pestañas de la ficha con ruta propia (`#/retiro/{id}/{pestaña}`); sin pestaña, el Resumen. Para ampliar, aquí. */
const RETREAT_TABS: readonly RetreatTab[] = ['fechas', 'diseno', 'propuesta', 'pagos', 'experiencia', 'ofertas', 'asistentes', 'cocina'];
/** Apartados de la Experiencia con ruta propia (`#/retiro/{id}/experiencia/{apartado}`); solo valen tras `experiencia`. */
const EXPERIENCE_SECTIONS = ['ven', 'programa', 'menu', 'alojamiento', 'materiales', 'preguntas'];
const RETREAT = new RegExp(`^#/retiro/(${UUID})(?:/(${RETREAT_TABS.join('|')})(?:/(${EXPERIENCE_SECTIONS.join('|')}))?)?$`, 'i');
const GUEST = new RegExp(`^#/retiro/(${UUID})/asistentes/(${UUID}|nuevo)$`, 'i');
/**
 * Pestañas donde «Guarda tu acceso» se oculta: en los formularios y en las fechas taparía el estado del guardado. Se ve en
 * Mis retiros, en el Resumen, en Asistentes y en Cocina; nunca en la ficha del asistente.
 */
const ACCESS_HIDDEN: ReadonlySet<string> = new Set(['fechas', 'diseno', 'propuesta', 'pagos', 'experiencia', 'ofertas']);

export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  const userId = client.bootstrap()?.profile.userId ?? 'anon';
  const api = createPortalApi(client);
  const apiCall = client.api.bind(client);
  // Uso sin persona en los portales (contrato §3.8): sin aviso.
  const usage = createUsage({ app: 'organizers', api: apiCall, userId: () => userId, notice: false });
  const offSessionEnd = client.onSessionEnd((id) => { void cache.clearUser(id); void usage.clear(id); clearPosterImages(); clearDishPhotos(); resetCatalog(); });
  let currentReservation: string | null = null;
  void loadCommonTexts(client);

  const launcher = createAppLauncher({
    current: 'organizers',
    fetchApps: async () => client.api<LauncherCatalog>('/apps'),
    center: () => { void openHelp({ client, api, userId, reservationId: currentReservation }); },
    centerLabel: t('Ayuda y sugerencias'),
    centerText: t('Cuéntanos un problema o una idea sobre la aplicación, tu retiro o un espacio.'),
  });
  /** Lo que enseña el menú lateral: los retiros (de la última lectura, también sin red) y el retiro abierto. */
  let menuRetreats: PortalReservation[] = [];
  let menuRetreat: MenuRetreat | null = null;
  function refreshMenuRetreats(): void {
    api.reservations().then((out) => { menuRetreats = out.value.items; shell.menu?.refresh(); }).catch(() => undefined);
  }
  function menuSections(): AppMenuSection[] {
    const out: AppMenuSection[] = [];
    const open = menuRetreat;
    if (open) {
      out.push({
        key: 'retiro', label: open.title, icon: 'organizer', head: open.title, summary: t('Este retiro'),
        rows: open.tabs.map((x) => ({
          label: x.label, href: x.tab === 'resumen' ? `#/retiro/${open.id}` : `#/retiro/${open.id}/${x.tab}`, feedbackId: 'organizers.menu.retiro.pestana',
          count: x.count ? { text: t('{n} por decidir', { n: x.count }), tone: 'warn' as const } : null,
        })),
      });
    }
    // Idioma (revisión móvil del 27-10): en el móvil el selector ES | EN de la cabecera dejaba el título en «Ikis…», así que
    // ahí se elige desde el menú; en pantallas anchas sigue también en la cabecera.
    const LANGS: Record<string, string> = { es: 'Español', en: 'English' };
    out.push({
      key: 'idioma', label: t('Idioma'), icon: 'settings', summary: LANGS[i18n.locale()] ?? i18n.locale(),
      rows: i18n.supported().map((locale) => ({
        label: LANGS[locale] ?? locale, sub: locale === i18n.locale() ? t('En uso') : null,
        onClick: () => i18n.setLocale(locale), feedbackId: 'organizers.menu.idioma.elegir',
      })),
    });
    const active = menuRetreats.filter((r) => !isCancelled(r.status));
    out.push({
      key: 'retiros', label: t('Mis retiros'), icon: 'calendar',
      rows: [
        ...active.slice(0, 6).map((r) => ({ label: r.title, sub: dateRange(r.start_date, r.end_date), href: `#/retiro/${r.id}`, feedbackId: 'organizers.menu.retiros.abrir' })),
        { label: t('Ver todos tus retiros'), icon: 'list' as const, href: '#/', feedbackId: 'organizers.menu.retiros.todos' },
      ],
    });
    return out;
  }

  const shell = createAppShell(root, {
    appName: 'Organizers',
    markIcon: 'organizer',
    tools: [el('div', { class: 'orglang-head' }, createLanguageSelect(i18n, { attrs: { id: 'langSelect', 'data-feedback-id': 'organizers.cabecera.idioma', 'data-feedback-label': 'Idioma' } }))],
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: [],
    navigate,
    onLogout: logout,
    // «Cerrar sesión» del kit (0.49): traducido y también en el móvil. Nunca se ata a la red: sin conexión también tiene
    // que poder borrar la sesión de este dispositivo.
    logoutOnMobile: true,
    status: { client, onSync: () => client.sync(), describeError: (error) => describeError(error) },
    menu: {
      label: t('Menú de Organizers'),
      profile: { name: client.bootstrap()?.profile.displayName ?? '', role: t('Organizas retiros en Ikisai') },
      sections: menuSections,
      launcher,
      feedbackId: 'organizers.menu',
    },
    returnTo: { feedbackId: 'organizers.cabecera.volver_app' },
    // Guiado mínimo del kit (0.68): con `?campo=` señala el campo y con `?paso=` explica el paso y ofrece «Volver a…». Sin
    // `client`, no lee nada de Flow.
    guide: { feedbackId: 'organizers.guia' },
  });
  const logoutButton = shell.header.querySelector<HTMLElement>('#logoutButton');
  if (logoutButton) fbMark(logoutButton, 'organizers.cabecera.cerrar_sesion', 'Cerrar sesión');
  refreshMenuRetreats();
  const { main } = shell;
  shell.header.setAttribute('data-feedback-id', 'organizers.cabecera');
  shell.header.setAttribute('data-feedback-label', 'Cabecera');
  const access = mountAccessButton(root, api);

  let unmountView: (() => void) | null = null;
  let firstRoute = true;
  /** Última ruta pintada: entre apartados de la Experiencia del mismo retiro no se vuelve a montar la ficha. */
  let lastHash: string | null = null;

  async function logout(): Promise<void> {
    // Organizers no borra la cola al salir (sin `clearOnLogout`): lo pendiente se envía al volver a entrar.
    const pending = client.status().pendingCommands;
    const ok = await confirmDialog({
      title: t('¿Salir de Organizers?'),
      text: [t('Para volver a entrar necesitarás el enlace que te enviamos.'),
        pending > 0 ? (pending === 1 ? t('Tienes 1 cambio sin enviar. Se queda en este dispositivo y se enviará cuando vuelvas a entrar.') : t('Tienes {n} cambios sin enviar. Se quedan en este dispositivo y se enviarán cuando vuelvas a entrar.', { n: pending })) : null,
      ].filter(Boolean).join(' '),
      confirmLabel: t('Salir'),
    });
    if (!ok) return;
    try { await client.logout(); } finally { ctx.onLogout(); }
  }

  function navigate(hash: string, replaceHistory = false): void {
    if (replaceHistory) {
      history.replaceState(null, '', hash);
      route(true);
    } else if (location.hash === hash) route(true);
    else location.hash = hash;
  }

  /** `force`: volver a montar aunque solo cambie el apartado de la Experiencia. */
  function route(force = false): void {
    // Lo que va tras «?» (la vuelta de la pasarela, `?pago=ok`) no es parte de la ruta: lo lee y lo limpia la pantalla.
    const hash = (location.hash && location.hash !== '#' ? location.hash : '#/').split('?')[0]!;
    const guest = hash.match(GUEST);
    let retreat = hash.match(RETREAT);
    // Un apartado solo vale tras «experiencia» (`/asistentes/programa` no es una ruta): va a Mis retiros.
    if (retreat?.[3] && retreat[2]?.toLowerCase() !== 'experiencia') retreat = null;
    const before = lastHash?.match(RETREAT) ?? null;
    lastHash = hash;
    if (!force && retreat && unmountView && before && before[1]!.toLowerCase() === retreat[1]!.toLowerCase()
      && before[2]?.toLowerCase() === 'experiencia' && retreat[2]?.toLowerCase() === 'experiencia') {
      window.dispatchEvent(new CustomEvent<string | null>('org-exp-section', { detail: retreat[3]?.toLowerCase() ?? null }));
      return;
    }
    unmountView?.();
    unmountView = null;
    replace(main);
    // «Este retiro» del menú: se queda mientras se esté dentro del mismo retiro (también en la ficha de un asistente).
    const inside = (guest?.[1] ?? retreat?.[1])?.toLowerCase() ?? null;
    if (menuRetreat && menuRetreat.id !== inside) { menuRetreat = null; shell.menu?.refresh(); }
    const view: ViewContext = {
      client, api, main, usage, userId, navigate,
      setMenuRetreat: (info) => { menuRetreat = info; shell.menu?.refresh(); },
    };
    if (guest) {
      currentReservation = guest[1]!.toLowerCase();
      unmountView = mountGuest(currentReservation, guest[2]!.toLowerCase())(view);
      main.setAttribute('data-feedback-id', 'organizers.asistente');
      main.setAttribute('data-feedback-label', 'Asistente');
    } else if (retreat) {
      currentReservation = retreat[1]!.toLowerCase();
      const tab = (retreat[2] ?? 'resumen') as RetreatTab;
      unmountView = mountRetreat(currentReservation, tab)(view);
      main.setAttribute('data-feedback-id', 'organizers.retiro');
      main.setAttribute('data-feedback-label', 'Retiro');
    } else {
      currentReservation = null;
      refreshMenuRetreats();
      // Con un solo retiro, la primera vez se abre su ficha directamente (API.md §9.2).
      unmountView = mountRetreats({ autoOpen: firstRoute })(view);
      main.setAttribute('data-feedback-id', 'organizers.retiros');
      main.setAttribute('data-feedback-label', 'Mis retiros');
      document.title = t('Mis retiros · Ikisai Organizers');
    }
    access.setVisible(!guest && !ACCESS_HIDDEN.has(retreat?.[2]?.toLowerCase() ?? ''));
    if (firstRoute && ctx.fromLink && install.shouldPromote()) setTimeout(() => { if (install.shouldPromote()) install.openSheet(); }, 800);
    firstRoute = false;
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  // Guiado: un campo de otra pestaña de la ficha del retiro abierto se enseña cambiando a esa pestaña (por la raíz de su id).
  // (Raíz → pestaña; el prefijo se arma con `join` para que no cuente como un id de feedback.)
  const TAB_OF: Record<string, string> = {
    'retiro.resumen': 'resumen', fechas: 'fechas', diseno: 'diseno', propuesta: 'propuesta', pagos: 'pagos',
    experiencia: 'experiencia', programa: 'experiencia', alojamiento: 'experiencia', ofertas: 'ofertas', asistentes: 'asistentes', cocina: 'cocina',
  };
  const offReveals = Object.entries(TAB_OF).map(([root, tab]) => registerReveal(['organizers', root].join('.'), () => {
    if (!menuRetreat) return;
    navigate(tab === 'resumen' ? `#/retiro/${menuRetreat.id}` : `#/retiro/${menuRetreat.id}/${tab}`);
  }));

  const offStatus = client.onStatus(() => {
    if (!client.session()) ctx.onLogout();
  });
  const onHash = () => route();
  window.addEventListener('hashchange', onHash);
  route();

  return () => {
    for (const off of offReveals) off();
    offStatus();
    offSessionEnd();
    usage.destroy();
    access.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', onHash);
    shell.destroy();
    replace(root, el('div'));
  };
}
