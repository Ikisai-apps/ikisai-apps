import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, createUsage, el, openFeedbackCenter, replace, toast,
  type LauncherCatalog, type NavItem,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { setUsage } from '../app/usage.ts';
import { fb } from './feedback.ts';
import { mountHome } from './home.ts';
import { mountRecipes } from './recipes.ts';
import { mountEquipment } from './equipment.ts';
import { mountEvents } from './events.ts';
import { mountMenu, mountMenus, type MenuTab } from './menus.ts';
import { mountConflicts } from './conflicts.ts';

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
  { hash: '#/eventos', label: 'Eventos', icon: 'calendar' },
  { hash: '#/menus', label: 'Menús', icon: 'menu' },
  { hash: '#/recetario', label: 'Recetario', icon: 'chef' },
  { hash: '#/maquinaria', label: 'Maquinaria', icon: 'settings' },
];

/** Cada ruta con su pantalla para «Sugerencias y QA»: `screen` es el `data-feedback-id` de `main` y el nodo por defecto. */
const ROUTES: Record<string, { title: string; screen: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', screen: 'food.inicio', mount: mountHome },
  '#/recetario': { title: 'Recetario', screen: 'food.recetario', mount: mountRecipes },
  '#/maquinaria': { title: 'Maquinaria', screen: 'food.maquinaria', mount: mountEquipment },
  '#/conflictos': { title: 'Conflictos', screen: 'food.conflictos', mount: mountConflicts },
  '#/eventos': { title: 'Eventos', screen: 'food.eventos', mount: mountEvents },
  '#/menus': { title: 'Menús', screen: 'food.menus', mount: mountMenus },
};

const NAV_MARKS: Record<string, Record<'feedbackId' | 'feedbackLabel', string>> = {
  '#/': { feedbackId: 'food.navegacion.inicio', feedbackLabel: 'Inicio' },
  '#/eventos': { feedbackId: 'food.navegacion.eventos', feedbackLabel: 'Eventos' },
  '#/menus': { feedbackId: 'food.navegacion.menus', feedbackLabel: 'Menús' },
  '#/recetario': { feedbackId: 'food.navegacion.recetario', feedbackLabel: 'Recetario' },
  '#/maquinaria': { feedbackId: 'food.navegacion.maquinaria', feedbackLabel: 'Maquinaria' },
};

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Food. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // «Sugerencias y QA» (kit 0.18, demo/adopcion.ts): modo «Señalar para comentar», revisor de QA y uso de funcionalidades.
  // Los dos interruptores y la entrada «Sugerencias y QA» van en el panel del lanzador: ningún botón propio en la cabecera.
  const api = client.api.bind(client);
  const userId = () => client.bootstrap()?.profile.userId ?? null;
  let screen = { id: 'food.inicio', label: 'Inicio' };
  let catalog: LauncherCatalog | null = null;
  const feedback = createFeedback({
    app: 'food',
    api,
    userId,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const s = client.status();
      return { pending: s.pendingCommands + s.pendingBlobs, conflicts: s.conflicts, lastSyncAt: s.lastPullAt, cursor: s.cursor };
    },
    fallbackNode: () => ({ id: screen.id, path: [screen.label] }),
  });
  const review = createFeedbackReview({ api, app: 'food', appDomain: (id) => catalog?.items.find((a) => a.id === id)?.domain });
  const usageCollector = createUsage({ app: 'food', api, userId });
  setUsage(usageCollector);
  const offSessionEnd = client.onSessionEnd((id) => { void feedback.clear(id); void usageCollector.clear(id); });
  // La marca de la cabecera abre el lanzador común: las demás apps de la cuenta, sin volver a pedir contraseña.
  const launcher = createAppLauncher({
    current: 'food',
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback,
    review,
    center: () => { openFeedbackCenter({ api, app: 'food', canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });
  const shell = createAppShell(root, {
    appName: 'Food',
    markIcon: 'chef',
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    launcher,
  });
  const { main } = shell;

  // Piezas que crea el kit (no admiten atributos propios): se marcan una vez creadas.
  fb(shell.header, { feedbackId: 'food.cabecera', feedbackLabel: 'Cabecera' });
  const launcherButton = shell.header.querySelector('#appLauncher');
  if (launcherButton) fb(launcherButton, { feedbackId: 'food.cabecera.lanzador', feedbackLabel: 'Lanzador de apps' });
  const statusBar = shell.header.querySelector('#syncStatus');
  if (statusBar) fb(statusBar, { feedbackId: 'food.cabecera.estado', feedbackLabel: 'Estado de sincronización' });
  const logoutButton = shell.header.querySelector('#logout');
  if (logoutButton) fb(logoutButton, { feedbackId: 'food.cabecera.cerrar_sesion', feedbackLabel: 'Cerrar sesión' });
  fb(shell.nav, { feedbackId: 'food.navegacion', feedbackLabel: 'Navegación' });
  for (const link of shell.nav.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    const mark = NAV_MARKS[link.getAttribute('href') ?? ''];
    if (mark) fb(link, mark);
  }
  fb(shell.banners, { feedbackId: 'food.avisos', feedbackLabel: 'Avisos' });

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
    // `#/menus/<id>` es la ficha de un menú y `#/menus/<id>/compra` una de sus pestañas; el resto son rutas fijas.
    const [, menuId, menuTab] = hash.match(/^#\/menus\/([0-9a-f-]{36})(?:\/(compra|preparacion|organizador|cierre))?$/i) ?? [];
    const entry = menuId ? { title: 'Menú', screen: 'food.menu', mount: mountMenu(menuId, (menuTab as MenuTab | undefined) ?? 'menu') } : ROUTES[hash] ?? ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(menuId ? '#/menus' : hash);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout });
    screen = { id: entry.screen, label: entry.title };
    main.setAttribute('data-feedback-id', screen.id);
    main.setAttribute('data-feedback-label', screen.label);
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
    offSessionEnd();
    feedback.destroy();
    review.destroy();
    usageCollector.destroy();
    setUsage(null);
    shell.destroy();
    replace(root, el('div'));
  };
}
