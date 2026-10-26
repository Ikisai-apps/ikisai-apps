import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, el, openFeedbackCenter, replace, toast,
  type LauncherCatalog, type NavItem,
} from '@ikisai/ui-kit';
import { APP, TABLES, type ColumnBehavior } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { watchData, type FlowData } from '../app/data.ts';
import { mountHome } from './home.ts';
import { mountProjects } from './projects.ts';
import { mountOrders } from './orders.ts';
import { mountQueue } from './prep.ts';
import { createServiceMode } from './service-mode.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  navigate(hash: string): void;
  /** Flujo (proyecto) en el que se está; `null` en la lista de flujos. */
  projectId: string | null;
}

export type ViewMount = (ctx: ViewContext) => () => void;

/** Rótulos de los roles del núcleo (no son roles de negocio de Flow). */
const ROLE_LABELS: Record<string, string> = { owner: 'Propietario', editor: 'Editor', reader: 'Lector', outsider: 'Outsider' };

/**
 * Vistas por columna. Las columnas de un flujo son DATO (`flow.columns`: clave, rótulo, orden y comportamiento); qué
 * pantalla pinta cada una es aún código, agrupado por comportamiento (API.md, «Cómo se define un flujo nuevo»):
 * `inspect_confirm` → lista de lotes con ficha (en la barra, Pedido y cobro o Servicio), `quick_steps` y `free_task` →
 * cola de unidades con toques.
 */
interface ColumnView { slug: string; icon: string; mount: ViewMount }
const COLUMN_VIEWS: Record<string, ColumnView> = {
  order: { slug: 'caja', icon: 'euro', mount: mountOrders('order') },
  prep: { slug: 'preparacion', icon: 'chef', mount: mountQueue('prep') },
  service: { slug: 'servicio', icon: 'check', mount: mountOrders('service') },
  logistics: { slug: 'logistica', icon: 'list', mount: mountQueue('logistics') },
};
const BEHAVIOR_ICON: Record<ColumnBehavior, string> = { inspect_confirm: 'check', quick_steps: 'board', free_task: 'list' };

interface FlowColumn { key: string; label: string; behavior: ColumnBehavior; position: number; project_id: string; deleted_at: string | null }

/** Barra inferior de un flujo: la casa + sus columnas, en su orden (§2.1). */
function navFor(projectId: string, columns: FlowColumn[]): NavItem[] {
  const base = `#/p/${projectId}`;
  return [
    { hash: base, label: 'Inicio', icon: 'home', matches: [base] },
    ...columns.map((c) => {
      const view = COLUMN_VIEWS[c.key];
      const hash = `${base}/${view?.slug ?? c.key}`;
      return { hash, label: c.label, icon: (view?.icon ?? BEHAVIOR_ICON[c.behavior]) as NavItem['icon'], matches: [hash] };
    }),
  ];
}

