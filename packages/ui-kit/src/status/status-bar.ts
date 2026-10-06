import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { plural } from '../dom.ts';

/**
 * Barra de estado de sincronización (contrato §6.4): red, cambios pendientes, conflictos y «guardado» solo cuando el
 * servidor confirmó. Lee `SyncStatus`; no decide nada por su cuenta.
 */
export interface StatusBarOptions {
  /** Cliente del que leer el estado y al que suscribirse. */
  client?: Pick<SyncClient, 'status' | 'onStatus'>;
  /** Alternativa sin cliente (demo, pruebas): estado inicial; actualizar con `update()`. */
  status?: SyncStatus;
  /** Botón «Sincronizar ahora»; sin esta opción no se muestra. */
  onSync?: () => void | Promise<void>;
  /** Al pulsar la pastilla (por ejemplo, abrir la pantalla de conflictos o de pendientes). */
  onClick?: (status: SyncStatus) => void;
  /** Traduce `lastError` a texto para el tooltip. */
  describeError?: (error: SyncStatus['lastError']) => string;
}

export interface StatusBar {
  element: HTMLElement;
  update(status: SyncStatus): void;
  destroy(): void;
}

export function networkLabel(status: SyncStatus): string {
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

export function pendingCount(status: SyncStatus): number {
  return status.pendingCommands + status.pendingBlobs;
}

export function pendingLabel(status: SyncStatus): string {
  const n = pendingCount(status);
  if (n === 0) return status.network === 'online' ? 'Todo sincronizado' : 'Sin cambios pendientes';
  return n === 1 ? '1 cambio pendiente' : `${n} cambios pendientes`;
}

export function conflictsLabel(status: SyncStatus): string {
  return status.conflicts === 1 ? '1 conflicto' : `${status.conflicts} conflictos`;
}

/** Texto largo para escritorio y lectores de pantalla. */
export function statusSummary(status: SyncStatus): string {
  const parts = [networkLabel(status), pendingLabel(status)];
  if (status.conflicts > 0) parts.push(conflictsLabel(status));
  return parts.join(' · ');
}

/** Texto corto para móvil: lo más urgente primero. */
export function statusShort(status: SyncStatus): string {
  if (status.conflicts > 0) return conflictsLabel(status);
  const n = pendingCount(status);
  if (n > 0) return plural(n, 'pendiente', 'pendientes');
  return networkLabel(status);
}

export function createStatusBar(options: StatusBarOptions = {}): StatusBar {
  const chip = el(options.onClick ? 'button' : 'span', {
    class: 'statuschip',
    id: 'syncStatus',
    role: 'status',
    'aria-live': 'polite',
    ...(options.onClick ? { type: 'button' } : {}),
  }) as HTMLElement;
  const syncButton = options.onSync
    ? el('button', { class: 'iconbtn syncbtn', type: 'button', 'aria-label': 'Sincronizar ahora', title: 'Sincronizar ahora', onclick: () => void options.onSync?.() }, icon('sync'))
    : null;
  const element = el('div', { class: 'statusbar' }, chip, syncButton);
  let current: SyncStatus | null = null;

  function update(status: SyncStatus): void {
    current = status;
    chip.dataset.network = status.network;
    chip.dataset.pending = String(pendingCount(status) > 0);
    chip.dataset.conflicts = String(status.conflicts > 0);
    const long = statusSummary(status);
    replace(chip, el('span', { class: 'long' }, long), el('span', { class: 'short' }, statusShort(status)));
    chip.setAttribute('aria-label', long);
    const error = status.lastError && status.network === 'error' && options.describeError ? options.describeError(status.lastError) : '';
    if (error) chip.title = error;
    else chip.removeAttribute('title');
    if (syncButton) {
      syncButton.classList.toggle('spinning', status.network === 'syncing');
      syncButton.disabled = status.network === 'syncing';
    }
  }

  if (options.onClick) chip.addEventListener('click', () => current && options.onClick?.(current));

  let off: (() => void) | null = null;
  if (options.client) {
    update(options.client.status());
    off = options.client.onStatus(update);
  } else if (options.status) {
    update(options.status);
  }

  return {
    element,
    update,
    destroy() {
      off?.();
      off = null;
      element.remove();
    },
  };
}

/** Banners derivados del estado (conflictos, error de red, actualización disponible). La app decide dónde colocarlos. */
export interface StatusBannersOptions {
  onResolveConflicts?: () => void;
  onRetry?: () => void | Promise<void>;
  describeError?: (error: SyncStatus['lastError']) => string;
  /** Si hay una versión nueva lista, la acción para aplicarla. */
  updateApply?: (() => void) | null;
  /** No mostrar el banner de conflictos cuando ya estás en esa pantalla. */
  hideConflicts?: boolean;
}

export function statusBanners(status: SyncStatus, options: StatusBannersOptions = {}): HTMLElement[] {
  const items: HTMLElement[] = [];
  if (status.conflicts > 0 && !options.hideConflicts) {
    items.push(el('div', { class: 'banner alert', role: 'alert' },
      icon('warn', 18),
      el('span', null, status.conflicts === 1 ? 'Hay 1 conflicto que necesita tu decisión.' : `Hay ${status.conflicts} conflictos que necesitan tu decisión.`),
      options.onResolveConflicts ? el('button', { class: 'linkbtn', type: 'button', onclick: () => options.onResolveConflicts?.() }, 'Resolver') : null,
    ));
  }
  if (status.lastError && status.network === 'error') {
    items.push(el('div', { class: 'banner warn' },
      icon('warn', 18),
      el('span', null, options.describeError ? options.describeError(status.lastError) : 'No se pudo sincronizar.'),
      options.onRetry ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void options.onRetry?.() }, 'Reintentar') : null,
    ));
  }
  if (options.updateApply) {
    items.push(el('div', { class: 'banner info' },
      icon('info', 18),
      el('span', null, 'Hay una nueva versión de la app.'),
      el('button', { class: 'linkbtn', type: 'button', id: 'appUpdate', onclick: () => options.updateApply?.() }, 'Actualizar'),
    ));
  }
  return items;
}
