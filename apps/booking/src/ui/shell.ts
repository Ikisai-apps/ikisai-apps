import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { icon, confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, openFeedbackCenter, el, replace, toast, type LauncherCatalog, type NavItem } from '@ikisai/ui-kit';
import { describeError, isLocalError, LOCAL_ERROR_MESSAGE, technicalDetail } from '../app/client.ts';
import { clearCostCache } from '../app/costs.ts';
import { mountHome } from './home.ts';
import { mountReservations } from './reservations.ts';
import { mountReservation } from './reservation.ts';
import { mountGuests } from './guests.ts';
import { mountPending } from './pending.ts';
import { mountCalendar } from './calendar.ts';
import { mountSpaces } from './spaces.ts';
import { mountRates } from './rates.ts';
import { mountSes } from './ses.ts';
import { mountProposalEditor } from './proposalEditor.ts';
import { mountProposalDocument } from './proposalDoc.ts';
import { fbMark } from './feedback.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  navigate(hash: string): void;
  /** Cierra sesión con la misma confirmación que el botón de la cabecera. */
  logout(): Promise<void>;
}

export type ViewMount = (ctx: ViewContext) => () => void;

const PENDING = '#/pendientes';

const NAV: readonly NavItem[] = [
  { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', PENDING] },
  { hash: '#/reservas', label: 'Reservas', icon: 'list' },
  { hash: '#/calendario', label: 'Calendario', icon: 'calendar' },
  { hash: '#/huespedes', label: 'Huéspedes', icon: 'people' },
];

const ROUTES: Record<string, { title: string; slug: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', slug: 'inicio', mount: mountHome },
  '#/reservas': { title: 'Reservas', slug: 'reservas', mount: mountReservations },
  [PENDING]: { title: 'Por resolver', slug: 'pendientes', mount: mountPending },
  '#/calendario': { title: 'Calendario', slug: 'calendario', mount: mountCalendar },
  '#/huespedes': { title: 'Huéspedes', slug: 'huespedes', mount: mountGuests(null) },
  '#/espacios': { title: 'Espacios y camas', slug: 'espacios', mount: mountSpaces },
  '#/tarifas': { title: 'Tarifas y condiciones', slug: 'tarifas', mount: mountRates },
  '#/ses': { title: 'SES.HOSPEDAJES', slug: 'ses', mount: mountSes },
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Ruta exacta o con identificador: `#/reservas/<id>` (ficha) y `#/huespedes/<id de evento>`. `base` marca la navegación activa. */
function resolve(hash: string): { title: string; slug: string; mount: ViewMount; base: string } {
  const exact = ROUTES[hash];
  if (exact) return { ...exact, base: hash };
  const reservation = new RegExp(`^#/reservas/(${UUID})$`, 'i').exec(hash);
  if (reservation) return { title: 'Reserva', slug: 'reserva', mount: mountReservation(reservation[1]!.toLowerCase()), base: '#/reservas' };
  const proposal = new RegExp(`^#/propuesta/(${UUID})(/documento)?$`, 'i').exec(hash);
  if (proposal) {
    const id = proposal[1]!.toLowerCase();
    return proposal[2] ? { title: 'Propuesta', slug: 'propuesta', mount: mountProposalDocument(id), base: '#/reservas' } : { title: 'Propuesta', slug: 'propuesta', mount: mountProposalEditor(id), base: '#/reservas' };
  }
  const guests = new RegExp(`^#/huespedes/(${UUID})$`, 'i').exec(hash);
  if (guests) return { title: 'Huéspedes', slug: 'huespedes', mount: mountGuests(guests[1]!.toLowerCase()), base: '#/huespedes' };
  return { ...ROUTES['#/']!, base: '#/' };
}

/** Raíz de la ruta de etiquetas por pantalla, con ids literales (el catálogo de la publicación solo recoge literales). */
function markScreen(main: HTMLElement, slug: string, title: string): { id: string; label: string } {
  switch (slug) {
    case 'inicio': fbMark(main, 'booking.inicio', 'Inicio'); return { id: 'booking.inicio', label: 'Inicio' };
    case 'reservas': fbMark(main, 'booking.reservas', 'Reservas'); return { id: 'booking.reservas', label: 'Reservas' };
    case 'reserva': fbMark(main, 'booking.reserva', 'Reserva'); return { id: 'booking.reserva', label: 'Reserva' };
    case 'pendientes': fbMark(main, 'booking.pendientes', 'Pendientes'); return { id: 'booking.pendientes', label: 'Pendientes' };
    case 'calendario': fbMark(main, 'booking.calendario', 'Calendario'); return { id: 'booking.calendario', label: 'Calendario' };
    case 'huespedes': fbMark(main, 'booking.huespedes', 'Huéspedes'); return { id: 'booking.huespedes', label: 'Huéspedes' };
    case 'espacios': fbMark(main, 'booking.espacios', 'Espacios y camas'); return { id: 'booking.espacios', label: 'Espacios y camas' };
    case 'tarifas': fbMark(main, 'booking.tarifas', 'Tarifas y condiciones'); return { id: 'booking.tarifas', label: 'Tarifas y condiciones' };
    case 'propuesta': fbMark(main, 'booking.propuesta', 'Propuesta'); return { id: 'booking.propuesta', label: 'Propuesta' };
    case 'ses': fbMark(main, 'booking.ses', 'SES.HOSPEDAJES'); return { id: 'booking.ses', label: 'SES.HOSPEDAJES' };
    default: fbMark(main, 'booking.inicio', title); return { id: 'booking.inicio', label: title };
  }
}

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Booking. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // «Sugerencias y QA»: modo «Señalar para comentar» (se enciende desde el lanzador), revisor y centro de reportes.
  let screen = { id: 'booking.inicio', label: 'Inicio' };
  const feedback = createFeedback({
    app: 'booking',
    api: client.api.bind(client),
    userId: () => client.bootstrap()?.profile.userId ?? null,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const status = client.status();
      return { pending: status.pendingCommands + status.pendingBlobs, conflicts: status.conflicts, lastSyncAt: status.lastPullAt, cursor: status.cursor };
    },
    fallbackNode: () => ({ id: screen.id, path: [screen.label] }),
  });
  const review = createFeedbackReview({
    api: client.api.bind(client),
    app: 'booking',
    appDomain: (id) => catalog?.items.find((app) => app.id === id)?.domain,
  });
  const offSessionEnd = client.onSessionEnd((userId) => { void feedback.clear(userId); });
  let catalog: LauncherCatalog | null = null;

  // La marca de la cabecera abre el lanzador con las apps de la cuenta (sesión única: no pide contraseña).
  const launcher = createAppLauncher({
    current: 'booking',
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback: feedback.mode,
    review: { get: () => review.mode.get(), set: (on) => review.mode.set(on), available: () => review.available() },
    // «Sugerencias y QA» vive en el panel del lanzador (kit 0.18), no en la cabecera
    center: () => { openFeedbackCenter({ api: client.api.bind(client), app: 'booking', canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });
  const shell = createAppShell(root, {
    appName: 'Booking',
    markIcon: 'bed',
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    launcher,
  });
  const { main } = shell;

  // Piezas que crea el kit (no admiten atributos propios): se marcan una vez creadas.
  fbMark(shell.header, 'booking.cabecera', 'Cabecera');
  const launcherButton = shell.header.querySelector('#appLauncher');
  if (launcherButton) fbMark(launcherButton, 'booking.cabecera.lanzador', 'Lanzador de apps');
  const statusBar = shell.header.querySelector('#syncStatus');
  if (statusBar) fbMark(statusBar, 'booking.cabecera.estado', 'Estado de sincronización');
  const logoutButton = shell.header.querySelector('#logoutButton');
  if (logoutButton) fbMark(logoutButton, 'booking.cabecera.cerrar_sesion', 'Cerrar sesión');
  fbMark(shell.nav, 'booking.navegacion', 'Navegación');
  const NAV_IDS: Record<string, [string, string]> = {
    '#/': ['booking.navegacion.inicio', 'Inicio'], '#/reservas': ['booking.navegacion.reservas', 'Reservas'],
    '#/calendario': ['booking.navegacion.calendario', 'Calendario'], '#/huespedes': ['booking.navegacion.huespedes', 'Huéspedes'],
  };
  for (const link of shell.nav.querySelectorAll<HTMLElement>('a.navbtn')) {
    const mark = NAV_IDS[link.dataset.hash ?? ''];
    if (mark) fbMark(link, mark[0], mark[1]);
  }
  fbMark(shell.banners, 'booking.avisos', 'Avisos');

  function paintBanners(status: SyncStatus): void {
    const here = location.hash === PENDING;
    // Un fallo del dispositivo se avisa con un mensaje claro y el texto técnico plegado (el banner del kit no admite detalle).
    const local = status.network === 'error' && status.lastError && isLocalError(status.lastError) ? status.lastError : null;
    const extra = local ? [el('div', { class: 'banner warn', id: 'localErrorBanner', role: 'alert', 'data-feedback-id': 'booking.avisos.error_local', 'data-feedback-label': 'Fallo del dispositivo' },
      icon('warn', 18),
      el('div', null, el('span', null, LOCAL_ERROR_MESSAGE),
        el('details', { class: 'techdetail', 'data-feedback-ignore': '' }, el('summary', null, 'Detalle técnico'), el('code', null, technicalDetail(local)))),
      el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.avisos.error_local.reintentar', 'data-feedback-label': 'Reintentar', onclick: () => void syncNow() }, 'Reintentar'))] : [];
    shell.setBanners(local ? { ...status, lastError: null } : status, {
      hideConflicts: here,
      hideRejected: here,
      onResolveConflicts: () => navigate(PENDING),
      onShowRejected: () => navigate(PENDING),
      onRetry: syncNow,
      describeError: (error) => describeError(error),
      updateApply,
    }, extra);
  }

  function paintStatus(status: SyncStatus): void {
    shell.setSubtitle(client.bootstrap()?.profile.displayName ?? '');
    paintBanners(status);
    if (status.autoMerged > lastAutoMerged) toast('Se incorporaron cambios de otra persona en una fila que editaste.');
    lastAutoMerged = status.autoMerged;
  }

  async function syncNow(): Promise<void> {
    if (!navigator.onLine) {
      toast('Sin conexión: los cambios se enviarán cuando vuelva la red.');
      return;
    }
    try {
      await client.sync();
      const status = client.status();
      if (status.network === 'error' && status.lastError) toast(describeError(status.lastError));
    } catch (error) {
      toast(describeError(error));
    }
  }

  async function logout(): Promise<void> {
    const status = client.status();
    const waiting = status.pendingCommands + status.pendingBlobs;
    if (waiting > 0) {
      // Al salir se retiran de este dispositivo los huéspedes y los importes; sus cambios sin enviar se pierden.
      const leave = await confirmDialog({
        title: 'Hay cambios sin sincronizar',
        text: `Tienes ${waiting} ${waiting === 1 ? 'cambio pendiente' : 'cambios pendientes'} de enviar. Al cerrar sesión se borran de este dispositivo los datos de huéspedes y los importes, y lo que no se haya enviado de ellos se pierde. Sincroniza antes si puedes.`,
        confirmLabel: 'Cerrar sesión',
        cancelLabel: 'Seguir aquí',
        danger: true,
      });
      if (!leave) return;
    }
    try {
      await client.logout();
    } finally {
      clearCostCache(); // los importes no se quedan en el dispositivo
      ctx.onLogout();
    }
  }

  function navigate(hash: string): void {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route(): void {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    const entry = resolve(hash);
    unmountView?.();
    unmountView = null;
    shell.setRoute(entry.base);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout });
    // La pantalla es la raíz de la ruta de etiquetas («Reserva › Acciones › Editar») y el nodo de reserva si no hay nada más cerca.
    screen = markScreen(main, entry.slug, entry.title);
    document.title = `${entry.title} · Ikisai Booking`;
    paintBanners(client.status());
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  const offStatus = client.onStatus((status) => {
    if (!client.session()) {
      clearCostCache();
      ctx.onLogout();
      return;
    }
    paintStatus(status);
  });
  const onUpdate = (event: Event) => {
    updateApply = (event as CustomEvent<{ apply: () => void }>).detail.apply;
    paintBanners(client.status());
  };
  window.addEventListener('ikisai:update-available', onUpdate);
  window.addEventListener('hashchange', route);
  paintStatus(client.status());
  route();

  return () => {
    offStatus();
    offSessionEnd();
    feedback.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', route);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
