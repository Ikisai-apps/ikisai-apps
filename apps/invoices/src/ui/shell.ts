import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, createUsage, el, openFeedbackCenter, replace, toast, type LauncherCatalog, type NavItem } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { mountHome } from './home.ts';
import { mountSuppliers } from './suppliers.ts';
import { mountConflicts } from './conflicts.ts';
import { mountInvoices } from './invoices.ts';
import { mountPurchases } from './purchases.ts';
import { mountAccounting } from './accounting.ts';
import { fb } from './feedback.ts';
import { setUsage } from '../app/usage.ts';
import { clearPendingTexts, startTextQueue } from '../app/text-queue.ts';
import { startRejectionWatcher } from '../app/rejections.ts';

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
  { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', '#/proveedores', '#/conflictos'] },
  { hash: '#/facturas', label: 'Facturas', icon: 'invoice', matches: ['#/facturas'] },
  { hash: '#/compras', label: 'Compras', icon: 'cart' },
  { hash: '#/gestoria', label: 'Gestoría', icon: 'briefcase' },
];

// `screen`: raíz de la ruta de etiquetas de «Sugerencias y QA» (`<main>` lleva `invoices.<screen>`).
const ROUTES: Record<string, { title: string; screen: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', screen: 'invoices.inicio', mount: mountHome },
  '#/proveedores': { title: 'Proveedores', screen: 'invoices.proveedores', mount: mountSuppliers },
  '#/conflictos': { title: 'Conflictos', screen: 'invoices.conflictos', mount: mountConflicts },
  '#/facturas': { title: 'Facturas', screen: 'invoices.facturas', mount: mountInvoices },
  '#/compras': { title: 'Compras', screen: 'invoices.compras', mount: mountPurchases },
  '#/gestoria': { title: 'Gestoría', screen: 'invoices.gestoria', mount: mountAccounting },
};

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Invoices. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // «Sugerencias y QA» (kit 0.18, demo/adopcion.ts): modo «Señalar para comentar», revisor de QA y uso de funcionalidades.
  // Los dos interruptores y la entrada «Sugerencias y QA» van en el panel del lanzador: ningún botón propio en la cabecera.
  const api = client.api.bind(client);
  const userId = () => client.bootstrap()?.profile.userId ?? null;
  let screen = { id: 'invoices.inicio', label: 'Inicio' };
  let catalog: LauncherCatalog | null = null;
  const feedback = createFeedback({
    app: 'invoices',
    api,
    userId,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const s = client.status();
      return { pending: s.pendingCommands + s.pendingBlobs, conflicts: s.conflicts, lastSyncAt: s.lastPullAt, cursor: s.cursor };
    },
    fallbackNode: () => ({ id: screen.id, path: [screen.label] }),
  });
  const review = createFeedbackReview({ api, app: 'invoices', appDomain: (id) => catalog?.items.find((a) => a.id === id)?.domain });
  const usageCollector = createUsage({ app: 'invoices', api, userId });
  setUsage(usageCollector);
  const offSessionEnd = client.onSessionEnd((id) => { void feedback.clear(id); void usageCollector.clear(id); });
  // Lanzador común: la marca de la cabecera abre las apps de la cuenta; con la sesión única no pide contraseña.
  const launcher = createAppLauncher({
    current: 'invoices',
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback,
    review,
    center: () => { openFeedbackCenter({ api, app: 'invoices', canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });
  const shell = createAppShell(root, {
    appName: 'Finance',
    launcher,
    subtitle: client.bootstrap()?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
  });
  const { main } = shell;

  // Piezas que crea el kit (no admiten atributos propios): se marcan una vez creadas.
  fb(shell.header, { feedbackId: 'invoices.cabecera', feedbackLabel: 'Cabecera' });
  const launcherButton = shell.header.querySelector('#appLauncher');
  if (launcherButton) fb(launcherButton, { feedbackId: 'invoices.cabecera.lanzador', feedbackLabel: 'Lanzador de apps' });
  const statusBar = shell.header.querySelector('#syncStatus');
  if (statusBar) fb(statusBar, { feedbackId: 'invoices.cabecera.estado', feedbackLabel: 'Estado de sincronización' });
  const logoutButton = shell.header.querySelector('#logoutButton');
  if (logoutButton) fb(logoutButton, { feedbackId: 'invoices.cabecera.cerrar_sesion', feedbackLabel: 'Cerrar sesión' });
  fb(shell.nav, { feedbackId: 'invoices.navegacion', feedbackLabel: 'Navegación' });
  const NAV_MARKS: Record<string, Record<'feedbackId' | 'feedbackLabel', string>> = {
    '#/': { feedbackId: 'invoices.navegacion.inicio', feedbackLabel: 'Inicio' },
    '#/facturas': { feedbackId: 'invoices.navegacion.facturas', feedbackLabel: 'Facturas' },
    '#/compras': { feedbackId: 'invoices.navegacion.compras', feedbackLabel: 'Compras' },
    '#/gestoria': { feedbackId: 'invoices.navegacion.gestoria', feedbackLabel: 'Gestoría' },
  };
  for (const link of shell.nav.querySelectorAll<HTMLElement>('a.navbtn')) {
    const mark = NAV_MARKS[link.dataset.hash ?? ''];
    if (mark) fb(link, mark);
  }
  fb(shell.banners, { feedbackId: 'invoices.avisos', feedbackLabel: 'Avisos' });

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
    const full = location.hash && location.hash !== '#' ? location.hash : '#/';
    // Enlaces de otras apps (API.md §9.6): la consulta (`#/compras?destino=…`) la lee la vista, no el router.
    const raw = full.split('?')[0] || '#/';
    // `#/facturas/nueva`, `#/facturas/<id>` y `#/facturas/<código>` montan Facturas y abren la hoja correspondiente.
    const hash = raw.startsWith('#/facturas/') ? '#/facturas' : raw;
    const entry = ROUTES[hash] ?? ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(hash);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout });
    screen = { id: entry.screen, label: entry.title };
    main.setAttribute('data-feedback-id', screen.id);
    main.setAttribute('data-feedback-label', screen.label);
    document.title = `${entry.title} · Ikisai Finance`;
    paintBanners(client.status());
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  // Fase 1 del lector: el texto leído al subir va al servidor cuando el documento está subido.
  const offTextQueue = startTextQueue(client);
  // Un «Validar» rechazado se explica y se descarta solo (incidencia del usuario, 9-10-2026).
  const offRejections = startRejectionWatcher(client);
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
    offSessionEnd();
    offTextQueue();
    offRejections();
    if (!client.session()) clearPendingTexts();
    feedback.destroy();
    review.destroy();
    usageCollector.destroy();
    setUsage(null);
    offStatus();
    unmountView?.();
    window.removeEventListener('hashchange', route);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
