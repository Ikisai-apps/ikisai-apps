import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import {
  confirmDialog, createAppLauncher, createAppShell, createFeedback, createFeedbackReview, createUsage, el, openFeedbackCenter, replace, toast,
  type LauncherCatalog, type NavItem, type Usage,
} from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { createAdminApi, type AdminApi } from '../app/admin.ts';
import { mountHome } from './home.ts';
import { mountAccess } from './access.ts';
import { mountConflicts } from './conflicts.ts';
import { mountEntity } from './entity.ts';
import { mountDecisions } from './decisions.ts';
import { mountPeople, mountPerson } from './people.ts';
import { mountTeams } from './teams.ts';
import { mountCompliance, mountRequirement } from './compliance.ts';
import { fbMark } from './feedback.ts';

export interface ShellContext {
  client: SyncClient;
  onLogout(): void;
}

export interface ViewContext extends ShellContext {
  main: HTMLElement;
  /** Administración común (solo la usa quien es owner de Central). */
  admin: AdminApi;
  isAdmin: boolean;
  /** Uso semántico (USO.md): `usage.run('central.<pantalla>.<…>', fn)` en las operaciones importantes. */
  usage: Usage;
  navigate(hash: string): void;
  /** Cierra sesión con la misma confirmación que el botón de la cabecera. */
  logout(): Promise<void>;
}

export type ViewMount = (ctx: ViewContext) => () => void;

const ACCESS_ROUTES = ['#/accesos', '#/accesos/alta', '#/accesos/agentes', '#/accesos/registro'];

/** Accesos solo para quien administra el ecosistema (owner de Central). Personas y Cumplimiento llegan en V1-b y V1.1. */
function navFor(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [
    // «Entidad» no ocupa sitio en la barra (se usa poco): se abre desde Inicio.
    { hash: '#/', label: 'Inicio', icon: 'home', matches: ['#/', '#/conflictos', '#/entidad', '#/decisiones'] },
    { hash: '#/cumplimiento', label: 'Cumplimiento', icon: 'list', matches: ['#/cumplimiento', '#/cumplimiento/requisitos', '#/cumplimiento/documentos'] },
    { hash: '#/personas', label: 'Personas', icon: 'people', matches: ['#/personas', '#/personas/equipos'] },
  ];
  if (isAdmin) items.push({ hash: '#/accesos', label: 'Accesos', icon: 'lock', matches: ACCESS_ROUTES });
  return items;
}

const ROUTES: Record<string, { title: string; slug: string; mount: ViewMount; admin?: boolean }> = {
  '#/': { title: 'Inicio', slug: 'inicio', mount: mountHome },
  '#/conflictos': { title: 'Conflictos', slug: 'conflictos', mount: mountConflicts },
  '#/entidad': { title: 'Entidad', slug: 'entidad', mount: mountEntity },
  '#/decisiones': { title: 'Decisiones', slug: 'decisiones', mount: mountDecisions },
  '#/personas': { title: 'Personas', slug: 'personas', mount: mountPeople },
  '#/personas/equipos': { title: 'Equipos', slug: 'equipos', mount: mountTeams },
  '#/cumplimiento': { title: 'Vencimientos', slug: 'cumplimiento', mount: mountCompliance('vencimientos') },
  '#/cumplimiento/requisitos': { title: 'Obligaciones', slug: 'cumplimiento', mount: mountCompliance('requisitos') },
  '#/cumplimiento/documentos': { title: 'Documentos clave', slug: 'cumplimiento', mount: mountCompliance('documentos') },
  '#/accesos': { title: 'Accesos', slug: 'accesos', mount: mountAccess('cuentas'), admin: true },
  '#/accesos/alta': { title: 'Alta de cuenta', slug: 'accesos', mount: mountAccess('alta'), admin: true },
  '#/accesos/agentes': { title: 'Agentes', slug: 'accesos', mount: mountAccess('agentes'), admin: true },
  '#/accesos/registro': { title: 'Registro de accesos', slug: 'accesos', mount: mountAccess('registro'), admin: true },
};

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
  const offSessionEnd = client.onSessionEnd((userId) => { void feedback.clear(userId); void usage.clear(userId); });

  // La marca de la cabecera abre el lanzador común: las demás apps de la cuenta (sin volver a pedir contraseña), los
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

  // Piezas que crea el kit (no admiten atributos propios): se marcan una vez creadas.
  fbMark(shell.header, 'central.cabecera', 'Cabecera');
  const launcherButton = shell.header.querySelector('#appLauncher');
  if (launcherButton) fbMark(launcherButton, 'central.cabecera.lanzador', 'Lanzador de apps');
  const statusBar = shell.header.querySelector('#syncStatus');
  if (statusBar) fbMark(statusBar, 'central.cabecera.estado', 'Estado de sincronización');
  const logoutButton = shell.header.querySelector('#logoutButton');
  if (logoutButton) fbMark(logoutButton, 'central.cabecera.cerrar_sesion', 'Cerrar sesión');
  fbMark(shell.nav, 'central.navegacion', 'Navegación');
  const NAV_IDS: Record<string, [string, string]> = {
    '#/': ['central.navegacion.inicio', 'Inicio'], '#/cumplimiento': ['central.navegacion.cumplimiento', 'Cumplimiento'],
    '#/personas': ['central.navegacion.personas', 'Personas'], '#/accesos': ['central.navegacion.accesos', 'Accesos'],
  };
  for (const link of shell.nav.querySelectorAll<HTMLElement>('a.navbtn')) {
    const mark = NAV_IDS[link.dataset.hash ?? ''];
    if (mark) fbMark(link, mark[0], mark[1]);
  }
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
    // `#/personas/<id>` es la ficha de una persona; el resto son rutas fijas.
    const [, personId] = hash.match(/^#\/personas\/([0-9a-f-]{36})$/i) ?? [];
    const [, requirementId] = hash.match(/^#\/cumplimiento\/([0-9a-f-]{36})$/i) ?? [];
    const found = personId ? { title: 'Persona', slug: 'persona', mount: mountPerson(personId) }
      : requirementId ? { title: 'Obligación', slug: 'obligacion', mount: mountRequirement(requirementId) } : ROUTES[hash];
    const allowed = found && (!('admin' in found && found.admin) || isAdmin);
    const entry = allowed ? found : ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    shell.setRoute(!allowed ? '#/' : personId ? '#/personas' : requirementId ? '#/cumplimiento' : hash);
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout, admin, isAdmin, usage });
    // La pantalla es la raíz de la ruta de etiquetas («Persona › Documentación › Adjuntar») y el nodo de reserva.
    screen = { id: `central.${entry.slug}`, label: entry.title };
    fbMark(main, screen.id, screen.label);
    if (!personId && !requirementId) document.title = `${entry.title} · Ikisai Central`;
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
