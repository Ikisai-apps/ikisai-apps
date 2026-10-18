/**
 * Ficha de un artículo (`createItemSheet`, R3; propuesta aprobada el 18-10-2026). No abre pantalla propia: la app monta
 * `element` en su página, en una hoja o en el panel derecho.
 *
 * - **Stock** (primera pestaña): por sitio y lote con su caducidad, total, bajo mínimo y coste medio (como `item_costs`,
 *   calculado del espejo para que funcione sin red). Acciones al pie (`actions` → `onAction`).
 * - **Datos:** nombre (sin repetir), tipo, categoría, unidad base (fija si ya hay movimientos), mínimo, «Al pedir, cuánto»,
 *   sitio habitual, proveedor (selector de la app, `supplierField`), otros nombres (`attributes.aliases`), lotes y
 *   caducidad, notas; máquinas y herramientas, además, marca, modelo, serie, estado y factura de compra. Archivar o
 *   recuperar (con movimientos no se borra).
 * - **Unidades:** conversiones (`item_units`): unidad, cuántas de la base y proveedor.
 * - **Movimientos:** por fecha, con signo, en palabras y con el origen que enlaza la app (`sourceLink`). Con ancho (≥ 760 px
 *   de contenedor) va siempre a la derecha.
 * - `permissions.edit = false`: solo lectura.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { createQuantityField, formatQuantity, parseQuantity } from '../fields/quantity.ts';
import { confirmDialog } from '../overlay/dialog.ts';
import { createSpacePicker } from '../spaces/picker.ts';
import { indexSpaces, type SpaceRow, type SpaceSource } from '../spaces/model.ts';
import { expiryText } from './catalog.ts';
import {
  BASE_UNITS, DEFAULT_ITEM_KINDS, EQUIPMENT_KINDS, EXIT_REASON_LABELS, ITEM_STATUS_LABELS, MOVEMENT_KIND_LABELS,
  averageCost, kindLabelOf, lotsWithStock, newItemId, sameNameItem, stockSummary,
  type ItemRow, type ItemSnapshot, type ItemSource, type ItemUnitRow, type MovementRow,
} from './model.ts';

export type ItemSheetTab = 'stock' | 'data' | 'units' | 'movements';
export type ItemSheetAction = 'spend' | 'entry' | 'transfer' | 'count';

export interface ItemSheetOptions {
  source: ItemSource;
  itemId: string;
  spaces?: SpaceSource | SpaceRow[];
  tab?: ItemSheetTab;
  permissions?: { edit: boolean };
  /** Selector de proveedor de la app (Finance): recibe el valor y avisa del cambio. */
  supplierField?: (value: string | null, onChange: (id: string | null) => void) => HTMLElement;
  /** Proveedores para las conversiones (`item_units.supplier_id`). */
  suppliers?: Array<{ id: string; name: string }>;
  /** Enlace al origen de un movimiento («Factura 2026-311»). */
  sourceLink?: (app: string, ref: string) => { label: string; href?: string; onClick?: () => void } | null;
  /** Nombre de quien hizo un movimiento. */
  personName?: (id: string) => string | null;
  actions?: ItemSheetAction[];
  onAction?: (action: ItemSheetAction, item: ItemRow) => void;
  /** Moneda del coste medio (EUR). */
  currency?: string;
  today?: string;
  feedbackId?: string;
}

export interface ItemSheet {
  element: HTMLElement;
  setTab(tab: ItemSheetTab): void;
  destroy(): void;
}

export const ITEM_SHEET_MARKS = {
  tab: ['pestana', 'Pestaña de la ficha'],
  action: ['accion', 'Acción del artículo'],
  save: ['guardar', 'Guardar datos'],
  archive: ['archivar', 'Archivar o recuperar'],
  alias: ['alias', 'Otro nombre'],
  unitAdd: ['unidad-nueva', 'Añadir unidad'],
  unitSave: ['unidad-guardar', 'Guardar unidad'],
  unitRemove: ['unidad-quitar', 'Quitar unidad'],
  more: ['mas', 'Ver más movimientos'],
} as const;

