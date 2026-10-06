import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { confirmDialog, createAppShell, el, replace, toast, type NavItem } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { clearCostCache } from '../app/costs.ts';
import { mountHome } from './home.ts';
import { mountReservations } from './reservations.ts';
import { mountReservation } from './reservation.ts';
import { mountGuests } from './guests.ts';
import { mountPending } from './pending.ts';
import { mountCalendar } from './calendar.ts';
import { mountSpaces } from './spaces.ts';

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

const ROUTES: Record<string, { title: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', mount: mountHome },
  '#/reservas': { title: 'Reservas', mount: mountReservations },
  [PENDING]: { title: 'Por resolver', mount: mountPending },
  '#/calendario': { title: 'Calendario', mount: mountCalendar },
  '#/huespedes': { title: 'Huéspedes', mount: mountGuests(null) },
  '#/espacios': { title: 'Espacios y camas', mount: mountSpaces },
};

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** Ruta exacta o con identificador: `#/reservas/<id>` (ficha) y `#/huespedes/<id de evento>`. `base` marca la navegación activa. */
function resolve(hash: string): { title: string; mount: ViewMount; base: string } {
  const exact = ROUTES[hash];
  if (exact) return { ...exact, base: hash };
  const reservation = new RegExp(`^#/reservas/(${UUID})$`, 'i').exec(hash);
  if (reservation) return { title: 'Reserva', mount: mountReservation(reservation[1]!.toLowerCase()), base: '#/reservas' };
  const guests = new RegExp(`^#/huespedes/(${UUID})$`, 'i').exec(hash);
  if (guests) return { title: 'Huéspedes', mount: mountGuests(guests[1]!.toLowerCase()), base: '#/huespedes' };
  return { ...ROUTES['#/']!, base: '#/' };
}

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Booking. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  const shell = createAppShell(root, {
    appName: 'Booking',
    markIcon: 'bed',
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
  });
  const { main } = shell;

  function paintBanners(status: SyncStatus): void {
    const here = location.hash === PENDING;
    shell.setBanners(status, {
      hideConflicts: here,
      hideRejected: here,
      onResolveConflicts: () => navigate(PENDING),
      onShowRejected: () => navigate(PENDING),
      onRetry: syncNow,
      describeError: (error) => describeError(error),
      updateApply,
    });
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
    unmountView?.();
    window.removeEventListener('hashchange', route);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
