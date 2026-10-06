import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { confirmDialog, createAppShell, el, replace, toast, type NavItem } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { mountHome } from './home.ts';
import { mountRecipes } from './recipes.ts';
import { mountEquipment } from './equipment.ts';
import { mountConflicts } from './conflicts.ts';
import { mountPlaceholder } from './placeholder.ts';

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

const NAV: readonly NavItem[] = [
  { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', '#/conflictos'] },
  { hash: '#/eventos', label: 'Eventos', icon: 'calendar', soon: true },
  { hash: '#/menus', label: 'Menús', icon: 'menu', soon: true },
  { hash: '#/recetario', label: 'Recetario', icon: 'chef' },
  { hash: '#/maquinaria', label: 'Maquinaria', icon: 'settings' },
];

const ROUTES: Record<string, { title: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', mount: mountHome },
  '#/recetario': { title: 'Recetario', mount: mountRecipes },
  '#/maquinaria': { title: 'Maquinaria', mount: mountEquipment },
  '#/conflictos': { title: 'Conflictos', mount: mountConflicts },
  '#/eventos': { title: 'Eventos', mount: mountPlaceholder('Eventos', 'Los retiros confirmados en Booking, con personas, régimen y restricciones.') },
  '#/menus': { title: 'Menús', mount: mountPlaceholder('Menús', 'El menú de cada evento, su lista de compra y su plan de preparación.') },
};

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Food. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  const shell = createAppShell(root, {
    appName: 'Food',
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
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
    const entry = ROUTES[hash] ?? ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(hash);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout });
    document.title = `${entry.title} · Ikisai Food`;
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