const TABS: Array<[ItemSheetTab, string]> = [['stock', 'Stock'], ['data', 'Datos'], ['units', 'Unidades'], ['movements', 'Movimientos']];
const ACTION_LABELS: Record<ItemSheetAction, string> = { spend: 'Gastar', entry: 'Entrada', transfer: 'Trasladar', count: 'Contar' };
let uid = 0;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createItemSheet(options: ItemSheetOptions): ItemSheet {
  const id = `kit-item-sheet-${++uid}`;
  const base = options.feedbackId;
  const mark = (key: keyof typeof ITEM_SHEET_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${ITEM_SHEET_MARKS[key][0]}`, 'data-feedback-label': ITEM_SHEET_MARKS[key][1] } : {});
  const canEdit = options.permissions?.edit !== false && !!options.source.update;
  const today = options.today ?? localToday();
  let snap: ItemSnapshot = { items: [], units: [], kinds: DEFAULT_ITEM_KINDS, stock: [] };
  let spaceRows: SpaceRow[] = Array.isArray(options.spaces) ? options.spaces : [];
  let spaceIndex = indexSpaces(spaceRows);
  let tab: ItemSheetTab = options.tab ?? 'stock';
  let shownMovements = 20;
  /** El formulario de Datos no se repinta mientras se edita (la fuente avisa de cada cambio). */
  let dataDirty = false;

  const item = () => snap.items.find((i) => i.id === options.itemId) ?? null;
  const spaceName = (sid: string) => spaceIndex.get(sid)?.name ?? kt('Sin sitio');
  const qty = (n: number, unit: string) => `${formatQuantity(n, 3)} ${unit}`;

  const title = el('h3', { class: 'stk-sheet-title', id: `${id}-title` });
  const meta = el('p', { class: 'stk-sheet-meta' });
  const tabs = el('div', { class: 'stk-tabs', role: 'tablist', 'aria-labelledby': `${id}-title` });
  const panels: Record<ItemSheetTab, HTMLElement> = {
    stock: el('div', { class: 'stk-panel', role: 'tabpanel', id: `${id}-stock`, 'aria-labelledby': `${id}-tab-stock` }),
    data: el('div', { class: 'stk-panel', role: 'tabpanel', id: `${id}-data`, 'aria-labelledby': `${id}-tab-data` }),
    units: el('div', { class: 'stk-panel', role: 'tabpanel', id: `${id}-units`, 'aria-labelledby': `${id}-tab-units` }),
    movements: el('div', { class: 'stk-panel stk-movements', role: 'tabpanel', id: `${id}-movements`, 'aria-labelledby': `${id}-tab-movements` }),
  };
  // `.stk-sheet` es el contenedor de las consultas de ancho; `.stk-sheet-body`, la rejilla que cambia.
  const body = el('div', { class: 'stk-sheet-body' },
    el('div', { class: 'stk-sheet-main' }, el('header', { class: 'stk-sheet-head' }, title, meta), tabs, panels.stock, panels.data, panels.units),
    el('aside', { class: 'stk-sheet-side' }, el('h4', { class: 'stk-side-title' }, kt('Movimientos')), panels.movements));
  const element = el('section', { class: 'stk-sheet', dataset: { tab }, 'aria-labelledby': `${id}-title`, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': kt('Ficha del artículo') } : {}) }, body);

  // --- Pestañas ----------------------------------------------------------------------------------------------
  function paintTabs(): void {
    replace(tabs, ...TABS.map(([t, label], i) => el('button', {
      type: 'button', role: 'tab', id: `${id}-tab-${t}`, class: `stk-tab${t === 'movements' ? ' stk-tab-movements' : ''}`, 'aria-controls': `${id}-${t}`,
      'aria-selected': String(tab === t), tabindex: tab === t ? '0' : '-1', ...mark('tab'),
      onclick: () => setTab(t),
      onkeydown: (e: Event) => {
        const k = (e as KeyboardEvent).key;
        if (k !== 'ArrowRight' && k !== 'ArrowLeft') return;
        e.preventDefault();
        const next = TABS[(i + (k === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length]![0];
        setTab(next);
        tabs.querySelector<HTMLElement>(`#${id}-tab-${next}`)?.focus();
      },
    }, kt(label))));
    // Movimientos no usa `hidden`: con ancho se ve siempre (lo decide el CSS con `data-tab`).
    for (const [t] of TABS) if (t !== 'movements') panels[t].hidden = t !== tab;
    element.dataset.tab = tab;
  }
  function setTab(next: ItemSheetTab): void { tab = next; paintTabs(); }

  // --- Cabecera y stock --------------------------------------------------------------------------------------
  function paintHead(it: ItemRow): void {
    title.textContent = it.name;
    const parts = [kindLabelOf(snap.kinds, it.kind), kt('base {unit}', { unit: it.baseUnit })];
    if (it.minQuantity) parts.push(kt('mínimo {q}', { q: qty(it.minQuantity, it.baseUnit) }));
    if (it.reorderQuantity) parts.push(kt('pedir {q}', { q: qty(it.reorderQuantity, it.baseUnit) }));
    if (it.defaultSupplierId) { const s = options.source.supplierName?.(it.defaultSupplierId); if (s) parts.push(s); }
    replace(meta, parts.join(' · '), it.pending ? el('span', { class: 'chip pending' }, kt('sin subir')) : null, it.active ? null : el('span', { class: 'chip trash' }, kt('archivado')));
  }

  function paintStock(it: ItemRow): void {
    const lots = lotsWithStock(it.id, snap.stock, snap.lots ?? []);
    const bySpace = new Map<string, typeof lots>();
    for (const l of lots) bySpace.set(l.spaceId, [...(bySpace.get(l.spaceId) ?? []), l]);
    const summary = stockSummary(it, snap.stock);
    const cost = snap.movements ? averageCost(it.id, snap.movements, snap.movementCosts ?? []) : null;
    const money = new Intl.NumberFormat('es-ES', { style: 'currency', currency: options.currency ?? 'EUR', maximumFractionDigits: 3 });
    const rows: HTMLElement[] = [];
    for (const [sid, ls] of [...bySpace.entries()].sort((a, b) => spaceName(a[0]).localeCompare(spaceName(b[0])))) {
      const total = ls.reduce((a, l) => a + l.quantity, 0);
      rows.push(el('dt', null, spaceName(sid)), el('dd', null, el('strong', null, qty(total, it.baseUnit)),
        ...ls.filter((l) => l.lot).map((l) => el('span', { class: 'stk-lot' }, ` · ${kt('lote {code}', { code: l.lot!.code ?? '—' })}`, l.lot!.expiresOn ? `, ${expiryText(l.lot!.expiresOn, today)}` : '', ls.length > 1 ? ` (${qty(l.quantity, it.baseUnit)})` : ''))));
    }
    const actions = options.onAction && it.active ? (options.actions ?? []).map((a) => el('button', { type: 'button', class: 'ghost small', ...mark('action'), onclick: () => options.onAction!(a, it) }, kt(ACTION_LABELS[a]))) : [];
    replace(panels.stock,
      el('dl', { class: 'stk-kv' },
        ...(rows.length ? rows : [el('dt', null, kt('Stock')), el('dd', null, kt('sin stock'))]),
        el('dt', null, kt('Total')), el('dd', null, el('strong', null, qty(summary.total, it.baseUnit)), summary.low ? el('span', { class: 'stk-warn' }, ` ${kt('bajo mínimo ({min})', { min: qty(it.minQuantity!, it.baseUnit) })}`) : null),
        el('dt', null, kt('Coste medio')), el('dd', null, cost ? kt('{cost}/{unit} (con {q} con coste)', { cost: money.format(cost.averageCost), unit: it.baseUnit, q: qty(cost.costedQuantity, it.baseUnit) }) : kt('sin entradas con coste'))),
      actions.length ? el('div', { class: 'stk-sheet-actions' }, ...actions) : null);
  }

  // --- Datos -------------------------------------------------------------------------------------------------
  function paintData(it: ItemRow): void {
    if (dataDirty) return;
    const ro = !canEdit;
    const hasMovements = (snap.movements ?? []).some((m) => m.itemId === it.id) || snap.stock.some((s) => s.itemId === it.id);
    const status = el('p', { class: 'stk-save-status', role: 'status', 'aria-live': 'polite' });
    const touch = () => { dataDirty = true; save.disabled = ro || !!nameProblem(); };
    const field = (label: string, control: HTMLElement, hint?: string) => el('label', { class: 'field' }, el('span', null, label), control, hint ? el('span', { class: 'hint' }, hint) : null);

    const name = el('input', { type: 'text', id: `${id}-name`, value: it.name, maxlength: '120', disabled: ro, 'aria-describedby': `${id}-name-hint`, oninput: () => { touch(); paintNameHint(); } }) as HTMLInputElement;
    const nameHint = el('span', { class: 'hint suggest', id: `${id}-name-hint`, 'aria-live': 'polite' });
    const nameProblem = () => {
      if (!name.value.trim()) return kt('Escribe el nombre.');
      const same = sameNameItem(snap.items.filter((i) => i.id !== it.id), name.value);
      return same ? kt('Ya existe «{name}».', { name: same.name }) : null;
    };
    const paintNameHint = () => { const p = nameProblem(); nameHint.textContent = p ?? ''; nameHint.classList.toggle('warn', !!p); };

    const kind = el('select', { disabled: ro, onchange: () => { touch(); paintEquipment(); } }, ...snap.kinds.map((k) => el('option', { value: k.kind, selected: k.kind === it.kind }, k.label))) as HTMLSelectElement;
    const categories = [...new Set(snap.items.map((i) => i.category).filter((c): c is string => !!c))].sort();
    const category = el('input', { type: 'text', value: it.category ?? '', list: `${id}-categories`, disabled: ro, oninput: touch }) as HTMLInputElement;
    const units = [...new Set([it.baseUnit, ...BASE_UNITS])];
    const baseUnit = el('select', { disabled: ro || hasMovements, onchange: touch }, ...units.map((u) => el('option', { value: u, selected: u === it.baseUnit }, u))) as HTMLSelectElement;
    const min = createQuantityField({ label: kt('Mínimo'), name: `${id}-min`, id: `${id}-min`, value: it.minQuantity, unit: it.baseUnit, decimals: 3, min: 0, disabled: ro, onChange: touch });
    const reorder = createQuantityField({ label: kt('Al pedir, cuánto'), name: `${id}-reorder`, id: `${id}-reorder`, value: it.reorderQuantity, unit: it.baseUnit, decimals: 3, min: 0, disabled: ro, hint: kt('Vacío: lo que falte hasta el mínimo.'), onChange: touch });
    let defaultSpace = it.defaultSpaceId;
    const spacePicker = spaceRows.length || (options.spaces && !Array.isArray(options.spaces))
      ? createSpacePicker({ label: kt('Dónde se guarda'), ...(Array.isArray(options.spaces) ? { rows: options.spaces } : options.spaces ? { source: options.spaces } : {}), value: it.defaultSpaceId, onChange: (ids) => { defaultSpace = ids[0] ?? null; touch(); } })
      : null;
    let supplier = it.defaultSupplierId;
    const supplierEl = options.supplierField ? options.supplierField(it.defaultSupplierId, (sid) => { supplier = sid; touch(); }) : null;
    let aliases = it.aliases.slice();
    const aliasHost = el('div', { class: 'stk-aliases' });
    const aliasInput = el('input', { type: 'text', placeholder: kt('Otro nombre (del proveedor, el de antes…)'), disabled: ro, 'aria-label': kt('Otro nombre'),
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); addAlias(); } } }) as HTMLInputElement;
    const addAlias = () => { const v = aliasInput.value.trim(); if (v && !aliases.includes(v)) { aliases = [...aliases, v]; touch(); paintAliases(); } aliasInput.value = ''; };
    const paintAliases = () => replace(aliasHost, ...aliases.map((a) => el('span', { class: 'chip' }, el('span', null, a),
      ro ? null : el('button', { type: 'button', class: 'x', 'aria-label': kt('Quitar {name}', { name: a }), onclick: () => { aliases = aliases.filter((x) => x !== a); touch(); paintAliases(); } }, '×'))));
    paintAliases();
    const lots = el('input', { type: 'checkbox', checked: it.tracksLots, disabled: ro, onchange: touch }) as HTMLInputElement;
    const expiry = el('input', { type: 'checkbox', checked: it.tracksExpiry, disabled: ro, onchange: touch }) as HTMLInputElement;
    const notes = el('textarea', { rows: '3', disabled: ro, oninput: touch }) as HTMLTextAreaElement;
    notes.value = it.notes ?? '';

    const attr = (key: string) => String(it.attributes[key] ?? '');
    const brand = el('input', { type: 'text', value: attr('brand'), disabled: ro, oninput: touch }) as HTMLInputElement;
    const model = el('input', { type: 'text', value: attr('model'), disabled: ro, oninput: touch }) as HTMLInputElement;
    const serial = el('input', { type: 'text', value: attr('serial_number'), disabled: ro, oninput: touch }) as HTMLInputElement;
    const statusSel = el('select', { disabled: ro, onchange: touch }, el('option', { value: '' }, '—'), ...Object.entries(ITEM_STATUS_LABELS).map(([v, l]) => el('option', { value: v, selected: v === attr('status') }, kt(l)))) as HTMLSelectElement;
    const purchase = el('input', { type: 'text', value: attr('purchase_ref'), disabled: ro, placeholder: kt('p. ej. factura 2026-118'), oninput: touch }) as HTMLInputElement;
    const equipment = el('fieldset', { class: 'stk-equipment' }, el('legend', null, kt('Máquina o herramienta')),
      el('div', { class: 'stk-grid2' }, field(kt('Marca'), brand), field(kt('Modelo'), model), field(kt('Número de serie'), serial), field(kt('Estado'), statusSel)),
      field(kt('Factura de compra (garantía)'), purchase));
    const paintEquipment = () => { equipment.hidden = !EQUIPMENT_KINDS.includes(kind.value); };
    paintEquipment();

    const save = el('button', { type: 'button', class: 'primary', disabled: true, ...mark('save'), onclick: () => void doSave() }, kt('Guardar')) as HTMLButtonElement;
    const archive = options.source.setActive && canEdit
      ? el('button', { type: 'button', class: 'ghost', ...mark('archive'), onclick: () => void doArchive() }, it.active ? kt('Archivar') : kt('Recuperar'))
      : null;

    async function doSave(): Promise<void> {
      if (nameProblem()) { paintNameHint(); name.focus(); return; }
      const num = (f: typeof min) => { const v = f.get().value; return v === null || Number.isNaN(v) ? null : v; };
      const attributes: Record<string, unknown> = { ...it.attributes };
      const setAttr = (key: string, value: string) => { if (value.trim()) attributes[key] = value.trim(); else delete attributes[key]; };
      if (EQUIPMENT_KINDS.includes(kind.value)) { setAttr('brand', brand.value); setAttr('model', model.value); setAttr('serial_number', serial.value); setAttr('status', statusSel.value); setAttr('purchase_ref', purchase.value); }
      const next: Partial<ItemRow> = {
        name: name.value.trim(), kind: kind.value, category: category.value.trim() || null, baseUnit: baseUnit.value,
        minQuantity: num(min), reorderQuantity: num(reorder), defaultSpaceId: defaultSpace, defaultSupplierId: supplier,
        tracksLots: lots.checked, tracksExpiry: expiry.checked, notes: notes.value.trim() || null, aliases, attributes,
      };
      // Solo lo que cambia.
      const diff: Partial<ItemRow> = {};
      for (const [k, v] of Object.entries(next) as Array<[keyof ItemRow, unknown]>) if (JSON.stringify(v) !== JSON.stringify(it[k])) (diff as Record<string, unknown>)[k] = v;
      if (!Object.keys(diff).length) { status.textContent = kt('Sin cambios.'); dataDirty = false; save.disabled = true; return; }
      save.disabled = true;
      try {
        await options.source.update!(it.id, diff);
        dataDirty = false;
        status.textContent = kt('Guardado.');
      } catch (error) {
        save.disabled = false;
        status.textContent = kt('No se ha guardado: {message}', { message: (error as Error)?.message ?? '' });
        status.classList.add('error');
      }
    }

    async function doArchive(): Promise<void> {
      if (it.active) {
        const ok = await confirmDialog({ title: kt('¿Archivar «{name}»?', { name: it.name }), text: kt('No saldrá en las listas ni al elegir. Su stock y sus movimientos se conservan, y se puede recuperar.'), confirmLabel: kt('Archivar') });
        if (!ok) return;
      }
      await options.source.setActive!(it.id, !it.active);
    }

    replace(panels.data,
      el('datalist', { id: `${id}-categories` }, ...categories.map((c) => el('option', { value: c }))),
      el('div', { class: 'field' }, el('label', { for: `${id}-name` }, kt('Nombre')), name, nameHint),
      el('div', { class: 'stk-grid2' }, field(kt('Tipo'), kind), field(kt('Categoría'), category), field(kt('Unidad base'), baseUnit, hasMovements ? kt('Con movimientos no se cambia: se cuentan en ella.') : undefined)),
      el('div', { class: 'stk-grid2' }, min.element, reorder.element),
      spacePicker?.element ?? null,
      supplierEl ? el('div', { class: 'stk-supplier' }, el('span', { class: 'space-picker-label' }, kt('Proveedor habitual')), supplierEl) : null,
      el('div', { class: 'stk-alias-field' }, el('span', { class: 'space-picker-label' }, kt('Otros nombres')), aliasHost, ro ? null : el('div', { class: 'stk-alias-add' }, aliasInput, el('button', { type: 'button', class: 'ghost small', ...mark('alias'), onclick: addAlias }, kt('Añadir'))),
        el('span', { class: 'hint' }, kt('También se busca por ellos: el nombre en la factura, el de antes…'))),
      el('label', { class: 'checkline' }, lots, ' ', kt('Lleva lotes')),
      el('label', { class: 'checkline' }, expiry, ' ', kt('Lleva caducidad')),
      equipment,
      field(kt('Notas'), notes),
      canEdit ? el('div', { class: 'stk-sheet-actions' }, archive, save) : null,
      status);
    paintNameHint();
  }

  // --- Unidades ----------------------------------------------------------------------------------------------
  function paintUnits(it: ItemRow): void {
    const own = snap.units.filter((u) => u.itemId === it.id);
    const ro = !canEdit || !options.source.saveUnit;
    const supplierName = (sid: string | null) => (sid ? options.suppliers?.find((s) => s.id === sid)?.name ?? options.source.supplierName?.(sid) ?? kt('Proveedor') : kt('Cualquiera'));
    const unitRow = (u: ItemUnitRow, isNew: boolean): HTMLElement => {
      const unit = el('input', { type: 'text', value: u.unit, maxlength: '16', 'aria-label': kt('Unidad'), disabled: ro, placeholder: kt('saco, caja…') }) as HTMLInputElement;
      const factor = el('input', { type: 'text', inputmode: 'decimal', value: u.factor ? formatQuantity(u.factor, 6) : '', 'aria-label': kt('Cuántas {unit}', { unit: it.baseUnit }), disabled: ro }) as HTMLInputElement;
      const supplier = options.suppliers?.length
        ? el('select', { 'aria-label': kt('Proveedor'), disabled: ro }, el('option', { value: '' }, kt('Cualquiera')), ...options.suppliers.map((s) => el('option', { value: s.id, selected: s.id === u.supplierId }, s.name))) as HTMLSelectElement
        : null;
      const error = el('span', { class: 'fielderror', role: 'alert' });
      const check = (): string | null => {
        const name = unit.value.trim();
        const f = parseQuantity(factor.value);
        if (!name) return kt('Escribe la unidad.');
        if (name === it.baseUnit) return kt('Es la unidad base: no hace falta.');
        if (f === null || Number.isNaN(f) || f <= 0) return kt('Cuántas {unit} hay en una: un número mayor que 0.', { unit: it.baseUnit });
        const sid = supplier ? supplier.value || null : u.supplierId;
        if (own.some((o) => o.id !== u.id && o.unit === name && o.supplierId === sid)) return kt('Ya está esa unidad para ese proveedor.');
        return null;
      };
      return el('div', { class: `stk-unit${isNew ? ' new' : ''}`, dataset: { unitId: u.id } },
        el('span', { class: 'stk-unit-eq' }, '1 ', unit, ' = ', factor, ` ${it.baseUnit}`),
        supplier ?? el('span', { class: 'stk-unit-supplier' }, supplierName(u.supplierId)),
        ro ? null : el('span', { class: 'stk-unit-actions' },
          el('button', { type: 'button', class: 'ghost small', ...mark('unitSave'), onclick: async () => {
            const problem = check();
            error.textContent = problem ?? '';
            if (problem) return;
            await options.source.saveUnit!({ id: u.id, itemId: it.id, unit: unit.value.trim(), factor: parseQuantity(factor.value)!, supplierId: supplier ? supplier.value || null : u.supplierId }, isNew);
          } }, kt('Guardar')),
          isNew ? el('button', { type: 'button', class: 'ghost small', onclick: () => paintUnits(it) }, kt('Cancelar'))
            : el('button', { type: 'button', class: 'iconbtn small', 'aria-label': kt('Quitar {unit}', { unit: u.unit }), ...mark('unitRemove'), onclick: async () => {
              if (await confirmDialog({ title: kt('¿Quitar «{unit}»?', { unit: u.unit }), text: kt('Lo ya registrado no cambia: los movimientos están en la unidad base.'), confirmLabel: kt('Quitar') })) await options.source.removeUnit?.(u.id);
            } }, icon('trash', 16))),
        error);
    };
    const adding = el('div', { class: 'stk-unit-new' });
    replace(panels.units,
      el('p', { class: 'hint' }, kt('El stock se cuenta en {unit}. Aquí, cuántas {unit} hay en cada saco, caja o bolsa, y de qué proveedor.', { unit: it.baseUnit })),
      ...(own.length ? own.map((u) => unitRow(u, false)) : [el('p', { class: 'hint stk-empty' }, kt('Sin otras unidades.'))]),
      adding,
      ro ? null : el('button', { type: 'button', class: 'ghost small', ...mark('unitAdd'), onclick: () => {
        replace(adding, unitRow({ id: newItemId(), itemId: it.id, unit: '', factor: 0, supplierId: null }, true));
        adding.querySelector('input')?.focus();
      } }, icon('plus', 14), kt('Añadir unidad')));
  }

  // --- Movimientos -------------------------------------------------------------------------------------------
  function dayText(at: string): string {
    const d = at.slice(0, 10);
    if (d === today) return kt('hoy');
    return `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  }
  function movementTitle(m: MovementRow, all: readonly MovementRow[]): string {
    const label = kt(MOVEMENT_KIND_LABELS[m.kind] ?? m.kind);
    if (m.kind === 'salida_manual' && m.reason) return `${label} · ${kt(EXIT_REASON_LABELS[m.reason] ?? m.reason)}`;
    if (m.kind === 'traslado' && m.transferId) {
      const other = all.find((o) => o.transferId === m.transferId && o.id !== m.id);
      if (other) return m.quantity < 0 ? kt('Traslado a {space}', { space: spaceName(other.spaceId) }) : kt('Traslado desde {space}', { space: spaceName(other.spaceId) });
    }
    return label;
  }
  function paintMovements(it: ItemRow): void {
    const all = (snap.movements ?? []).filter((m) => m.itemId === it.id);
    const sorted = all.slice().sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    const shown = sorted.slice(0, shownMovements);
    replace(panels.movements,
      ...shown.map((m) => {
        const link = m.sourceApp && m.sourceRef ? options.sourceLink?.(m.sourceApp, m.sourceRef) ?? null : null;
        const who = m.createdBy ? options.personName?.(m.createdBy) ?? null : null;
        const origin = link
          ? (link.href ? el('a', { href: link.href, class: 'stk-origin' }, link.label) : el('button', { type: 'button', class: 'linkbtn stk-origin', onclick: () => link.onClick?.() }, link.label))
          : m.sourceApp ? el('span', null, m.sourceApp.charAt(0).toUpperCase() + m.sourceApp.slice(1)) : el('span', null, m.countId ? kt('Recuento') : kt('A mano'));
        return el('div', { class: `stk-mov${m.pending ? ' pending' : ''}`, dataset: { movementId: m.id } },
          el('span', { class: 'stk-mov-when' }, dayText(m.at)),
          el('span', { class: 'stk-mov-what' }, movementTitle(m, all)),
          el('span', { class: `stk-mov-n${m.quantity > 0 ? ' in' : ''}` }, `${m.quantity > 0 ? '+' : '−'}${qty(Math.abs(m.quantity), it.baseUnit)}`),
          el('small', { class: 'stk-mov-note' }, origin, ` · ${spaceName(m.spaceId)}`, m.note ? ` · «${m.note}»` : '', who ? ` · ${who}` : '', m.pending ? el('span', { class: 'chip pending' }, kt('sin subir')) : null));
      }),
      all.length ? null : el('p', { class: 'hint stk-empty' }, kt('Sin movimientos todavía.')),
      sorted.length > shownMovements ? el('button', { type: 'button', class: 'linkbtn', ...mark('more'), onclick: () => { shownMovements += 20; paintMovements(it); } }, kt('Ver más ({n})', { n: String(sorted.length - shownMovements) })) : null);
  }

  // --- Todo --------------------------------------------------------------------------------------------------
  function paint(): void {
    const it = item();
    if (!it) { title.textContent = kt('Artículo'); replace(meta, kt('No está en este dispositivo.')); return; }
    paintHead(it);
    paintStock(it);
    paintData(it);
    paintUnits(it);
    paintMovements(it);
    paintTabs();
  }

  const setSnapshot = (next: ItemSnapshot) => { snap = next; paint(); };
  const offSource = options.source.subscribe?.(setSnapshot);
  const offSpaces = options.spaces && !Array.isArray(options.spaces) ? options.spaces.subscribe((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); }) : null;
  if (options.spaces && !Array.isArray(options.spaces)) void Promise.resolve(options.spaces.list()).then((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); });
  void Promise.resolve(options.source.list()).then(setSnapshot);
  paintTabs();

  return {
    element,
    setTab,
    destroy() { offSource?.(); offSpaces?.(); element.remove(); },
  };
}
