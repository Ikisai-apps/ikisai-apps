import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createLanes, createFeedback, createFeedbackReview, el, icon, openFeedbackCenter, registerReveal, replace, toast,
  type Lanes, type LauncherCatalog, type NavItem,
} from '@ikisai/ui-kit';
import { APP, TABLES, type ColumnBehavior } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { loadProjects, watchData, type FlowData } from '../app/data.ts';
import { mountHome } from './home.ts';
import { mountProjects } from './projects.ts';
import { mountPresence } from './presence.ts';
import { mountEditor } from './editor.ts';
import { mountAvance } from './avance.ts';
import { mountJourneyEditor } from './journey-editor.ts';
import { mountJourneys } from './journeys.ts';
import { mountClosure } from './closure.ts';
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
  ingredients: { slug: 'ingredientes', icon: 'tag', mount: mountQueue('ingredients') },
  service: { slug: 'servicio', icon: 'check', mount: mountOrders('service') },
  logistics: { slug: 'logistica', icon: 'list', mount: mountQueue('logistics') },
  // Check-in (0911): Llegada → Cama → Firma → Salida.
  arrival: { slug: 'llegada', icon: 'guest', mount: mountPresence('arrival') },
  bed: { slug: 'cama', icon: 'bed', mount: mountPresence('bed') },
  signature: { slug: 'firma', icon: 'edit', mount: mountPresence('signature') },
  departure: { slug: 'salida', icon: 'logout', mount: mountPresence('departure') },
  // «Avance por aplicaciones» (0937): su propia pantalla de carriles por agente.
  avance: { slug: 'avance', icon: 'board', mount: mountAvance },
};
const BEHAVIOR_ICON: Record<ColumnBehavior, string> = { inspect_confirm: 'check', quick_steps: 'board', free_task: 'list', guest_presence: 'guest' };

interface FlowColumn { key: string; label: string; behavior: ColumnBehavior; position: number; project_id: string; deleted_at: string | null }

/**
 * Nombres cortos para la barra inferior (revisión móvil de UI-kit, 27-10): con seis secciones a 390 px, los nombres largos
 * se cortaban («Prepara…», «Ingredie…»). Van en `short` del kit: la barra los usa si no caben y el lector sigue diciendo el
 * nombre entero.
 */
const NAV_SHORT: Record<string, string> = { order: 'Caja', prep: 'Cocina', ingredients: 'Ingred.', service: 'Entrega', logistics: 'Logística' };
const NAV_MAX = 9;
export function navLabel(key: string, label: string): string {
  if (label.length <= NAV_MAX) return label;
  if (NAV_SHORT[key]) return NAV_SHORT[key]!;
  const first = label.split(/\s+/)[0] ?? label;
  return first.length <= NAV_MAX ? first : `${first.slice(0, NAV_MAX - 1)}.`;
}