/**
 * Cáscara común del kit: cabecera, menú lateral (MUELA-013) con el lanzador de apps y «Sugerencias y QA», «‹ Volver a…»
 * (K9) cuando se llega desde otra app, barra de estado y navegación. Rutas propias de Flow, por ahora solo Inicio.
 */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let updateApply: (() => void) | null = null;
  let screen = { id: 'flow.inicio', label: 'Inicio' };
  let catalog: LauncherCatalog | null = null;

  const api = client.api.bind(client);
  const feedback = createFeedback({
    app: APP,
    api,
    userId: () => client.bootstrap()?.profile.userId ?? null,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const status = client.status();
      return { pending: status.pendingCommands + status.pendingBlobs, conflicts: status.conflicts, lastSyncAt: status.lastPullAt, cursor: status.cursor };
    },
    fallbackNode: () => ({ id: screen.id, path: [screen.label] }),
  });
  const review = createFeedbackReview({ api, app: APP, appDomain: (id) => catalog?.items.find((app) => app.id === id)?.domain });
  const offSessionEnd = client.onSessionEnd((userId) => { void feedback.clear(userId); });
  const launcher = createAppLauncher({
    current: APP,
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback,
    review,
    center: () => { openFeedbackCenter({ api, app: APP, canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });

  const boot = client.bootstrap();
  const service = createServiceMode();
  const shell = createAppShell(root, {
    appName: 'Flow',
    markIcon: 'sync',
    subtitle: boot?.profile.displayName ?? '',
    nav: [],
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    navLayout: 'bar',
    tools: [service.button],
    returnTo: { feedbackId: 'flow.cabecera.volver' },
    menu: {
      label: 'Menú de Flow',
      profile: { name: boot?.profile.displayName ?? 'Tu cuenta', role: ROLE_LABELS[boot?.membership.role ?? 'reader'] ?? '' },
      theme: true,
      launcher,
      signalHere: () => { void feedback.open({ id: screen.id, path: [screen.label], element: main, fallback: true }, main); },
      column: true,
      feedbackId: 'flow.menu',
    },
  });
  const { main } = shell;

  function paintBanners(status: SyncStatus): void {
    shell.setBanners(status, { onRetry: syncNow, describeError: (error) => describeError(error), updateApply });
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
    if (location.hash === hash) void route();
    else location.hash = hash;
  }

  let currentProject: string | null = null;
  let columns: FlowColumn[] = [];
  let offBadges: (() => void) | null = null;
  let lastPrepPending: number | null = null;

  async function loadColumns(projectId: string): Promise<FlowColumn[]> {
    return ((await client.list(TABLES.columns)) as unknown as FlowColumn[])
      .filter((c) => c.project_id === projectId && !c.deleted_at).sort((a, b) => a.position - b.position);
  }

  /** Al entrar en un flujo: su barra de columnas y sus badges. Fuera (lista de flujos), sin barra. */
  async function enterProject(projectId: string | null): Promise<void> {
    if (projectId === currentProject) return;
    currentProject = projectId;
    offBadges?.(); offBadges = null; lastPrepPending = null;
    if (!projectId) { columns = []; shell.setNav([]); return; }
    columns = await loadColumns(projectId);
    if (currentProject !== projectId) return;
    shell.setNav(navFor(projectId, columns));
    offBadges = watchData(client, (d) => paintBadges(projectId, d), projectId);
  }

  function paintBadges(projectId: string, d: FlowData): void {
    const base = `#/p/${projectId}`;
    const prepPending = d.units.filter((u) => u.kind === 'prep' && u.status === 'pending').length;
    if (lastPrepPending !== null && prepPending > lastPrepPending) service.notifyNew();
    lastPrepPending = prepPending;
    shell.setBadge(`${base}/caja`, d.orders.filter((o) => o.status === 'open').length);
    shell.setBadge(`${base}/preparacion`, d.units.filter((u) => u.kind === 'prep' && (u.status === 'pending' || u.status === 'in_progress')).length);
    shell.setBadge(`${base}/servicio`, d.orders.filter((o) => o.status === 'paid').length);
    shell.setBadge(`${base}/logistica`, d.units.filter((u) => u.kind === 'task' && (u.status === 'pending' || u.status === 'in_progress')).length);
  }

  async function route(): Promise<void> {
    const hash = (location.hash && location.hash !== '#' ? location.hash : '#/').split('?')[0]!;
    const m = hash.match(/^#\/p\/([0-9a-f-]{36})(?:\/([a-z]+))?$/i);
    const projectId = m ? m[1]! : null;
    await enterProject(projectId);
    let entry: { title: string; slug: string; mount: ViewMount };
    if (!projectId) entry = { title: 'Flujos', slug: 'flujos', mount: mountProjects };
    else if (!m![2]) entry = { title: 'Inicio', slug: 'inicio', mount: mountHome };
    else {
      const column = columns.find((c) => (COLUMN_VIEWS[c.key]?.slug ?? c.key) === m![2]);
      const view = column ? COLUMN_VIEWS[column.key] : undefined;
      entry = view && column ? { title: column.label, slug: view.slug, mount: view.mount } : { title: 'Inicio', slug: 'inicio', mount: mountHome };
    }
    unmountView?.();
    unmountView = null;
    shell.setRoute(projectId ? hash : '#/');
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, projectId });
    screen = { id: `flow.${entry.slug}`, label: entry.title };
    main.setAttribute('data-feedback-id', screen.id);
    main.setAttribute('data-feedback-label', screen.label);
    document.title = `${entry.title} · Ikisai Flow`;
    paintBanners(client.status());
    main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }

  const offStatus = client.onStatus((status) => {
    if (!client.session()) {
      ctx.onLogout();
      return;
    }
    shell.setSubtitle(client.bootstrap()?.profile.displayName ?? '');
    paintBanners(status);
  });
  const onUpdate = (event: Event) => {
    updateApply = (event as CustomEvent<{ apply: () => void }>).detail.apply;
    paintBanners(client.status());
  };
  window.addEventListener('ikisai:update-available', onUpdate);
  const onHash = () => { void route(); };
  window.addEventListener('hashchange', onHash);
  void route();

  return () => {
    offStatus();
    offBadges?.();
    service.destroy();
    offSessionEnd();
    feedback.destroy();
    review.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', onHash);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
