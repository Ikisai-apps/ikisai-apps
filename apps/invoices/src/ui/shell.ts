import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { el, icon, replace } from './dom.ts';
import { toast } from './toast.ts';
import { describeError } from '../app/client.ts';
import { mountHome } from './home.ts';
import { mountSuppliers } from './suppliers.ts';
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

const NAV = [
  { hash: '#/', label: 'Inicio', icon: 'home', ready: true, matches: ['#/', '#/proveedores', '#/conflictos'] },
  { hash: '#/facturas', label: 'Facturas', icon: 'invoice', ready: false, matches: ['#/facturas'] },
  { hash: '#/compras', label: 'Compras', icon: 'cart', ready: false, matches: ['#/compras'] },
  { hash: '#/gestoria', label: 'Gestoría', icon: 'briefcase', ready: false, matches: ['#/gestoria'] },
] as const;

const ROUTES: Record<string, { title: string; mount: ViewMount }> = {
  '#/': { title: 'Inicio', mount: mountHome },
  '#/proveedores': { title: 'Proveedores', mount: mountSuppliers },
  '#/conflictos': { title: 'Conflictos', mount: mountConflicts },
  '#/facturas': { title: 'Facturas', mount: mountPlaceholder('Facturas', 'Registro y seguimiento de facturas emitidas y recibidas.') },
  '#/compras': { title: 'Compras', mount: mountPlaceholder('Compras', 'Tickets y documentos de compra con adjuntos.') },
  '#/gestoria': { title: 'Gestoría', mount: mountPlaceholder('Gestoría', 'Entregas periódicas y comunicación con la gestoría.') },
};

function networkLabel(status: SyncStatus): string {
  switch (status.network) {
    case 'syncing':
      return 'Sincronizando…';
    case 'offline':
      return 'Sin conexión';
    case 'error':
      return 'Error de sincronización';
    default:
      return 'En línea';
  }
}

function pendingLabel(status: SyncStatus): string {
  const n = status.pendingCommands + status.pendingBlobs;
  if (n === 0) return status.network === 'online' ? 'Todo sincronizado' : 'Sin cambios pendientes';
  return n === 1 ? '1 cambio pendiente' : `${n} cambios pendientes`;
}

export function renderShell(root: HTMLElement, ctx: ShellContext): () => void {
  const { client } = ctx;
  let unmountView: (() => void) | null = null;
  let lastAutoMerged = client.status().autoMerged;
  let updateApply: (() => void) | null = null;

  // --- Cabecera -----------------------------------------------------------
  const statusChip = el('span', { class: 'statuschip', id: 'syncStatus', role: 'status', 'aria-live': 'polite' });
  const syncButton = el('button', { class: 'iconbtn syncbtn', type: 'button', 'aria-label': 'Sincronizar ahora', title: 'Sincronizar ahora', onclick: () => void syncNow() }, icon('sync'));
  const logoutButton = el('button', { class: 'iconbtn desktop-only', type: 'button', 'aria-label': 'Cerrar sesión', title: 'Cerrar sesión', onclick: () => void logout() }, icon('logout'));
  const topbar = el(
    'header',
    { class: 'topbar' },
    el('div', { class: 'brand' },
      el('div', { class: 'mark', 'aria-hidden': 'true' }, icon('mark', 20)),
      el('h1', null, 'Ikisai Invoices', el('small', { id: 'profileName' })),
    ),
    statusChip,
    syncButton,
    logoutButton,
  );

  // --- Navegación ---------------------------------------------------------
  const navLinks = NAV.map((item) =>
    el('a', { class: 'navbtn', href: item.hash, dataset: { hash: item.hash } },
      icon(item.icon),
      el('span', null, item.label),
      !item.ready ? el('span', { class: 'soon', 'aria-label': 'pendiente de la fase 1' }, 'fase 1') : null,
    ),
  );
  const nav = el('nav', { class: 'nav', 'aria-label': 'Secciones' }, ...navLinks);

  // --- Contenido ----------------------------------------------------------
  const banners = el('div', { class: 'banners' });
  const main = el('main', { class: 'main', id: 'main', tabindex: '-1' });
  const content = el('div', null, banners, main);
  const shell = el('div', { class: 'shell' }, topbar, nav, content);
  replace(root, shell);

  // --- Estado -------------------------------------------------------------
  function paintStatus(status: SyncStatus): void {
    statusChip.dataset.network = status.network;
    statusChip.dataset.pending = String(status.pendingCommands + status.pendingBlobs > 0);
    const pendingCount = status.pendingCommands + status.pendingBlobs;
    replace(statusChip,
      el('span', { class: 'long' }, `${networkLabel(status)} · ${pendingLabel(status)}`),
      el('span', { class: 'short' }, pendingCount > 0 ? `${pendingCount} pendiente${pendingCount === 1 ? '' : 's'}` : networkLabel(status)),
    );
    syncButton.classList.toggle('spinning', status.network === 'syncing');
    syncButton.disabled = status.network === 'syncing';
    const name = client.bootstrap()?.profile.displayName;
    const profile = topbar.querySelector('#profileName');
    if (profile) profile.textContent = name ? name : '';
    paintBanners(status);
    if (status.autoMerged > lastAutoMerged) {
      toast('Se incorporaron cambios de otra persona en una fila que editaste.');
    }
    lastAutoMerged = status.autoMerged;
  }

  function paintBanners(status: SyncStatus): void {
    const items: HTMLElement[] = [];
    if (status.conflicts > 0 && location.hash !== '#/conflictos') {
      items.push(el('div', { class: 'banner alert', role: 'alert' },
        icon('warn', 18),
        el('span', null, status.conflicts === 1 ? 'Hay 1 conflicto que necesita tu decisión.' : `Hay ${status.conflicts} conflictos que necesitan tu decisión.`),
        el('button', { class: 'linkbtn', type: 'button', onclick: () => navigate('#/conflictos') }, 'Resolver'),
      ));
    }
    if (status.lastError && status.network === 'error') {
      items.push(el('div', { class: 'banner warn' }, icon('warn', 18), el('span', null, describeError(status.lastError)),
        el('button', { class: 'linkbtn', type: 'button', onclick: () => void syncNow() }, 'Reintentar')));
    }
    if (updateApply) {
      items.push(el('div', { class: 'banner info' }, el('span', null, 'Hay una nueva versión de la app.'),
        el('button', { class: 'linkbtn', type: 'button', id: 'appUpdate', onclick: () => updateApply?.() }, 'Actualizar')));
    }
    replace(banners, ...items);
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
    if (status.pendingCommands > 0 && !confirm(`Tienes ${status.pendingCommands} cambios sin sincronizar. Si cierras sesión ahora seguirán en este dispositivo hasta que vuelvas a entrar. ¿Cerrar sesión?`)) return;
    try {
      await client.logout();
    } finally {
      ctx.onLogout();
    }
  }

  // --- Rutas --------------------------------------------------------------
  function navigate(hash: string): void {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route(): void {
    const hash = location.hash && location.hash !== '#' ? location.hash : '#/';
    const entry = ROUTES[hash] ?? ROUTES['#/']!;
    unmountView?.();
    unmountView = null;
    for (const link of navLinks) {
      const item = NAV.find((n) => n.hash === link.dataset.hash);
      const active = item ? (item.matches as readonly string[]).includes(hash) : false;
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    replace(main);
    unmountView = entry.mount({ ...ctx, main, navigate, logout });
    document.title = `${entry.title} · Ikisai Invoices`;
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
  };
}
