import {
  createCountSession, createItemCatalog, createItemSheet, createMovementForm, createSyncItemSource, createSyncSpaceSource, el, icon, openSheet, replace, toast,
  type ItemCatalogAction, type ItemCatalogFilter, type ItemRow, type ItemSheetAction, type ItemSource, type MovementMode, type Sheet, type SpaceSource,
} from '@ikisai/ui-kit';
import { T } from '../app/client.ts';
import { startResources } from '../app/resources.ts';
import type { Person } from './people.ts';
import type { ViewMount } from './shell.ts';

/** Origen de un movimiento con el nombre que ve el usuario (Finance, no `invoices`); abre la app. */
const SOURCE_APPS: Record<string, { label: string; href: string }> = {
  invoices: { label: 'Finance', href: 'https://finance.ikisai.com/' },
  food: { label: 'Food', href: 'https://food.ikisai.com/' },
  tasks: { label: 'Tasks', href: 'https://tasks.ikisai.com/' },
  booking: { label: 'Booking', href: 'https://booking.ikisai.com/' },
};

/** Filtros que se pueden poner desde un enlace (`#/inventario?bajo-minimo`), p. ej. desde el panel de dirección. */
const LINK_FILTERS: Record<string, ItemCatalogFilter> = { 'bajo-minimo': { low: true }, caduca: { expiring: true } };

/** Escribe en Recursos quien es editor u owner; el servidor lo comprueba igualmente (Central da su rol al módulo). */
const canWrite = (role: string | undefined) => role === 'editor' || role === 'owner';

const CATALOG_ACTIONS: ItemCatalogAction[] = ['spend', 'entry', 'count'];
const SHEET_ACTIONS: ItemSheetAction[] = ['spend', 'entry', 'transfer', 'count'];

/** Acción del kit → modo del formulario de movimiento («Gastar» es una salida con motivo «uso» preelegido). */
const ACTION_MODES: Record<string, MovementMode> = { spend: 'exit', entry: 'entry', transfer: 'transfer' };

/** Entrada, salida o traslado a mano (kit 0.38), en una hoja. Sin red se guarda en el dispositivo y sube al volver. */
function openMovement(source: ItemSource, spaces: SpaceSource, mode: MovementMode, item: ItemRow): void {
  let sheet: Sheet | null = null;
  const form = createMovementForm({
    source, spaces, mode, itemId: item.id, ...(mode === 'exit' ? { reason: 'uso' } : {}), feedbackId: 'central.inventario.movimiento',
    onDone: () => { toast(navigator.onLine ? 'Movimiento registrado.' : 'Movimiento registrado. Se sincronizará cuando haya red.'); void sheet?.close(true); },
    onCancel: () => void sheet?.close(true),
  });
  sheet = openSheet({ title: item.name, body: form.element, onClose: () => form.destroy() });
}

/** Recuento (kit 0.38): de todo o de unos artículos, a ciegas, línea a línea; «Cerrar y ajustar» se aplica al sincronizar. */
function openCount(source: ItemSource, spaces: SpaceSource, itemIds?: string[]): void {
  let sheet: Sheet | null = null;
  const session = createCountSession({
    source, spaces, spaceId: null, ...(itemIds ? { itemIds } : {}), feedbackId: 'central.inventario.recuento',
    onLeave: () => void sheet?.close(true), onClosed: () => toast('Recuento cerrado.'),
  });
  sheet = openSheet({ title: 'Recuento', hideTitle: true, body: session.element, onClose: () => session.destroy() });
}

const onAction = (source: ItemSource, spaces: SpaceSource) => (action: string, item: ItemRow) =>
  (action === 'count' ? openCount(source, spaces, [item.id]) : openMovement(source, spaces, ACTION_MODES[action]!, item));

/**
 * Inventario (kit 0.37 y 0.38; docs/central/API.md §9.6): el catálogo del kit sin ámbito, porque Central lo ve todo.
 * Buscar, filtros, agrupado por sitio y, para editor y owner, «+ Artículo», «Recuento» y en cada fila Gastar, Entrada y
 * Contar. Sin red, el espejo.
 */
export const mountInventory: ViewMount = ({ main, client, navigate }) => {
  const r = startResources(client);
  const items = createSyncItemSource(r);
  const spaces = createSyncSpaceSource(r);
  const writer = canWrite(client.bootstrap()?.membership.role);
  const catalog = createItemCatalog({
    source: items, spaces, canCreate: writer, storageKey: 'central',
    ...(writer ? { actions: CATALOG_ACTIONS, onAction: onAction(items, spaces) } : {}),
    onOpen: (item) => navigate(`#/inventario/${item.id}`), feedbackId: 'central.inventario.catalogo',
  });
  const linked = LINK_FILTERS[location.hash.split('?')[1] ?? ''];
  if (linked) catalog.setFilter({ ...catalog.getFilter(), ...linked });
  replace(main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.inventario.cabecera', 'data-feedback-label': 'Cabecera de Inventario' },
      el('div', null, el('h2', null, 'Inventario'), el('p', null, 'Lo que hay en la casa, dónde está y cuánto queda. Toca un artículo para ver su ficha.'))),
    writer ? el('div', { class: 'toolbar', 'data-feedback-id': 'central.inventario.barra', 'data-feedback-label': 'Barra de Inventario' },
      el('button', { class: 'ghost', type: 'button', id: 'inventoryCount', 'data-feedback-id': 'central.inventario.recontar', 'data-feedback-label': 'Recuento de todo',
        onclick: () => openCount(items, spaces) }, icon('list', 16), 'Recuento')) : null,
    catalog.element);
  return () => { catalog.destroy(); items.destroy(); spaces.destroy(); };
};

/** Ficha de un artículo (kit 0.37) en página propia: Stock, Datos, Unidades y Movimientos, con quién lo hizo por su ficha de Personas. */
export function mountInventoryItem(itemId: string): ViewMount {
  return ({ main, client }) => {
    let alive = true;
    const r = startResources(client);
    const items = createSyncItemSource(r);
    const spaces = createSyncSpaceSource(r);
    let sheet: { destroy(): void } | null = null;
    const host = el('div', { id: 'inventoryItem' });
    replace(main, el('a', { href: '#/inventario', class: 'backlink', 'data-feedback-id': 'central.articulo.volver', 'data-feedback-label': 'Volver a Inventario' }, '← Inventario'), host);
    void (async () => {
      // Nombres de quien hizo cada movimiento: la cuenta enlazada a una ficha de Personas.
      const people = ((await client.list(T.people)) as unknown as Person[]).filter((p) => !p.deleted_at && p.user_id);
      if (!alive) return;
      const names = new Map(people.map((p) => [p.user_id!, p.display_name]));
      const writer = canWrite(client.bootstrap()?.membership.role);
      const s = createItemSheet({
        source: items, itemId, spaces, permissions: { edit: writer },
        ...(writer ? { actions: SHEET_ACTIONS, onAction: onAction(items, spaces) } : {}),
        sourceLink: (app) => SOURCE_APPS[app] ?? null, personName: (id) => names.get(id) ?? null, feedbackId: 'central.articulo.ficha',
      });
      sheet = s;
      replace(host, s.element);
    })();
    return () => { alive = false; sheet?.destroy(); items.destroy(); spaces.destroy(); };
  };
}
