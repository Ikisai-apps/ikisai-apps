import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, el, openFeedbackCenter, replace, toast,
  type LauncherCatalog, type NavItem,
} from '@ikisai/ui-kit';
import { APP } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { mountHome } from './home.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  navigate(hash: string): void;
}

export type ViewMount = (ctx: ViewContext) => () => void;

/** Rótulos de los roles del núcleo (no son roles de negocio de Flow). */
const ROLE_LABELS: Record<string, string> = { owner: 'Propietario', editor: 'Editor', reader: 'Lector', outsider: 'Outsider' };

/** Primer incremento: solo Inicio. Las secciones llegan con el documento funcional (docs/flow/ESTADO.md). */
const NAV: NavItem[] = [{ hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/'] }];

const ROUTES: Record<string, { title: string; slug: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', slug: 'inicio', mount: mountHome },
};

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
  const shell = createAppShell(root, {
    appName: 'Flow',
    markIcon: 'sync',
    subtitle: boot?.profile.displayName ?? '',
    nav: NAV,
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    navLayout: 'bar',
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
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route(): void {
    const hash = (location.hash && location.hash !== '#' ? location.hash : '#/').split('?')[0]!;
    const entry = ROUTES[hash] ?? ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(ROUTES[hash] ? hash : '#/');
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate });
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
  window.addEventListener('hashchange', route);
  route();

  return () => {
    offStatus();
    offSessionEnd();
    feedback.destroy();
    review.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', route);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
