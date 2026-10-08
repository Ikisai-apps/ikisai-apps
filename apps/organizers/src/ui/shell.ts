/**
 * Cabecera del kit con el lanzador (sesión única) y «Ayuda y sugerencias», rutas del portal y botón «Guarda tu acceso».
 * Dos niveles (API.md §9): Mis retiros → Retiro (Resumen · Asistentes · Cocina) → ficha del asistente.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { i18n, t } from '../app/i18n.ts';
import { install } from '../app/install.ts';
import { confirmDialog, createAppLauncher, createAppShell, createLanguageSelect, createUsage, el, replace, type LauncherCatalog, type Usage } from '@ikisai/ui-kit';
import { createPortalApi, type PortalApi } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { loadCommonTexts } from '../app/common-texts.ts';
import { mountRetreats } from './retreats.ts';
import { mountRetreat, type RetreatTab } from './retreat.ts';
import { mountGuest } from './guest.ts';
import { openHelp } from './help.ts';
import { mountAccessButton } from './access.ts';

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
}

export type ViewMount = (ctx: ViewContext) => () => void;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RETREAT = new RegExp(`^#/retiro/(${UUID})(?:/(fechas|asistentes|cocina))?$`, 'i');
const GUEST = new RegExp(`^#/retiro/(${UUID})/asistentes/(${UUID}|nuevo)$`, 'i');

export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  const userId = client.bootstrap()?.profile.userId ?? 'anon';
  const api = createPortalApi(client);
  const apiCall = client.api.bind(client);
  // Uso sin persona en los portales (contrato §3.8): sin aviso.
  const usage = createUsage({ app: 'organizers', api: apiCall, userId: () => userId, notice: false });
  const offSessionEnd = client.onSessionEnd((id) => { void cache.clearUser(id); void usage.clear(id); });
  let currentReservation: string | null = null;
  void loadCommonTexts(client);

  const launcher = createAppLauncher({
    current: 'organizers',
    fetchApps: async () => client.api<LauncherCatalog>('/apps'),
    center: () => { void openHelp({ client, api, userId, reservationId: currentReservation }); },
    centerLabel: t('Ayuda y sugerencias'),
    centerText: t('Cuéntanos un problema o una idea sobre la aplicación, tu retiro o un espacio.'),
  });
  const shell = createAppShell(root, {
    appName: 'Organizers',
    markIcon: 'organizer',
    tools: [createLanguageSelect(i18n, { attrs: { id: 'langSelect', 'data-feedback-id': 'organizers.cabecera.idioma', 'data-feedback-label': 'Idioma' } })],
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: [],
    onLogout: logout,
    navigate,
    launcher,
  });
  const { main } = shell;
  shell.header.setAttribute('data-feedback-id', 'organizers.cabecera');
  shell.header.setAttribute('data-feedback-label', 'Cabecera');
  const access = mountAccessButton(root, api);

  let unmountView: (() => void) | null = null;
  let firstRoute = true;

  async function logout(): Promise<void> {
    const ok = await confirmDialog({
      title: t('¿Salir de Organizers?'),
      text: t('Para volver a entrar necesitarás el enlace que te enviamos.'),
      confirmLabel: t('Salir'),
    });
    if (!ok) return;
    try { await client.logout(); } finally { ctx.onLogout(); }
  }

  function navigate(hash: string, replaceHistory = false): void {
    if (replaceHistory) {
      history.replaceState(null, '', hash);
      route();
    } else if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route(): void {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    const guest = hash.match(GUEST);
    const retreat = hash.match(RETREAT);
    unmountView?.();
    unmountView = null;
    replace(main);
    const view: ViewContext = { client, api, main, usage, userId, navigate };
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
      // Con un solo retiro, la primera vez se abre su ficha directamente (API.md §9.2).
      unmountView = mountRetreats({ autoOpen: firstRoute })(view);
      main.setAttribute('data-feedback-id', 'organizers.retiros');
      main.setAttribute('data-feedback-label', 'Mis retiros');
      document.title = t('Mis retiros · Ikisai Organizers');
    }
    // En Mis retiros y en la ficha del retiro; en los formularios y en las fechas taparía el estado del guardado.
    access.setVisible(!guest && retreat?.[2]?.toLowerCase() !== 'fechas');
    if (firstRoute && ctx.fromLink && install.shouldPromote()) setTimeout(() => { if (install.shouldPromote()) install.openSheet(); }, 800);
    firstRoute = false;
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  const offStatus = client.onStatus(() => {
    if (!client.session()) ctx.onLogout();
  });
  window.addEventListener('hashchange', route);
  route();

  return () => {
    offStatus();
    offSessionEnd();
    usage.destroy();
    access.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', route);
    shell.destroy();
    replace(root, el('div'));
  };
}
