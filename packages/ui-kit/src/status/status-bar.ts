import type { SyncClient, SyncStatus } from '@ikisai/sync-client';
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';

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
      return kt('Sincronizando…');
    case 'offline':
      return kt('Sin conexión');
    case 'error':
      return kt('Error de sincronización');
    default:
      return kt('En línea');
  }
}

export function pendingCount(status: SyncStatus): number {
  return status.pendingCommands + status.pendingBlobs;
}

export function pendingLabel(status: SyncStatus): string {
  const n = pendingCount(status);
  if (n === 0) return status.network === 'online' ? kt('Todo sincronizado') : kt('Sin cambios pendientes');
  return n === 1 ? kt('1 cambio pendiente') : kt('{count} cambios pendientes', { count: n });
}

export function conflictsLabel(status: SyncStatus): string {
  return status.conflicts === 1 ? kt('1 conflicto') : kt('{count} conflictos', { count: status.conflicts });
}

export function rejectedLabel(status: SyncStatus): string {
  return status.rejected === 1 ? kt('1 rechazado') : kt('{count} rechazados', { count: status.rejected });
}

/** Otra persona ha entrado en este dispositivo: el cliente vació lo local y lo avisa en `lastError` durante un ciclo. */
export function isUserChanged(status: SyncStatus): boolean {
  return status.lastError?.code === 'USER_CHANGED';
}

/** Texto largo para escritorio y lectores de pantalla. */
export function statusSummary(status: SyncStatus): string {
  const parts = [networkLabel(status), pendingLabel(status)];
  if (status.conflicts > 0) parts.push(conflictsLabel(status));
  if (status.rejected > 0) parts.push(rejectedLabel(status));
  return parts.join(' · ');
}

/** Texto corto para móvil: lo más urgente primero. */
export function statusShort(status: SyncStatus): string {
  if (status.conflicts > 0) return conflictsLabel(status);
  if (status.rejected > 0) return rejectedLabel(status);
  const n = pendingCount(status);
  if (n > 0) return n === 1 ? kt('1 pendiente') : kt('{count} pendientes', { count: n });
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
    ? el('button', { class: 'iconbtn syncbtn', type: 'button', 'aria-label': kt('Sincronizar ahora'), title: kt('Sincronizar ahora'), onclick: () => void options.onSync?.() }, icon('sync'))
    : null;
  const element = el('div', { class: 'statusbar' }, chip, syncButton);
  let current: SyncStatus | null = null;

  function update(status: SyncStatus): void {
    current = status;
    chip.dataset.network = status.network;
    chip.dataset.pending = String(pendingCount(status) > 0);
    chip.dataset.conflicts = String(status.conflicts > 0);
    chip.dataset.rejected = String(status.rejected > 0);
    const long = statusSummary(status);
    replace(chip, el('span', { class: 'long' }, long), el('span', { class: 'short' }, statusShort(status)));
    chip.setAttribute('aria-label', long);
    const error = status.lastError && status.network === 'error' && !isUserChanged(status) && options.describeError ? options.describeError(status.lastError) : '';
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
  /** Lotes rechazados (sync-client 0.2): abrir la pantalla donde se revisan, reintentar todos o descartar todos. */
  onShowRejected?: () => void;
  onRetryRejected?: () => void | Promise<void>;
  onDiscardRejected?: () => void | Promise<void>;
  /** No mostrar el banner de rechazados cuando ya estás en esa pantalla. */
  hideRejected?: boolean;
  /** Texto del aviso de cambio de persona; por defecto explica que se retiraron los datos anteriores. */
  userChangedText?: string;
}

export function statusBanners(status: SyncStatus, options: StatusBannersOptions = {}): HTMLElement[] {
  const items: HTMLElement[] = [];
  if (status.conflicts > 0 && !options.hideConflicts) {
    items.push(el('div', { class: 'banner alert', role: 'alert' },
      icon('warn', 18),
      el('span', null, status.conflicts === 1 ? kt('Hay 1 conflicto que necesita tu decisión.') : kt('Hay {count} conflictos que necesitan tu decisión.', { count: status.conflicts })),
      options.onResolveConflicts ? el('button', { class: 'linkbtn', type: 'button', onclick: () => options.onResolveConflicts?.() }, kt('Resolver')) : null,
    ));
  }
  if (status.rejected > 0 && !options.hideRejected) {
    items.push(el('div', { class: 'banner alert', role: 'alert', dataset: { banner: 'rejected' } },
      icon('warn', 18),
      el('span', null, status.rejected === 1 ? kt('El servidor rechazó 1 cambio; revísalo, corrígelo o descártalo.') : kt('El servidor rechazó {count} cambios; revísalos, corrígelos o descártalos.', { count: status.rejected })),
      options.onShowRejected ? el('button', { class: 'linkbtn', type: 'button', onclick: () => options.onShowRejected?.() }, kt('Ver')) : null,
      options.onRetryRejected ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void options.onRetryRejected?.() }, kt('Reintentar')) : null,
      options.onDiscardRejected ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void options.onDiscardRejected?.() }, kt('Descartar')) : null,
    ));
  }
  if (isUserChanged(status)) {
    items.push(el('div', { class: 'banner info', role: 'status', dataset: { banner: 'user-changed' } },
      icon('user', 18),
      el('span', null, options.userChangedText ?? kt('Ha entrado otra persona en este dispositivo: se cargaron sus datos y se retiraron los anteriores.')),
    ));
  }
  if (status.lastError && status.network === 'error' && !isUserChanged(status)) {
    items.push(el('div', { class: 'banner warn', dataset: { banner: 'error' } },
      icon('warn', 18),
      el('span', null, options.describeError ? options.describeError(status.lastError) : kt('No se pudo sincronizar.')),
      options.onRetry ? el('button', { class: 'linkbtn', type: 'button', onclick: () => void options.onRetry?.() }, kt('Reintentar')) : null,
    ));
  }
  if (options.updateApply) {
    items.push(el('div', { class: 'banner info' },
      icon('info', 18),
      el('span', null, kt('Hay una nueva versión de la app.')),
      el('button', { class: 'linkbtn', type: 'button', id: 'appUpdate', onclick: () => options.updateApply?.() }, kt('Actualizar')),
    ));
  }
  return items;
}