/** Barra inferior de un flujo: la casa + sus columnas, en su orden (§2.1). */
function navFor(projectId: string, columns: FlowColumn[], short: boolean): NavItem[] {
  const base = `#/p/${projectId}`;
  return [
    { hash: base, label: 'Inicio', icon: 'home', matches: [base] },
    ...columns.map((c) => {
      const view = COLUMN_VIEWS[c.key];
      const hash = `${base}/${view?.slug ?? c.key}`;
      // Nombre entero siempre (lo dice el lector); el corto, para la barra cuando no cabe (kit 0.69.4, `short`).
      return { hash, label: c.label, ...(short ? { short: navLabel(c.key, c.label) } : {}), icon: (view?.icon ?? BEHAVIOR_ICON[c.behavior]) as NavItem['icon'], matches: [hash] };
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
  const backButton = el('button', { type: 'button', class: 'iconbtn flow-nav-btn', 'aria-label': 'Volver', title: 'Volver', hidden: true,
    'data-feedback-id': 'flow.navegacion.volver', onclick: () => { if (navParent) navigate(navParent); } }, el('span', { class: 'flow-nav-chev', 'aria-hidden': 'true' }, '‹'));
  const closeButton = el('button', { type: 'button', class: 'iconbtn flow-nav-btn', 'aria-label': 'Cerrar y volver a la entrada', title: 'Cerrar y volver a la entrada', hidden: true,
    'data-feedback-id': 'flow.navegacion.cerrar', onclick: () => navigate('#/') }, icon('close', 20));
  const shell = createAppShell(root, {
    appName: 'Flow',
    markIcon: 'sync',
    subtitle: boot?.profile.displayName ?? '',
    nav: [],
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    navLayout: 'bar',
    // Guiado mínimo del kit (0.68): ?campo= señala el campo; ?paso= lo explica y pone «Volver a…». Sin cliente: no lee nada de Flow.
    guide: { feedbackId: 'flow.guia' },
    tools: [backButton, closeButton, service.button],
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

  /**
   * «Volver» y «Cerrar» (VG, 27-10): una sola vez, discretos, en la cabecera: iconos de 40 px con su nombre accesible, nunca
   * repetidos en la pantalla. En todas menos la entrada común. «Volver» sube un nivel (pantalla del flujo → su Inicio →
   * entrada; editor → Recorridos → entrada); «Cerrar» vuelve a la entrada común.
   */
  let navParent: string | null = null;
  function parentOf(hash: string, projectId: string | null): string | null {
    if (projectId) return hash === `#/p/${projectId}` ? '#/' : `#/p/${projectId}`;
    if (hash.startsWith('#/recorridos/')) return '#/recorridos';
    return hash === '#/' ? null : '#/';
  }
  function paintFlowNav(hash: string, projectId: string | null, isEntry: boolean): void {
    navParent = isEntry ? null : parentOf(hash, projectId);
    backButton.hidden = !navParent;
    closeButton.hidden = !navParent;
  }

  function paintBanners(status: SyncStatus): void {
    shell.setBanners(status, { onRetry: syncNow, describeError: (error) => describeError(error), updateApply }, staleBanner(status));
  }

  /**
   * La pantalla se actualiza sola (pull cada 3 s). Si lleva más de un minuto sin traer nada y no hay otro aviso (sin red o
   * error ya salen), lo dice: así una cocina con el móvil apoyado no se queda mirando datos viejos sin saberlo.
   */
  const STALE_MS = 60_000;
  function staleBanner(status: SyncStatus): HTMLElement[] {
    if (status.network === 'offline' || status.network === 'error' || !status.lastPullAt) return [];
    const ago = Date.now() - Date.parse(status.lastPullAt);
    if (!(ago > STALE_MS)) return [];
    const min = Math.max(1, Math.round(ago / 60_000));
    return [el('div', { class: 'banner warn', role: 'status', dataset: { banner: 'stale' } },
      el('span', null, `Esta pantalla no se actualiza desde hace ${min} min.`),
      el('button', { class: 'linkbtn', type: 'button', onclick: () => void syncNow() }, 'Actualizar'))];
  }
  const staleTimer = setInterval(() => { if (document.visibilityState === 'visible') paintBanners(client.status()); }, 15_000);

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
  /** Carriles (VG 27-10; createLanes del kit): en los flujos no congelados las columnas van en un tablero con dos vistas
      intercambiables, pestañas o lado a lado, recordada en el dispositivo. La v1 congelada sigue con una columna por pantalla. */
  let boardable = false;
  let board: { projectId: string; lanes: Lanes } | null = null;
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
    if (!projectId) { columns = []; boardable = false; shell.setNav([]); return; }
    columns = await loadColumns(projectId);
    // El Avance ya trae sus carriles (por agente): no va dentro del tablero de columnas.
    boardable = (await loadProjects(client)).some((p) => p.id === projectId && !p.frozen) && !columns.some((c) => c.key === 'avance');
    if (currentProject !== projectId) return;
    // La v1 congelada no cambia (VG: «Barra · v1» se congela); los nombres cortos, en lo que no está congelado.
    shell.setNav(navFor(projectId, columns, boardable));
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
    shell.setBadge(`${base}/logistica`, d.units.filter((u) => u.kind === 'task' && u.column_key === 'logistics' && (u.status === 'pending' || u.status === 'in_progress')).length);
    shell.setBadge(`${base}/ingredientes`, d.units.filter((u) => u.kind === 'task' && u.column_key === 'ingredients' && ['proposed', 'pending', 'in_progress'].includes(u.status)).length);
  }

  async function route(): Promise<void> {
    const hash = (location.hash && location.hash !== '#' ? location.hash : '#/').split('?')[0]!;
    const testLink = /[?&]prueba(=|&|$)/.test(location.hash);
    const m = hash.match(/^#\/p\/([0-9a-f-]{36})(?:\/([a-z]+))?$/i);
    const projectId = m ? m[1]! : null;
    await enterProject(projectId);
    let entry: { title: string; slug: string; mount: ViewMount };
    if (!projectId && hash === '#/recorridos') entry = { title: 'Recorridos', slug: 'recorridos', mount: mountJourneys };
    // Crear recorridos y flujos no está en la interfaz (VG, 27-10: «no ahora»): solo con el enlace de prueba (`?prueba`).
    else if (!projectId && hash === '#/recorridos/nuevo' && testLink) entry = { title: 'Nuevo recorrido', slug: 'recorridos', mount: mountJourneyEditor(null) };
    else if (!projectId && /^#\/recorridos\/[a-z][a-z0-9_]{1,40}\/editar$/.test(hash)) entry = { title: 'Editar recorrido', slug: 'recorridos', mount: mountJourneyEditor(hash.split('/')[2]!) };
    else if (!projectId && hash === '#/nuevo' && testLink) entry = { title: 'Nuevo flujo', slug: 'nuevo', mount: mountEditor('new') };
    else if (!projectId) entry = { title: 'Flujos', slug: 'flujos', mount: mountProjects };
    else if (!m![2]) entry = { title: 'Inicio', slug: 'inicio', mount: mountHome };
    else if (m![2] === 'cierre') entry = { title: 'Cierre del día', slug: 'cierre', mount: mountClosure };
    else if (m![2] === 'editor') entry = { title: 'Columnas del flujo', slug: 'editor', mount: mountEditor('edit') };
    else {
      const column = columns.find((c) => (COLUMN_VIEWS[c.key]?.slug ?? c.key) === m![2]);
      const view = column ? COLUMN_VIEWS[column.key] : undefined;
      if (view && column && boardable && board?.projectId === projectId) {
        // Ya en el tablero de este flujo: solo se elige el carril (no se vuelve a montar nada).
        board.lanes.select(column.key);
        shell.setRoute(hash);
        document.title = `${column.label} · Ikisai Flow`;
        return;
      }
      entry = view && column
        ? { title: column.label, slug: view.slug, mount: boardable ? (vctx: ViewContext) => mountBoard(vctx, column.key) : view.mount }
        : { title: 'Inicio', slug: 'inicio', mount: mountHome };
    }
    unmountView?.();
    unmountView = null;
    shell.setRoute(projectId ? hash : '#/');
    paintFlowNav(hash, projectId, entry.slug === 'flujos');
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

  /** El tablero de carriles de un flujo: cada carril monta la vista de su columna, una vez, al verse por primera vez. */
  function mountBoard(vctx: ViewContext, selected: string): () => void {
    const projectId = vctx.projectId!;
    const lanes = createLanes({
      label: 'Columnas del flujo', storageKey: 'flow-board', selected, feedbackId: 'flow.tablero',
      lanes: columns.map((c) => ({ id: c.key, title: c.label, mount: (body: HTMLElement) => COLUMN_VIEWS[c.key]?.mount({ ...vctx, main: body }) })),
      onSelect: (id) => {
        const h = `#/p/${projectId}/${COLUMN_VIEWS[id]?.slug ?? id}`;
        if (location.hash !== h) { history.replaceState(null, '', h); shell.setRoute(h); }
      },
    });
    vctx.main.append(lanes.element);
    board = { projectId, lanes };
    // Guiado: un campo de otra columna está en otro carril; se elige ese carril para que aparezca (`flow.<pantalla>…`).
    const offReveals = columns.map((c) => registerReveal(`flow.${COLUMN_VIEWS[c.key]?.slug ?? c.key}`, () => lanes.select(c.key)));
    return () => { offReveals.forEach((off) => off()); lanes.destroy(); board = null; };
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
    clearInterval(staleTimer);
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
