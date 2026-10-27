import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createCommandPalette, createFeedback, createFeedbackReview, createUsage, el, openFeedbackCenter, registerReveal, replace, toast,
  type LauncherCatalog, type NavItem, type Usage,
} from '@ikisai/ui-kit';
import { T, describeError } from '../app/client.ts';
import { createAdminApi, type AdminApi } from '../app/admin.ts';
import { clearPendingAccountNames, flushPendingAccountNames } from '../app/account-names.ts';
import { clearRecents, readRecents, rememberRecent, type Recent } from '../app/recents.ts';
import { ROLE_LABELS } from '../app/admin.ts';
import { mountHome } from './home.ts';
import { mountAccess } from './access.ts';
import { mountPlans } from './plans.ts';
import { mountConflicts } from './conflicts.ts';
import { mountEntity } from './entity.ts';
import { mountDecision, mountDecisions } from './decisions.ts';
import { mountReview } from './review.ts';
import { mountCoverage } from './coverage.ts';
import { EMPTY_MENU, loadMenuData, menuSections, recentRows, screenItems, type MenuData } from './menu.ts';
import { mountPeople, mountPerson } from './people.ts';
import { mountTeams } from './teams.ts';
import { mountTrades } from './trades.ts';
import { mountTexts } from './texts.ts';
import { mountCompliance, mountRequirement } from './compliance.ts';
import { mountInventory, mountInventoryItem } from './inventory.ts';
import { fbMark } from './feedback.ts';
import { mountHeaderArt } from './header-art.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  /** Administración común (solo la usa quien es owner de Central). */
  admin: AdminApi;
  isAdmin: boolean;
  /** Uso semántico (USO.md): `usage.run` con el id de la operación (`central.` + pantalla + operación) en las importantes. */
  usage: Usage;
  navigate(hash: string): void;
  /** Cierra sesión con la misma confirmación que el botón de la cabecera. */
  logout(): Promise<void>;
  /** Apunta en «Recientes» del menú lo que se acaba de abrir (una ficha), con su título. */
  remember(entry: Omit<Recent, 'at'>): void;
}

export type ViewMount = (ctx: ViewContext) => () => void;

const ACCESS_ROUTES = ['#/accesos', '#/accesos/alta', '#/accesos/agentes', '#/accesos/registro'];

/**
 * Cuatro entradas para todos: con cinco, «Cumplimiento» se corta en el móvil. «Entidad», «Accesos» (solo el owner),
 * «Decisiones», «Textos», «Conflictos» y «Revisión» no ocupan sitio en la barra: están en el menú lateral (MUELA-013) y,
 * como siempre, en Inicio. La barra va abajo y en horizontal también en el ordenador.
 */
