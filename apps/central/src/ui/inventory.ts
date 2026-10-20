import {
  DEFAULT_SPACE_KINDS, ancestorsOf, createCountSession, createItemCatalog, createItemSheet, createMovementForm, createSyncItemSource, createSyncSpaceSource, el,
  expiryText, icon, indexSpaces, kindOf, lotsWithStock, nextExpiry, openSheet, renderCover, replace, stockBySpace, toast,
  type ItemCatalog, type ItemCatalogAction, type ItemCatalogFilter, type ItemRow, type ItemSheetAction, type ItemSnapshot, type ItemSource, type MovementMode,
  type Sheet, type SpaceRow, type SpaceSource,
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

/** Vista del catálogo: «Baldosas» (la elegida por VG en el Bloque 2, MUELA-076) o «Lista» (la de antes); se recuerda aquí. */
type InventoryView = 'baldosas' | 'lista';
const VIEW_KEY = 'ikisai-central-inventario-vista';
const readView = (): InventoryView => { try { return localStorage.getItem(VIEW_KEY) === 'lista' ? 'lista' : 'baldosas'; } catch { return 'baldosas'; } };
const writeView = (view: InventoryView) => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* sin almacenamiento: solo esta visita */ } };

const levelOf = (row: SpaceRow) => kindOf(DEFAULT_SPACE_KINDS, row.kind)?.level ?? 3;

/**
 * Chips de sitio (076): los espacios (nivel 3: cocina, almacén, sala…) donde hay algo, de más a menos artículos; como
 * mucho seis. Lo que está en un estante cuenta en su espacio.
 */
export function spaceChipsFor(snapshot: ItemSnapshot, spaces: SpaceRow[], max = 6): string[] {
  const index = indexSpaces(spaces);
  const count = new Map<string, Set<string>>();
  for (const line of snapshot.stock) {
    if (line.quantity <= 0) continue;
    const row = index.get(line.spaceId);
    if (!row) continue;
    const room = [...ancestorsOf(index, row.id), row].find((r) => levelOf(r) === 3);
    if (!room || !room.active) continue;
    count.set(room.id, (count.get(room.id) ?? new Set<string>()).add(line.itemId));
  }
  return [...count.entries()]
    .sort((a, b) => b[1].size - a[1].size || index.get(a[0])!.name.localeCompare(index.get(b[0])!.name))
    .slice(0, max).map(([id]) => id);
}

/**
 * Inventario (kit 0.37, 0.38 y 0.50; docs/central/API.md §9.6): el catálogo del kit sin ámbito, porque Central lo ve todo.
 * - **Baldosas** (Bloque 2, MUELA-076): cada artículo con su cifra, el relleno hasta el mínimo y el nivel en palabras.
 *   **Lista**, la de antes, a un toque; la vista se recuerda en el dispositivo.
 * - Buscar, filtros (bajo mínimo, caduca pronto, sitios con chip, tipos y archivados) y agrupado por sitio.
 * - Editor y owner: «+ Artículo», «Recuento» de todo y, en cada artículo, Gastar, Entrada, Contar (solo ese) y Trasladar.
 * Sin red, el espejo.
 */
