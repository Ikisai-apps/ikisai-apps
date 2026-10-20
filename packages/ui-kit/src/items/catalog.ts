/**
 * La lista del inventario (`createItemCatalog`, R3; propuesta aprobada el 18-10-2026).
 *
 * - **Buscar** como `createItemPicker` (nombre y alias, sin tildes) y **filtros a un toque** con cuántos hay: bajo mínimo,
 *   caduca pronto, sitios (`spaceChips`), tipos y archivados. Se recuerdan con `storageKey`.
 * - **Agrupa** por sitio (por defecto), tipo o categoría. En el móvil son filas con botones grandes; en escritorio la misma
 *   lista se alinea en columnas (Artículo, Tipo, Dónde, Stock, Mínimo, Aviso).
 * - **Cada fila:** stock y dónde, mínimo, avisos con texto («bajo mínimo», «caduca mañana») y «sin subir» si está pendiente.
 *   Acciones del kit (`actions` → `onAction`) y de la app (`rowActions`, p. ej. «Pedir» en Tasks).
 * - **Ámbito:** `scope` (sitios, con lo de dentro) y `filter` acotan lo que ve cada app; Central lo monta sin ámbito.
 * - Sin red: lee la fuente (el espejo).
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { formatQuantity } from '../fields/quantity.ts';
import { DEFAULT_SPACE_KINDS, ancestorsOf, indexSpaces, kindOf, spaceDescendants, type SpaceRow, type SpaceSource } from '../spaces/model.ts';
import { openSheet } from '../overlay/sheet.ts';
import { createItemPicker } from './picker.ts';
import { renderTile } from '../pieces/tile.ts';
import { DEFAULT_ITEM_KINDS, kindLabelOf, nextExpiry, searchItems, stockBySpace, type ItemRow, type ItemSnapshot, type ItemSource } from './model.ts';

export type ItemCatalogAction = 'spend' | 'entry' | 'count';

export interface ItemCatalogRowAction {
  label: string;
  onClick: (item: ItemRow) => void;
  feedbackId?: string;
  /** Botón destacado (p. ej. «Pedir» cuando falta). */
  primary?: boolean;
}

export interface ItemCatalogFilter {
  query?: string;
  low?: boolean;
  expiring?: boolean;
  space?: string | null;
  kind?: string | null;
  archived?: boolean;
}

export interface ItemCatalogOptions {
  source: ItemSource;
  spaces?: SpaceSource | SpaceRow[];
  label?: string;
  /** Solo estos tipos (Food: ingrediente y bebida). */
  kinds?: string[];
  /** Solo lo que está o se guarda en estos sitios (y lo de dentro). El stock que se enseña es el de ahí. */
  scope?: string[];
  filter?: (item: ItemRow) => boolean;
  groupBy?: 'space' | 'kind' | 'category';
  /** Días para «Caduca pronto» (7). */
  expiringDays?: number;
  /** Sitios con chip de filtro a un toque («Cocina»). */
  spaceChips?: string[];
  actions?: ItemCatalogAction[];
  onAction?: (action: ItemCatalogAction, item: ItemRow) => void;
  rowActions?: (item: ItemRow) => ItemCatalogRowAction[];
  /**
   * La acción de lo que pide atención («A la compra»): botón destacado, el primero, en las filas y baldosas que lo
   * piden. Por defecto, en lo que está bajo mínimo (`when` cambia la regla).
   */
  focusAction?: ItemCatalogRowAction & { when?: (item: ItemRow, state: { low: boolean; expiring: boolean }) => boolean };
  /** Abrir la ficha (por defecto no hace nada: la app monta `createItemSheet` donde quiera). */
  onOpen?: (item: ItemRow) => void;
  /** «+ Artículo»: alta rápida (la del selector) y después `onOpen` con el nuevo. */
  canCreate?: boolean;
  /** Recordar los filtros en este navegador. */
  storageKey?: string;
  /** Hoy (`YYYY-MM-DD`), para pruebas; por defecto la fecha local. */
  today?: string;
  /**
   * `baldosas` (Inventario de Central y Despensa de Food, elegida por el usuario en el Bloque 2): cada artículo como
   * baldosa con su cifra y el relleno hasta el mínimo (`renderTile`, con el nivel dicho en palabras). Por defecto `list`,
   * igual que siempre.
   */
  layout?: 'list' | 'baldosas';
  feedbackId?: string;
}