function navFor(): NavItem[] {
  return [
    { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', '#/conflictos', '#/entidad', '#/decisiones', '#/textos', '#/revision', '#/revision/uso', ...ACCESS_ROUTES] },
    { hash: '#/cumplimiento', label: 'Cumplimiento', icon: 'list', matches: ['#/cumplimiento', '#/cumplimiento/requisitos', '#/cumplimiento/documentos'] },
    { hash: '#/personas', label: 'Personas', icon: 'people', matches: ['#/personas', '#/personas/equipos', '#/personas/oficios'] },
    // Inventario (kit 0.37): para todos los miembros; quien solo lee, solo mira.
    { hash: '#/inventario', label: 'Inventario', icon: 'grid', matches: ['#/inventario'] },
  ];
}

const ROUTES: Record<string, { title: string; slug: string; mount: ViewMount; admin?: boolean }> = {
  '#/': { title: 'Inicio', slug: 'inicio', mount: mountHome },
  '#/conflictos': { title: 'Conflictos', slug: 'conflictos', mount: mountConflicts },
  '#/textos': { title: 'Textos y contacto', slug: 'textos', mount: mountTexts },
  '#/entidad': { title: 'Entidad', slug: 'entidad', mount: mountEntity },
  '#/entidad/planos': { title: 'Planos del centro', slug: 'planos', mount: mountPlans },
  '#/decisiones': { title: 'Decisiones', slug: 'decisiones', mount: mountDecisions },
  '#/revision': { title: 'Revisión', slug: 'revision', mount: mountReview },
  '#/revision/uso': { title: 'Uso y cobertura', slug: 'uso', mount: mountCoverage, admin: true },
  '#/personas': { title: 'Personas', slug: 'personas', mount: mountPeople },
  '#/personas/equipos': { title: 'Equipos', slug: 'equipos', mount: mountTeams },
  '#/personas/oficios': { title: 'Oficios', slug: 'oficios', mount: mountTrades },
  '#/inventario': { title: 'Inventario', slug: 'inventario', mount: mountInventory },
  '#/cumplimiento': { title: 'Vencimientos', slug: 'cumplimiento', mount: mountCompliance('vencimientos') },
  '#/cumplimiento/requisitos': { title: 'Obligaciones', slug: 'cumplimiento', mount: mountCompliance('requisitos') },
  '#/cumplimiento/documentos': { title: 'Documentos clave', slug: 'cumplimiento', mount: mountCompliance('documentos') },
  '#/accesos': { title: 'Accesos', slug: 'accesos', mount: mountAccess('cuentas'), admin: true },
  '#/accesos/alta': { title: 'Alta de cuenta', slug: 'accesos', mount: mountAccess('alta'), admin: true },
  '#/accesos/agentes': { title: 'Agentes', slug: 'accesos', mount: mountAccess('agentes'), admin: true },
  '#/accesos/registro': { title: 'Registro de accesos', slug: 'accesos', mount: mountAccess('registro'), admin: true },
};

/** Raíz de la ruta de etiquetas por pantalla, con ids fijos (el catálogo de la publicación solo recoge literales). */
function markScreen(main: HTMLElement, slug: string): void {
  switch (slug) {
    case 'inicio': fbMark(main, 'central.inicio', 'Inicio'); break;
    case 'conflictos': fbMark(main, 'central.conflictos', 'Conflictos'); break;
    case 'entidad': fbMark(main, 'central.entidad', 'Entidad'); break;
    case 'planos': fbMark(main, 'central.planos', 'Planos del centro'); break;
    case 'textos': fbMark(main, 'central.textos', 'Textos y contacto'); break;
    case 'decisiones': fbMark(main, 'central.decisiones', 'Decisiones'); break;
    case 'decision': fbMark(main, 'central.decision', 'Decisión'); break;
    case 'revision': fbMark(main, 'central.revision', 'Revisión'); break;
    case 'uso': fbMark(main, 'central.uso', 'Uso y cobertura'); break;
    case 'personas': fbMark(main, 'central.personas', 'Personas'); break;
    case 'persona': fbMark(main, 'central.persona', 'Persona'); break;
    case 'equipos': fbMark(main, 'central.equipos', 'Equipos'); break;
    case 'oficios': fbMark(main, 'central.oficios', 'Oficios'); break;
    case 'cumplimiento': fbMark(main, 'central.cumplimiento', 'Cumplimiento'); break;
    case 'obligacion': fbMark(main, 'central.obligacion', 'Obligación'); break;
    case 'accesos': fbMark(main, 'central.accesos', 'Accesos'); break;
    case 'inventario': fbMark(main, 'central.inventario', 'Inventario'); break;
    case 'articulo': fbMark(main, 'central.articulo', 'Artículo'); break;
  }
}

/** Cabecera, estado y navegación del kit; rutas y acciones propias de Central. */
export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // «Sugerencias y QA» (FEEDBACK.md): «Señalar para comentar» desde el lanzador, revisor y centro de reportes.
  let screen = { id: 'central.inicio', label: 'Inicio' };
  let catalog: LauncherCatalog | null = null;
  const api = client.api.bind(client);
  const feedback = createFeedback({
    app: 'central',
    api,
    userId: () => client.bootstrap()?.profile.userId ?? null,
    role: () => client.bootstrap()?.membership.role ?? null,
    syncSummary: () => {
      const status = client.status();
      return { pending: status.pendingCommands + status.pendingBlobs, conflicts: status.conflicts, lastSyncAt: status.lastPullAt, cursor: status.cursor };
    },
    fallbackNode: () => ({ id: screen.id, path: [screen.label] }),
  });
  const review = createFeedbackReview({ api, app: 'central', appDomain: (id) => catalog?.items.find((app) => app.id === id)?.domain });
  // Uso semántico (USO.md): exposición y activación de lo marcado con `data-feedback-id`, y éxito o error con `usage.run`.
  const usage = createUsage({ app: 'central', api, userId: () => client.bootstrap()?.profile.userId ?? null });
  const offSessionEnd = client.onSessionEnd((userId) => { void feedback.clear(userId); void usage.clear(userId); clearPendingAccountNames(); clearRecents(userId); });

  // El lanzador común va dentro del menú lateral (kit 0.47): las demás apps de la cuenta (sin volver a pedir contraseña), los
  // interruptores «Señalar para comentar» y «Revisor de QA», y la entrada «Sugerencias y QA» (kit 0.18; guía demo/adopcion.ts).
  const launcher = createAppLauncher({
    current: 'central',
    fetchApps: async () => (catalog = await client.api<LauncherCatalog>('/apps')),
    feedback,
    review,
    center: () => { openFeedbackCenter({ api, app: 'central', canEdit: () => client.bootstrap()?.membership.role !== 'reader', feedback }); },
  });
  const admin = createAdminApi(client);
  const boot = client.bootstrap();
  const isAdmin = boot?.membership.role === 'owner' && boot.profile.kind !== 'agent';
  // Nombres de cuenta pendientes de una ficha renombrada sin red (FB_2026_013): al arrancar y al volver la conexión.
  const flushNames = () => { if (isAdmin) void flushPendingAccountNames(admin, client).catch(() => undefined); };
  window.addEventListener('online', flushNames);
  flushNames();
  const userId = () => client.bootstrap()?.profile.userId ?? null;
  let menuData: MenuData | null = null;
  let recents = readRecents(userId());
  // Búsqueda de la cabecera (K8) con la paleta del kit: antes de escribir, los recientes; al escribir, obligaciones,
  // documentos, personas, decisiones y equipos del espejo, y las pantallas. Con `keepOrder` (K1), lo vigente va primero.
  const palette = createCommandPalette({
    placeholder: 'Buscar en Central: obligaciones, personas, decisiones…',
    keepOrder: true,
    hiddenWhenEmpty: ['Obligaciones', 'Documentos', 'Personas', 'Decisiones', 'Equipos', 'Pantallas'],
    items: () => [
      ...recentRows(recents, 4).map((r) => ({ group: 'Recientes', text: r.label, sub: r.sub ?? '', run: () => navigate(r.href ?? '#/') })),
      ...(menuData?.index ?? []),
      ...screenItems(isAdmin, navigate),
    ],
  });
  const shell = createAppShell(root, {
    appName: 'Central',
    markIcon: 'grid',
    subtitle: boot?.profile.displayName ?? '',
    nav: navFor(),
    status: { client, onSync: syncNow, describeError: (error) => describeError(error) },
    onLogout: logout,
    navigate,
    navLayout: 'bar',
    returnTo: { feedbackId: 'central.cabecera.volver' },
    // Guiado mínimo del kit (0.68): con ?campo= señala el campo; con ?paso= lo explica y ofrece «Volver a…». Sin Flow.
    guide: { feedbackId: 'central.guia' },
    search: { label: 'Buscar en Central…', onOpen: () => palette.open(), feedbackId: 'central.cabecera.buscar' },
    // Menú lateral común (MUELA-013): la marca abre el cajón; en el ordenador, además, la columna fija.
    menu: {
      label: 'Menú de Central',
      profile: { name: boot?.profile.displayName ?? 'Tu cuenta', role: ROLE_LABELS[(boot?.membership.role ?? 'reader') as keyof typeof ROLE_LABELS] ?? '' },
      theme: true,
      recents: () => recentRows(recents, 3),
      sections: () => menuSections(menuData ?? { ...EMPTY_MENU, conflicts: client.status().conflicts }, isAdmin, userId(), {
        online: client.status().network !== 'offline',
        accounts: admin.cached.accounts?.items ?? null, agents: admin.cached.agents?.items ?? null, catalog: admin.cached.catalog ?? null,
      }),
      launcher,
      signalHere: () => { void feedback.open({ id: screen.id, path: [screen.label], element: main, fallback: true }, main); },
      onResolveConflicts: () => navigate('#/conflictos'),
      column: true,
      feedbackId: 'central.menu',
    },
  });
  const { main } = shell;

  /** Recuentos del menú y el índice de la búsqueda, desde el espejo: al arrancar y cuando cambia algo. */
  let menuTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshMenu(): void {
    if (menuTimer) clearTimeout(menuTimer);
    menuTimer = setTimeout(async () => {
      menuTimer = null;
      menuData = await loadMenuData(client, isAdmin, navigate);
      shell.menu?.refresh();
    }, 150);
  }
  const offMenuTables = [T.requirements, T.keyDocuments, T.decisions, T.people, T.teams, T.reviewScreens].map((t) => client.onTable(t, refreshMenu));
  refreshMenu();
  /** Recuentos de «Cuentas y accesos» (solo quien administra): se leen de Core una vez con red; Accesos los mantiene al día. */
  async function loadAccessCounts(): Promise<void> {
    if (!isAdmin || client.status().network === 'offline') return;
    await Promise.all([admin.catalog(), admin.accounts(), admin.agents()]).catch(() => undefined);
    shell.menu?.refresh();
  }
  void loadAccessCounts();
  function remember(entry: Omit<Recent, 'at'>): void {
    recents = rememberRecent(userId(), entry);
    shell.menu?.refresh();
  }

  // Piezas que crea el kit (no admiten atributos propios): se marcan una vez creadas.
  fbMark(shell.header, 'central.cabecera', 'Cabecera');
  // La silueta de cabecera que el owner elige en «Imágenes del centro» (Recursos 0816): una lectura al arrancar.
  const offHeaderArt = mountHeaderArt(client, shell.header);
  // Guiado: si el campo está dentro de un pliegue cerrado (`<details>` o un grupo de indicadores plegado), se abre.
  const offReveal = registerReveal('central', (id) => {
    const q = CSS.escape(id);
    const node = main.querySelector<HTMLElement>(`[data-field-id="${q}"], [data-feedback-id="${q}"]`);
    if (!node) return;
    for (let up = node.parentElement; up && up !== main; up = up.parentElement) {
      if (up instanceof HTMLDetailsElement && !up.open) up.open = true;
      if (up.classList.contains('kpigroup') && up.classList.contains('folded')) up.querySelector<HTMLButtonElement>(':scope > .kpigrouphead')?.click();
    }
  });
  const launcherButton = shell.header.querySelector('#appLauncher');
  if (launcherButton) fbMark(launcherButton, 'central.cabecera.menu', 'Menú');
  const statusBar = shell.header.querySelector('#syncStatus');
  if (statusBar) fbMark(statusBar, 'central.cabecera.estado', 'Estado de sincronización');
  const logoutButton = shell.header.querySelector('#logoutButton');
  if (logoutButton) fbMark(logoutButton, 'central.cabecera.cerrar_sesion', 'Cerrar sesión');
  fbMark(shell.nav, 'central.navegacion', 'Navegación');
  // Ids fijos (el catálogo de la publicación solo recoge literales: kit 0.18.2).
  fbMark(shell.nav.querySelector('a.navbtn[data-hash="#/"]'), 'central.navegacion.inicio', 'Inicio');
  fbMark(shell.nav.querySelector('a.navbtn[data-hash="#/cumplimiento"]'), 'central.navegacion.cumplimiento', 'Cumplimiento');
  fbMark(shell.nav.querySelector('a.navbtn[data-hash="#/personas"]'), 'central.navegacion.personas', 'Personas');
  fbMark(shell.nav.querySelector('a.navbtn[data-hash="#/inventario"]'), 'central.navegacion.inventario', 'Inventario');
  fbMark(shell.banners, 'central.avisos', 'Avisos');

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

  let lastConflicts = client.status().conflicts;
  let lastOffline = client.status().network === 'offline';
  function paintStatus(status: SyncStatus): void {
    shell.setSubtitle(client.bootstrap()?.profile.displayName ?? '');
    paintBanners(status);
    if (status.conflicts !== lastConflicts) { lastConflicts = status.conflicts; refreshMenu(); }
    if ((status.network === 'offline') !== lastOffline) {
      lastOffline = status.network === 'offline';
      if (!lastOffline && isAdmin && !admin.cached.accounts) void loadAccessCounts();
      else shell.menu?.refresh();
    }
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
    const full = location.hash && location.hash !== '#' ? location.hash : '#/';
    // `?filtro` lo lee la pantalla (p. ej. `#/personas/oficios?riesgo`, desde el panel); la ruta es lo de antes.
    const hash = full.split('?')[0]!;
    // `#/personas/<id>` es la ficha de una persona; el resto son rutas fijas.
    const [, personId] = hash.match(/^#\/personas\/([0-9a-f-]{36})$/i) ?? [];
    const [, requirementId] = hash.match(/^#\/cumplimiento\/([0-9a-f-]{36})$/i) ?? [];
    const [, itemId] = hash.match(/^#\/inventario\/([0-9a-f-]{36})$/i) ?? [];
    const [, decisionId] = hash.match(/^#\/decisiones\/([0-9a-f-]{36})$/i) ?? [];
    const found = personId ? { title: 'Persona', slug: 'persona', mount: mountPerson(personId) }
      : requirementId ? { title: 'Obligación', slug: 'obligacion', mount: mountRequirement(requirementId) }
      : decisionId ? { title: 'Decisión', slug: 'decision', mount: mountDecision(decisionId) }
      : itemId ? { title: 'Artículo', slug: 'articulo', mount: mountInventoryItem(itemId) } : ROUTES[hash];
    const allowed = found && (!('admin' in found && found.admin) || isAdmin);
    const entry = allowed ? found : ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    if (isAdmin) shell.menu?.refresh();
    shell.setRoute(!allowed ? '#/' : personId ? '#/personas' : requirementId ? '#/cumplimiento' : itemId ? '#/inventario' : decisionId ? '#/decisiones' : hash);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout, admin, isAdmin, usage, remember });
    // La pantalla es la raíz de la ruta de etiquetas («Persona › Documentación › Adjuntar») y el nodo de reserva.
    screen = { id: `central.${entry.slug}`, label: entry.title };
    markScreen(main, entry.slug);
    if (!personId && !requirementId && !decisionId) document.title = `${entry.title} · Ikisai Central`;
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
    offSessionEnd();
    offMenuTables.forEach((off) => off());
    offHeaderArt();
    offReveal();
    if (menuTimer) clearTimeout(menuTimer);
    palette.destroy();
    window.removeEventListener('online', flushNames);
    feedback.destroy();
    review.destroy();
    usage.destroy();
    unmountView?.();
    window.removeEventListener('hashchange', route);
    window.removeEventListener('ikisai:update-available', onUpdate);
    shell.destroy();
    replace(root, el('div'));
  };
}
