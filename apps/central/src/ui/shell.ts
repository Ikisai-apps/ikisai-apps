import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { confirmDialog, createAppLauncher, createAppShell, el, replace, toast, type LauncherCatalog, type NavItem } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { createAdminApi, type AdminApi } from '../app/admin.ts';
import { mountHome } from './home.ts';
import { mountAccess } from './access.ts';
import { mountConflicts } from './conflicts.ts';
import { mountEntity } from './entity.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  /** Administración común (solo la usa quien es owner de Central). */
  admin: AdminApi;
  isAdmin: boolean;
  navigate(hash: string): void;
  /** Cierra sesión con la misma confirmación que el botón de la cabecera. */
  logout(): Promise<void>;
}

export type ViewMount = (ctx: ViewContext) => () => void;

const ACCESS_ROUTES = ['#/accesos', '#/accesos/alta', '#/accesos/agentes', '#/accesos/registro'];

/** Accesos solo para quien administra el ecosistema (owner de Central). Personas y Cumplimiento llegan en V1-b y V1.1. */
function navFor(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [
    { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', '#/conflictos'] },
    { hash: '#/entidad', label: 'Entidad', icon: 'briefcase' },
  ];
  if (isAdmin) items.push({ hash: '#/accesos', label: 'Accesos', icon: 'lock', matches: ACCESS_ROUTES });
  return items;
}

const ROUTES: Record<string, { title: string; mount: ViewMount; admin?: boolean }> = {
  '#/': { title: 'Inicio', mount: mountHome },
  '#/conflictos': { title: 'Conflictos', mount: mountConflicts },
  '#/entidad': { title: 'Entidad', mount: mountEntity },
  '#/accesos': { title: 'Accesos', mount: mountAccess('cuentas'), admin: true },
  '#/accesos/alta': { title: 'Alta de cuenta', mount: mountAccess('alta'), admin: true },
  '#/accesos/agentes': { title: 'Agentes', mount: mountAccess('agentes'), admin: true },
  '#/accesos/registro': { title: 'Registro de accesos', mount: mountAccess('registro'), admin: true },
};

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Central. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // La marca de la cabecera abre el lanzador común: las demás apps de la cuenta, sin volver a pedir contraseña.
  const launcher = createAppLauncher({ current: 'central', fetchApps: () => client.api<LauncherCatalog>('/apps') });
  const admin = createAdminApi(client);
  const boot = client.bootstrap();
  const isAdmin = boot?.membership.role === 'owner' && boot.profile.kind !== 'agent';
  const shell = createAppShell(root, {
    appName: 'Central',
    markIcon: 'grid',
    subtitle: boot?.profile.displayName ?? '',
    nav: navFor(isAdmin),
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    launcher,
  });
  const { main } = shell;

  function paintBanners(status: SyncStatus): void {
    shell.setBanners(status, {
      hideConflicts: location.hash === '#/conflictos',
      hideRejected: location.hash === '#/conflictos',
      onResolveConflicts: () => navigate('#/conflictos'),
      onShowRejected: () => navigate('#/conflictos'),
      onRetry: syncNow,
      describeError: (error) => describeError(error),
      updateApply,
    });
  }

  function paintStatus(status: SyncStatus): void {
    shell.setSubtitle(client.bootstrap()?.profile.displayName ?? '');
    paintBanners(status);
    if (status.autoMerged > lastAutoMerged) {
      toast('Se incorporaron cambios de otra persona en una fila que editaste.');
    }
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
    if (status.pendingCommands > 0 && !(await confirmDialog({ title: '¿Cerrar sesión?', text: `Tienes ${status.pendingCommands} cambios sin sincronizar. Seguirán en este dispositivo hasta que vuelvas a entrar.`, confirmLabel: 'Cerrar sesión' }))) return;
    try {
      admin.clear();
      await client.logout();
    } finally {
      ctx.onLogout();
    }
  }

  function navigate(hash: string): void {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route(): void {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    const found = ROUTES[hash];
    const allowed = found && (!found.admin || isAdmin);
    const entry = allowed ? found : ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(allowed ? hash : '#/');
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout, admin, isAdmin });
    document.title = `${entry.title} · Ikisai Central`;
    paintBanners(client.status());
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  const offStatus = client.onStatus((status) => {
    if (!client.session()) {
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