export interface ItemCatalog {
  element: HTMLElement;
  /** Con `persist: false` (filtros que llegan por enlace), no se guarda en `storageKey`: al volver, el de la persona. */
  setFilter(filter: ItemCatalogFilter, options?: { persist?: boolean }): void;
  getFilter(): ItemCatalogFilter;
  /** Vuelve a pintar con los datos de ahora sin tocar el filtro: para cuando cambia algo de la app que el catálogo no ve (lo que dan `rowActions` o `filter`, como el «Pedido» de Tasks). */
  refresh(): void;
  destroy(): void;
}

export const ITEM_CATALOG_MARKS = {
  search: ['buscar', 'Buscar en el inventario'],
  filter: ['filtro', 'Filtro del inventario'],
  open: ['abrir', 'Abrir ficha'],
  action: ['accion', 'Acción de la fila'],
  create: ['nuevo', 'Nuevo artículo'],
} as const;

const ACTION_LABELS: Record<ItemCatalogAction, string> = { spend: 'Gastar', entry: 'Entrada', count: 'Contar' };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** «caducado», «caduca hoy», «caduca mañana» o «caduca el 21/10». */
export function expiryText(date: string, today: string): string {
  if (date < today) return kt('caducado');
  if (date === today) return kt('caduca hoy');
  const tomorrow = new Date(Date.parse(`${today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  if (date === tomorrow) return kt('caduca mañana');
  return kt('caduca el {date}', { date: `${date.slice(8, 10)}/${date.slice(5, 7)}` });
}

function readFilter(key: string | undefined): ItemCatalogFilter {
  if (!key) return {};
  try { return JSON.parse(localStorage.getItem(`ikisai-inventory:${key}`) ?? '{}') as ItemCatalogFilter; } catch { return {}; }
}
function writeFilter(key: string | undefined, filter: ItemCatalogFilter): void {
  if (!key) return;
  try { const { query: _q, ...rest } = filter; localStorage.setItem(`ikisai-inventory:${key}`, JSON.stringify(rest)); } catch { /* sin almacenamiento */ }
}

export function createItemCatalog(options: ItemCatalogOptions): ItemCatalog {
  const base = options.feedbackId;
  const mark = (key: keyof typeof ITEM_CATALOG_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${ITEM_CATALOG_MARKS[key][0]}`, 'data-feedback-label': ITEM_CATALOG_MARKS[key][1] } : {});
  const days = options.expiringDays ?? 7;
  const today = options.today ?? localToday();
  let snap: ItemSnapshot = { items: [], units: [], kinds: DEFAULT_ITEM_KINDS, stock: [] };
  let spaceRows: SpaceRow[] = Array.isArray(options.spaces) ? options.spaces : [];
  let spaceIndex = indexSpaces(spaceRows);
  let filter: ItemCatalogFilter = readFilter(options.storageKey);

  const within = (ids: readonly string[]) => [...new Set(ids.flatMap((id) => [id, ...spaceDescendants(spaceRows, id, true)]))];
  const scopeIds = () => (options.scope ? within(options.scope) : null);
  const spaceName = (id: string) => spaceIndex.get(id)?.name ?? kt('Sin sitio');
  /** «A la compra» y similares: primero y destacado en lo que pide atención. */
  const focusButton = (l: { item: ItemRow; low: boolean; expiry: string | null }): HTMLElement | null => {
    const f = options.focusAction;
    if (!f || !l.item.active || !(f.when ? f.when(l.item, { low: l.low, expiring: !!l.expiry }) : l.low)) return null;
    return el('button', { type: 'button', class: 'softbtn small stk-focus', 'aria-label': `${f.label}: ${l.item.name}`, ...(f.feedbackId ? { 'data-feedback-id': f.feedbackId, 'data-feedback-label': f.label } : mark('action')), onclick: () => f.onClick(l.item) }, f.label);
  };

  // --- Estructura ------------------------------------------------------------------------------------------
  const input = el('input', { type: 'search', class: 'space-search stk-search', placeholder: kt('Buscar artículo…'), 'aria-label': kt('Buscar en el inventario'), autocomplete: 'off', ...mark('search'),
    oninput: () => { filter = { ...filter, query: input.value }; paintList(); } }) as HTMLInputElement;
  const createBtn = options.canCreate && options.source.create
    ? el('button', { type: 'button', class: 'primary stk-create', ...mark('create'), onclick: () => openCreate() }, icon('plus', 16), kt('Artículo'))
    : null;
  const chipsHost = el('div', { class: 'stk-chips', role: 'group', 'aria-label': kt('Filtros') });
  const list = el('div', { class: 'stk-list', role: 'list' });
  const live = el('p', { class: 'stk-live', 'aria-live': 'polite' });
  const element = el('section', { class: 'stk-catalog', 'aria-label': options.label ?? kt('Inventario'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label ?? kt('Inventario') } : {}) },
    el('div', { class: 'stk-bar' }, el('div', { class: 'space-search-wrap stk-search-wrap' }, icon('search', 16), input), createBtn),
    chipsHost, live, list);

  // --- Datos -------------------------------------------------------------------------------------------------
  type Line = { item: ItemRow; total: number; by: Map<string, number>; low: boolean; expiry: string | null };
  function lines(): Line[] {
    const scope = scopeIds();
    return snap.items
      .filter((i) => (!options.kinds || options.kinds.includes(i.kind)) && (!options.filter || options.filter(i)))
      .map((item) => {
        const by = stockBySpace(snap.stock, item.id, scope);
        const total = Math.round([...by.values()].reduce((a, b) => a + b, 0) * 1e6) / 1e6;
        const low = item.active && item.minQuantity !== null && item.minQuantity > 0 && total < item.minQuantity;
        return { item, by, total, low, expiry: snap.lots ? nextExpiry(item.id, snap.stock, snap.lots, today, days, scope) : null };
      })
      // Con ámbito: lo que está ahí o se guarda ahí.
      .filter((l) => !scope || l.by.size > 0 || (l.item.defaultSpaceId !== null && scope.includes(l.item.defaultSpaceId)));
  }

  function matches(l: Line, f: ItemCatalogFilter): boolean {
    if (!!f.archived !== !l.item.active) return false;
    if (f.low && !l.low) return false;
    if (f.expiring && !l.expiry) return false;
    if (f.kind && l.item.kind !== f.kind) return false;
    if (f.space) {
      const ids = within([f.space]);
      if (![...l.by.keys()].some((s) => ids.includes(s)) && !(l.item.defaultSpaceId && ids.includes(l.item.defaultSpaceId))) return false;
    }
    return true;
  }

  // --- Pintar ------------------------------------------------------------------------------------------------
  function chip(label: string, on: boolean, toggle: () => void, n?: number): HTMLElement {
    return el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(on), ...mark('filter'), onclick: () => { toggle(); writeFilter(options.storageKey, filter); paint(); } },
      n === undefined ? label : `${label} (${n})`);
  }

  function paintChips(all: Line[]): void {
    const active = all.filter((l) => l.item.active);
    const kinds = [...new Set(active.map((l) => l.item.kind))];
    replace(chipsHost,
      chip(kt('Bajo mínimo'), !!filter.low, () => { filter = { ...filter, low: !filter.low }; }, active.filter((l) => l.low).length),
      snap.lots ? chip(kt('Caduca pronto'), !!filter.expiring, () => { filter = { ...filter, expiring: !filter.expiring }; }, active.filter((l) => l.expiry).length) : null,
      ...(options.spaceChips ?? []).filter((id) => spaceIndex.has(id)).map((id) => chip(spaceName(id), filter.space === id, () => { filter = { ...filter, space: filter.space === id ? null : id }; })),
      ...(kinds.length > 1 ? kinds.map((k) => chip(kindLabelOf(snap.kinds, k), filter.kind === k, () => { filter = { ...filter, kind: filter.kind === k ? null : k }; })) : []),
      all.some((l) => !l.item.active) ? chip(kt('Archivados'), !!filter.archived, () => { filter = { ...filter, archived: !filter.archived }; }) : null);
  }

  function groupOf(l: Line): string {
    if (options.groupBy === 'kind') return kindLabelOf(snap.kinds, l.item.kind);
    if (options.groupBy === 'category') return l.item.category?.trim() || kt('Sin categoría');
    // Por sitio: donde más hay (sin stock, el habitual), al nivel de espacio: la despensa va con su cocina.
    const top = [...l.by.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? l.item.defaultSpaceId;
    const row = top ? spaceIndex.get(top) : undefined;
    if (!row) return kt('Sin sitio');
    const level = (r: SpaceRow) => kindOf(DEFAULT_SPACE_KINDS, r.kind)?.level ?? 3;
    const chain = [...ancestorsOf(spaceIndex, row.id), row];
    return (chain.find((r) => level(r) === 3) ?? row).name;
  }

  function where(l: Line): string {
    if (l.by.size > 1) return kt('{n} sitios', { n: String(l.by.size) });
    const only = [...l.by.keys()][0] ?? null;
    return only ? spaceName(only) : l.item.defaultSpaceId ? spaceName(l.item.defaultSpaceId) : '—';
  }

  function row(l: Line): HTMLElement {
    const it = l.item;
    const unit = it.baseUnit;
    const actions = [
      ...[focusButton(l)].filter((b): b is HTMLElement => !!b),
      ...(options.onAction && it.active ? (options.actions ?? []).map((a) => el('button', { type: 'button', class: 'ghost small', ...mark('action'), onclick: () => options.onAction!(a, it) }, kt(ACTION_LABELS[a]))) : []),
      ...(options.rowActions?.(it) ?? []).map((a) => el('button', { type: 'button', class: a.primary ? 'softbtn small' : 'ghost small', ...(a.feedbackId ? { 'data-feedback-id': a.feedbackId, 'data-feedback-label': a.label } : mark('action')), onclick: () => a.onClick(it) }, a.label)),
    ];
    const warn = l.low ? el('span', { class: 'stk-warn' }, kt('Bajo mínimo')) : l.expiry ? el('span', { class: l.expiry <= today ? 'stk-alert' : 'stk-warn' }, expiryText(l.expiry, today)) : null;
    return el('div', { class: `stk-row${l.low ? ' low' : ''}${it.active ? '' : ' archived'}${it.pending ? ' pending' : ''}`, role: 'listitem', dataset: { itemId: it.id } },
      el('span', { class: 'stk-name' },
        el('button', { type: 'button', class: 'stk-open', ...mark('open'), onclick: () => options.onOpen?.(it), 'aria-label': kt('Abrir {name}', { name: it.name }) }, it.name),
        it.pending ? el('span', { class: 'chip pending' }, kt('sin subir')) : null,
        it.active ? null : el('span', { class: 'chip trash' }, kt('archivado'))),
      el('span', { class: 'stk-kind' }, kindLabelOf(snap.kinds, it.kind)),
      el('span', { class: 'stk-where' }, where(l)),
      el('span', { class: 'stk-qty' }, `${formatQuantity(l.total, 3)} ${unit}`),
      el('span', { class: 'stk-min' }, it.minQuantity ? el('span', null, el('span', { class: 'stk-min-label' }, kt('mín.') + ' '), `${formatQuantity(it.minQuantity, 3)} ${unit}`) : el('span', { class: 'stk-none' }, '—')),
      el('span', { class: 'stk-note' }, warn),
      actions.length ? el('span', { class: 'stk-actions' }, ...actions) : el('span', { class: 'stk-actions empty' }));
  }

  /** Baldosa del artículo: la mitad del relleno es el mínimo; rojo si está por debajo, ámbar si va justo. */
  function tile(l: Line): HTMLElement {
    const it = l.item;
    const min = it.minQuantity && it.minQuantity > 0 ? it.minQuantity : null;
    const tone = min === null ? null : l.total < min ? 'alert' : l.total < min * 1.25 ? 'warn' : 'ok';
    const levelText = l.low ? kt('Bajo mínimo')
      : l.expiry ? expiryText(l.expiry, today)
        : tone === 'warn' ? kt('Va justo')
          : tone === 'ok' ? kt('Bien')
            : where(l);
    const actions = [
      ...[focusButton(l)].filter((b): b is HTMLElement => !!b),
      ...(options.onAction && it.active ? (options.actions ?? []).map((a) => el('button', { type: 'button', class: 'ghost small', ...mark('action'), 'aria-label': `${kt(ACTION_LABELS[a])}: ${it.name}`, onclick: () => options.onAction!(a, it) }, kt(ACTION_LABELS[a]))) : []),
      ...(options.rowActions?.(it) ?? []).map((a) => el('button', { type: 'button', class: a.primary ? 'softbtn small' : 'ghost small', 'aria-label': `${a.label}: ${it.name}`, ...(a.feedbackId ? { 'data-feedback-id': a.feedbackId, 'data-feedback-label': a.label } : mark('action')), onclick: () => a.onClick(it) }, a.label)),
    ];
    return el('div', { class: `stk-tilecell${l.low ? ' low' : ''}${it.active ? '' : ' archived'}`, role: 'listitem', dataset: { itemId: it.id } },
      renderTile({
        title: it.name, value: `${formatQuantity(l.total, 3)} ${it.baseUnit}`, levelText,
        level: min === null ? null : { pct: (l.total / (min * 2)) * 100, min: 50, tone },
        medal: { name: it.name }, onClick: () => options.onOpen?.(it),
        ...(base ? { feedbackId: `${base}.${ITEM_CATALOG_MARKS.open[0]}` } : {}),
      }),
      actions.length ? el('div', { class: 'stk-tileactions' }, ...actions) : null);
  }

  function paintList(): void {
    const all = lines();
    const q = (filter.query ?? '').trim();
    const found = q ? new Set(searchItems(all.map((l) => l.item), q, { includeArchived: true }).map((i) => i.id)) : null;
    const shown = all.filter((l) => matches(l, filter) && (!found || found.has(l.item.id)));
    const groups = new Map<string, Line[]>();
    for (const l of shown.sort((a, b) => a.item.name.localeCompare(b.item.name))) {
      const g = groupOf(l);
      groups.set(g, [...(groups.get(g) ?? []), l]);
    }
    const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (options.layout === 'baldosas') {
      replace(list,
        ...ordered.flatMap(([g, ls]) => [el('div', { class: 'stk-group', role: 'heading', 'aria-level': '3' }, `${g} · ${ls.length}`), el('div', { class: 'stk-tiles', role: 'list' }, ...ls.map(tile))]),
        shown.length ? null : el('p', { class: 'hint stk-empty' }, all.length ? kt('Nada coincide con estos filtros.') : kt('Aún no hay artículos.')));
      list.classList.add('stk-list-tiles');
      list.removeAttribute('role');
      live.textContent = shown.length === 1 ? kt('1 artículo') : kt('{n} artículos', { n: String(shown.length) });
      return;
    }
    replace(list,
      shown.length ? el('div', { class: 'stk-head', 'aria-hidden': 'true' }, ...[kt('Artículo'), kt('Tipo'), kt('Dónde'), kt('Stock'), kt('Mínimo'), kt('Aviso'), ''].map((h) => el('span', null, h))) : null,
      ...ordered.flatMap(([g, ls]) => [el('div', { class: 'stk-group', role: 'heading', 'aria-level': '3' }, `${g} · ${ls.length}`), ...ls.map(row)]),
      shown.length ? null : el('p', { class: 'hint stk-empty' }, all.length ? kt('Nada coincide con estos filtros.') : kt('Aún no hay artículos.')));
    live.textContent = shown.length === 1 ? kt('1 artículo') : kt('{n} artículos', { n: String(shown.length) });
  }

  function paint(): void {
    if (input.value !== (filter.query ?? '')) input.value = filter.query ?? '';
    paintChips(lines());
    paintList();
  }

  // --- Alta rápida -------------------------------------------------------------------------------------------
  function openCreate(): void {
    let sheet: ReturnType<typeof openSheet> | null = null;
    const picker = createItemPicker({
      label: kt('Nombre del artículo'), source: options.source, ...(options.kinds ? { kinds: options.kinds } : {}), ...(options.spaces ? { spaces: options.spaces } : {}),
      placeholder: kt('Escribe el nombre; si ya existe, sale aquí'),
      onChange: (pick) => {
        if (!pick.itemId) return;
        const it = snap.items.find((i) => i.id === pick.itemId) ?? null;
        void sheet?.close(true);
        if (it) options.onOpen?.(it); else setTimeout(() => { const later = snap.items.find((i) => i.id === pick.itemId); if (later) options.onOpen?.(later); }, 0);
      },
    });
    sheet = openSheet({ title: kt('Nuevo artículo'), body: picker.element, onClose: () => picker.destroy() });
    picker.focus();
  }

  // --- Fuente ------------------------------------------------------------------------------------------------
  const setSnapshot = (next: ItemSnapshot) => { snap = next; paint(); };
  const offSource = options.source.subscribe?.(setSnapshot);
  const offSpaces = options.spaces && !Array.isArray(options.spaces) ? options.spaces.subscribe((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); }) : null;
  if (options.spaces && !Array.isArray(options.spaces)) void Promise.resolve(options.spaces.list()).then((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); });
  void Promise.resolve(options.source.list()).then(setSnapshot);
  paint();

  return {
    element,
    setFilter(next, how) { filter = { ...next }; if (how?.persist !== false) writeFilter(options.storageKey, filter); paint(); },
    getFilter: () => ({ ...filter }),
    refresh: paint,
    destroy() { offSource?.(); offSpaces?.(); element.remove(); },
  };
}