export const mountInventory: ViewMount = ({ main, client, navigate }) => {
  let alive = true;
  const r = startResources(client);
  const items = createSyncItemSource(r);
  const spaces = createSyncSpaceSource(r);
  const writer = canWrite(client.bootstrap()?.membership.role);
  let view = readView();
  let catalog: ItemCatalog | null = null;
  let chips: string[] = [];
  const host = el('div', { id: 'inventoryCatalog' });
  const viewButton = (value: InventoryView, label: string) => el('button', { type: 'button', dataset: { view: value }, 'aria-pressed': 'false', onclick: () => setView(value) }, label);
  const viewBar = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Cómo verlo', id: 'inventoryView', 'data-feedback-id': 'central.inventario.vista', 'data-feedback-label': 'Baldosas o lista' },
    viewButton('baldosas', 'Baldosas'), viewButton('lista', 'Lista'));

  // «Trasladar» en cada artículo (076), además de Gastar, Entrada y Contar del kit.
  const transferAction = (item: ItemRow) => ({ label: 'Trasladar', feedbackId: 'central.inventario.trasladar', onClick: () => openMovement(items, spaces, 'transfer', item) });

  function build(): void {
    const filter = catalog?.getFilter() ?? null;
    catalog?.destroy();
    catalog = createItemCatalog({
      source: items, spaces, canCreate: writer, storageKey: 'central', layout: view === 'baldosas' ? 'baldosas' : 'list', spaceChips: chips,
      ...(writer ? {
        actions: CATALOG_ACTIONS, onAction: onAction(items, spaces),
        rowActions: (item: ItemRow) => (item.active ? [transferAction(item)] : []),
      } : {}),
      onOpen: (item) => navigate(`#/inventario/${item.id}`), feedbackId: 'central.inventario.catalogo',
    });
    if (filter) catalog.setFilter(filter);
    replace(host, catalog.element);
    for (const b of viewBar.querySelectorAll<HTMLButtonElement>('button')) {
      const on = b.dataset.view === view;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('on', on);
    }
  }
  function setView(next: InventoryView): void {
    if (next === view) return;
    view = next;
    writeView(next);
    build();
  }

  replace(main,
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.inventario.cabecera', 'data-feedback-label': 'Cabecera de Inventario' },
      el('div', null, el('h2', null, 'Inventario'), el('p', null, 'Lo que hay en la casa, dónde está y cuánto queda. Toca un artículo para ver su ficha.'))),
    el('div', { class: 'toolbar', 'data-feedback-id': 'central.inventario.barra', 'data-feedback-label': 'Barra de Inventario' },
      viewBar,
      writer ? el('button', { class: 'ghost', type: 'button', id: 'inventoryCount', 'data-feedback-id': 'central.inventario.recontar', 'data-feedback-label': 'Recuento de todo',
        onclick: () => openCount(items, spaces) }, icon('list', 16), 'Recuento') : null),
    host);
  build();
  const linked = LINK_FILTERS[location.hash.split('?')[1] ?? ''];
  if (linked) catalog!.setFilter({ ...catalog!.getFilter(), ...linked });
  // Los chips de sitio salen de lo que hay (el espejo, también sin red); el catálogo se rehace solo si cambian.
  let snap: ItemSnapshot | null = null;
  let spaceRows: SpaceRow[] | null = null;
  const recompute = () => {
    if (!alive || !snap || !spaceRows) return;
    const next = spaceChipsFor(snap, spaceRows);
    if (next.join() === chips.join()) return;
    chips = next;
    build();
  };
  const offItems = items.subscribe?.((next) => { snap = next; recompute(); }) ?? null;
  const offSpaces = spaces.subscribe((rows) => { spaceRows = rows; recompute(); });
  void Promise.all([items.list(), spaces.list()]).then(([next, rows]) => { snap = next; spaceRows = rows; recompute(); });
  return () => { alive = false; offItems?.(); offSpaces(); catalog?.destroy(); items.destroy(); spaces.destroy(); };
};

/** Lo que pide un artículo ahora (portada y foco, MUELA-048 y 076): reponer, gastar antes o juntar. */
export interface ItemFocus {
  kind: 'reponer' | 'gastar' | 'juntar';
  title: string;
  note: string;
  tone: 'alert' | 'warn' | null;
}

export interface ItemOverview {
  pill: string | null;
  pillTone: 'alert' | 'warn' | 'ok' | null;
  stats: string;
  focus: ItemFocus[];
}

const qty = (n: number, unit: string) => `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: 3 }).format(n)} ${unit}`;

/** Portada (cifras escritas) y foco de un artículo, a partir del espejo. `today` en `YYYY-MM-DD`. */
export function itemOverview(item: ItemRow, snapshot: ItemSnapshot, spaces: SpaceRow[], today: string): ItemOverview {
  const index = indexSpaces(spaces);
  const name = (id: string) => index.get(id)?.name ?? 'Sin sitio';
  const by = stockBySpace(snapshot.stock, item.id);
  const total = Math.round([...by.values()].reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  const min = item.minQuantity && item.minQuantity > 0 ? item.minQuantity : null;
  const low = item.active && min !== null && total < min;
  const justo = !low && min !== null && total < min * 1.25;
  const expiry = snapshot.lots ? nextExpiry(item.id, snapshot.stock, snapshot.lots, today, 7) : null;
  const sites = [...by.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const stats = [
    `${qty(total, item.baseUnit)} en total`,
    min !== null ? `mínimo ${qty(min, item.baseUnit)}` : 'sin mínimo',
    sites.length === 0 ? 'en ningún sitio' : sites.length === 1 ? `en ${name(sites[0]![0])}` : `en ${sites.length} sitios`,
    expiry ? expiryText(expiry, today) : null,
  ].filter(Boolean).join(' · ');
  if (!item.active) return { pill: 'Archivado', pillTone: null, stats, focus: [] };

  const focus: ItemFocus[] = [];
  if (low) {
    focus.push({ kind: 'reponer', tone: 'alert', title: 'Reponer',
      note: `Quedan ${qty(total, item.baseUnit)} y el mínimo es ${qty(min!, item.baseUnit)}.${item.reorderQuantity ? ` Se suele pedir ${qty(item.reorderQuantity, item.baseUnit)}.` : ''}` });
  }
  if (expiry && snapshot.lots) {
    const lot = lotsWithStock(item.id, snapshot.stock, snapshot.lots).find((l) => l.lot?.expiresOn === expiry);
    const what = lot ? `${qty(lot.quantity, item.baseUnit)}${lot.lot?.code ? ` del lote ${lot.lot.code}` : ''} en ${name(lot.spaceId)}` : 'Un lote';
    focus.push({ kind: 'gastar', tone: expiry <= today ? 'alert' : 'warn', title: 'Gastar antes', note: `${what}: ${expiryText(expiry, today)}.` });
  }
  if (sites.length > 1) {
    focus.push({ kind: 'juntar', tone: null, title: 'Juntar',
      note: `Está repartido: ${sites.slice(0, 4).map(([id, n]) => `${qty(n, item.baseUnit)} en ${name(id)}`).join(', ')}${sites.length > 4 ? '…' : ''}.` });
  }
  const pill = low ? 'Bajo mínimo' : expiry ? (expiry <= today ? 'Caducado' : 'Caduca pronto') : justo ? 'Va justo' : min !== null ? 'Bien' : null;
  const pillTone = low || (expiry !== null && expiry <= today) ? 'alert' : expiry || justo ? 'warn' : min !== null ? 'ok' : null;
  return { pill, pillTone, stats, focus };
}

const FOCUS_ACTIONS: Record<ItemFocus['kind'], { label: string; mode: MovementMode }> = {
  reponer: { label: 'Registrar entrada', mode: 'entry' },
  gastar: { label: 'Gastar', mode: 'exit' },
  juntar: { label: 'Trasladar', mode: 'transfer' },
};

/** El botón de cada cosa del foco, con su id de feedback literal (el catálogo no recoge ids construidos). */
function focusButton(kind: ItemFocus['kind'], name: string, onclick: () => void): HTMLElement {
  const { label } = FOCUS_ACTIONS[kind];
  const common = { type: 'button', 'aria-label': `${label}: ${name}`, onclick };
  if (kind === 'reponer') return el('button', { ...common, class: 'softbtn', 'data-feedback-id': 'central.articulo.foco.reponer', 'data-feedback-label': 'Registrar entrada' }, label);
  if (kind === 'gastar') return el('button', { ...common, class: 'softbtn', 'data-feedback-id': 'central.articulo.foco.gastar', 'data-feedback-label': 'Gastar' }, label);
  return el('button', { ...common, class: 'ghost', 'data-feedback-id': 'central.articulo.foco.juntar', 'data-feedback-label': 'Trasladar' }, label);
}

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Ficha de un artículo (kit 0.37) en página propia. Arriba, la portada y el foco (Bloque 2, MUELA-048 y 076): stock,
 * mínimo, sitios y caducidad, y lo que pide ahora (reponer, gastar antes o juntar), con su acción para editor y owner.
 * Debajo, la ficha de siempre: Stock, Datos, Unidades y Movimientos, con quién lo hizo por su ficha de Personas.
 */
export function mountInventoryItem(itemId: string): ViewMount {
  return ({ main, client }) => {
    let alive = true;
    const r = startResources(client);
    const items = createSyncItemSource(r);
    const spaces = createSyncSpaceSource(r);
    const writer = canWrite(client.bootstrap()?.membership.role);
    let sheet: { destroy(): void } | null = null;
    const host = el('div', { id: 'inventoryItem' });
    const overview = el('div', { id: 'inventoryOverview' });
    let snap: ItemSnapshot | null = null;
    let spaceRows: SpaceRow[] = [];

    function paintOverview(): void {
      if (!alive) return;
      const item = snap?.items.find((i) => i.id === itemId) ?? null;
      if (!item || !snap) { replace(overview); return; }
      const o = itemOverview(item, snap, spaceRows, localToday());
      replace(overview,
        renderCover({ title: item.name, compact: true, headingLevel: 2, pill: o.pill, pillTone: o.pillTone, stats: o.stats }),
        o.focus.length ? el('section', { class: 'ctl-itemfocus', 'aria-label': 'Lo que pide ahora', 'data-feedback-id': 'central.articulo.foco', 'data-feedback-label': 'Lo que pide ahora' },
          ...o.focus.map((f) => el('article', { class: `card ctl-itemfocus-card${f.tone ? ` ${f.tone}` : ''}`, dataset: { focus: f.kind } },
            el('h3', null, f.title),
            el('p', null, f.note),
            writer ? focusButton(f.kind, item.name, () => openMovement(items, spaces, FOCUS_ACTIONS[f.kind].mode, item)) : null))) : null);
    }
    const offItems = items.subscribe?.((next) => { snap = next; paintOverview(); }) ?? null;
    const offSpaces = spaces.subscribe((rows) => { spaceRows = rows; paintOverview(); });
    void Promise.all([items.list(), spaces.list()]).then(([next, rows]) => { snap = next; spaceRows = rows; paintOverview(); });

    replace(main, el('a', { href: '#/inventario', class: 'backlink', 'data-feedback-id': 'central.articulo.volver', 'data-feedback-label': 'Volver a Inventario' }, '← Inventario'), overview, host);
    void (async () => {
      // Nombres de quien hizo cada movimiento: la cuenta enlazada a una ficha de Personas.
      const people = ((await client.list(T.people)) as unknown as Person[]).filter((p) => !p.deleted_at && p.user_id);
      if (!alive) return;
      const names = new Map(people.map((p) => [p.user_id!, p.display_name]));
      const s = createItemSheet({
        source: items, itemId, spaces, permissions: { edit: writer },
        ...(writer ? { actions: SHEET_ACTIONS, onAction: onAction(items, spaces) } : {}),
        sourceLink: (app) => SOURCE_APPS[app] ?? null, personName: (id) => names.get(id) ?? null, feedbackId: 'central.articulo.ficha',
      });
      sheet = s;
      replace(host, s.element);
    })();
    return () => { alive = false; offItems?.(); offSpaces(); sheet?.destroy(); items.destroy(); spaces.destroy(); };
  };
}
