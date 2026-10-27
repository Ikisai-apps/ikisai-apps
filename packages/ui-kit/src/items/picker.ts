/**
 * Elegir un artículo del inventario, o crearlo sin salir (`createItemPicker`, RECURSOS.md §7; aprobado el 18-10-2026).
 * Mismo buscador que `createSpacePicker`: quien sabe elegir un espacio sabe elegir un artículo.
 *
 * - **Buscar:** por nombre y alias (`attributes.aliases` y los que pase la app), sin mayúsculas ni tildes. Cada resultado
 *   lleva su tipo y su stock; bajo mínimo lo dice con texto, no solo con color. Flechas, Intro y Escape.
 * - **Crear al momento:** la última opción es «Crear «lo escrito»». Avisa de los parecidos antes de crear y no deja crear
 *   el mismo nombre (lo ofrece para usar). El alta pide lo mínimo: nombre, tipo, unidad base y, si hay sitios, dónde se
 *   guarda. Va dentro del campo, no en otra hoja, porque el selector suele vivir ya en una hoja.
 * - **Cantidad** (`quantity`): las unidades del artículo (base, métricas y conversiones; con `supplierId`, las de ese
 *   proveedor primero) y la equivalencia en la base en vivo: «2 saco = 50 kg».
 * - **Sitio** (`space`): `createSpacePicker` dentro; propone el habitual del artículo.
 * - **Sin red:** busca en el espejo y crea en el dispositivo; se sube al volver.
 * - **Nombre repetido entre dos dispositivos:** «Ya existe «X»: usar ese» (la fuente avisa con `onDuplicate`).
 *
 * No escribe movimientos: devuelve `{ itemId, quantity, unit, baseQuantity, spaceId }` y cada app hace su commit.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { createQuantityField, formatQuantity, type QuantityField } from '../fields/quantity.ts';
import { normalizeName } from '../fields/suggest.ts';
import { createSpacePicker, type SpacePicker } from '../spaces/picker.ts';
import { indexSpaces, spaceDescendants, type SpaceRow, type SpaceSource } from '../spaces/model.ts';
import {
  BASE_UNITS, DEFAULT_ITEM_KINDS, baseQuantity, kindLabelOf, newItemId, sameNameItem, searchItems, similarItems, stockSummary, unitsFor,
  type ItemRow, type ItemSnapshot, type ItemSource, type ItemUnitOption,
} from './model.ts';

export interface ItemPick {
  itemId: string | null;
  /** Con `allowText`: lo escrito, sin artículo. */
  text?: string;
  quantity?: number | null;
  /** Unidad visible («saco», «kg»). */
  unit?: string | null;
  /** `base`, `metric:g` o id de `item_units`. */
  unitId?: string | null;
  /** Cantidad en la unidad base del artículo; `null` si no convierte. */
  baseQuantity?: number | null;
  spaceId?: string | null;
}

export interface ItemPickerOptions {
  label: string;
  source: ItemSource;
  value?: string | null;
  /** Solo estos tipos (Food: `['ingrediente', 'bebida']`). También son los que se ofrecen al crear. */
  kinds?: string[];
  includeArchived?: boolean;
  /** Nombres extra por artículo que da la app (id → nombres), además de `attributes.aliases`. */
  aliases?: Record<string, string[]>;
  /** Stock solo de estos sitios (p. ej. la cocina y lo de dentro). Por defecto, todo. */
  stockIn?: string[] | null;
  /** Crear al momento (por defecto `true`). */
  create?: boolean;
  /** «Usar «texto» sin artículo» (gastos que no son inventario). */
  allowText?: boolean;
  /** Fijo en el artículo (`value`), sin «Cambiar»: «Gastar» de un suministro. */
  fixed?: boolean;
  quantity?: boolean | { label?: string; value?: number | null; unitId?: string | null };
  /** Ordena primero las conversiones de este proveedor. */
  supplierId?: string | null;
  /** Sitios: para nombrar dónde está el stock y para `space`. */
  spaces?: SpaceSource | SpaceRow[];
  space?: boolean | { label?: string; value?: string | null; quick?: string[] };
  placeholder?: string;
  disabled?: boolean;
  onChange?: (pick: ItemPick) => void;
  feedbackId?: string;
  /**
   * Sugeridos (K4 de Tasks: el kit de los oficios de la tarea). Al buscar, los que coinciden salen primero y marcados;
   * con el campo vacío, al entrar en él, se ofrecen ellos solos.
   */
  suggested?: string[];
  /** Marca de los sugeridos; por defecto «Sugerido» («Del kit del oficio» en Tasks). */
  suggestedLabel?: string;
}

export interface ItemPicker {
  element: HTMLElement;
  get(): ItemPick;
  /** Cambia la elección sin llamar a `onChange`. */
  set(pick: Partial<ItemPick>): void;
  focus(): void;
  destroy(): void;
}

export const ITEM_PICKER_MARKS = {
  search: ['buscar', 'Buscar artículo'],
  option: ['opcion', 'Resultado de la búsqueda'],
  create: ['crear', 'Crear artículo'],
  save: ['crear-guardar', 'Crear y usar'],
  cancel: ['crear-cancelar', 'Cancelar el alta'],
  change: ['cambiar', 'Cambiar de artículo'],
  duplicate: ['usar-existente', 'Usar el que ya existe'],
  complete: ['completar', 'Completar el nombre'],
} as const;

let uid = 0;

type Option = { type: 'item'; item: ItemRow } | { type: 'create'; name: string } | { type: 'text'; text: string };

export function createItemPicker(options: ItemPickerOptions): ItemPicker {
  const id = `kit-item-picker-${++uid}`;
  const base = options.feedbackId;
  const mark = (key: keyof typeof ITEM_PICKER_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${ITEM_PICKER_MARKS[key][0]}`, 'data-feedback-label': ITEM_PICKER_MARKS[key][1] } : {});
  const canCreate = options.create !== false && !!options.source.create;
  const qOpt = typeof options.quantity === 'object' ? options.quantity : options.quantity ? {} : null;
  const sOpt = typeof options.space === 'object' ? options.space : options.space ? {} : null;

  let snap: ItemSnapshot = { items: [], units: [], kinds: DEFAULT_ITEM_KINDS, stock: [] };
  let spaceRows: SpaceRow[] = Array.isArray(options.spaces) ? options.spaces : [];
  let spaceIndex = indexSpaces(spaceRows);
  let itemId: string | null = options.value ?? null;
  let text: string | null = null;
  let results: Option[] = [];
  let active = -1;
  let creating: { name: string; kind: string; baseUnit: string; spaceId: string | null } | null = null;
  let duplicate: { name: string; existing: ItemRow | null } | null = null;
  let spaceTouched = sOpt?.value !== undefined && sOpt?.value !== null;
  let quantityField: QuantityField | null = null;
  let qty: { value: number | null; unitId: string | null } = { value: qOpt?.value ?? null, unitId: qOpt?.unitId ?? null };
  let unitOptions: ItemUnitOption[] = [];

  const item = () => (itemId ? snap.items.find((i) => i.id === itemId) ?? null : null);
  const spaceName = (sid: string) => spaceIndex.get(sid)?.name ?? null;
  // Con sitios conocidos, lo de dentro también cuenta (la cocina y su despensa).
  const stockIds = (): string[] | null => (options.stockIn ? [...new Set(options.stockIn.flatMap((sid) => [sid, ...spaceDescendants(spaceRows, sid, true)]))] : null);
  const allowedKinds = () => (options.kinds?.length ? snap.kinds.filter((k) => options.kinds!.includes(k.kind)) : snap.kinds.filter((k) => k.kind !== 'otro').concat(snap.kinds.filter((k) => k.kind === 'otro')));

  // --- Estructura ------------------------------------------------------------------------------------------
  const chosenHost = el('div', { class: 'item-chosen-host' });
  const notice = el('div', { class: 'item-notice', role: 'status', 'aria-live': 'polite' });
  const input = el('input', {
    type: 'text', id, class: 'space-search item-search', role: 'combobox', 'aria-expanded': 'false', 'aria-autocomplete': 'list', 'aria-controls': `${id}-list`,
    autocomplete: 'off', placeholder: options.placeholder ?? (canCreate ? kt('Busca o escribe uno nuevo') : kt('Buscar artículo…')), disabled: !!options.disabled, ...mark('search'),
    'aria-describedby': `${id}-complete`,
    oninput: () => search(), onfocus: () => search(),
    onkeydown: (e: Event) => onKey(e as KeyboardEvent),
    onblur: () => setTimeout(() => { if (document.activeElement !== input) close(); }, 150),
  }) as HTMLInputElement;
  const searchWrap = el('div', { class: 'space-search-wrap item-search-wrap' }, icon('search', 16), input);
  // Completar con un nombre que ya existe: → al final del texto, o tocando la línea.
  const completeHost = el('div', { class: 'item-complete-host', id: `${id}-complete` });
  let completion: string | null = null;
  const suggested = new Set(options.suggested ?? []);
  const listbox = el('ul', { class: 'space-results item-results', id: `${id}-list`, role: 'listbox', 'aria-label': options.label, hidden: true });
  const createHost = el('div', { class: 'item-create-host' });
  const qtyHost = el('div', { class: 'item-qty-host' });
  const spaceHost = el('div', { class: 'item-space-host' });
  const element = el('div', { class: 'item-picker', ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) },
    el('label', { class: 'space-picker-label', for: id }, options.label),
    chosenHost, notice, searchWrap, completeHost, listbox, createHost, qtyHost, spaceHost);

  // --- Sitio ------------------------------------------------------------------------------------------------
  let spacePicker: SpacePicker | null = null;
  if (sOpt) {
    spacePicker = createSpacePicker({
      label: sOpt.label ?? kt('Dónde'), ...(Array.isArray(options.spaces) ? { rows: options.spaces } : options.spaces ? { source: options.spaces } : {}),
      value: sOpt.value ?? null, ...(sOpt.quick ? { quick: sOpt.quick } : {}), ...(base ? { feedbackId: `${base}.sitio` } : {}),
      onChange: () => { spaceTouched = true; paintQuantityNote(); emit(); },
    });
    spaceHost.append(spacePicker.element);
  }
  const offSpaces = options.spaces && !Array.isArray(options.spaces) ? options.spaces.subscribe((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); }) : null;
  if (options.spaces && !Array.isArray(options.spaces)) void Promise.resolve(options.spaces.list()).then((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paint(); });

  // --- Valor ------------------------------------------------------------------------------------------------
  function current(): ItemPick {
    const unit = unitOptions.find((u) => u.value === qty.unitId) ?? unitOptions[0] ?? null;
    return {
      itemId,
      ...(text !== null ? { text } : {}),
      ...(qOpt ? { quantity: qty.value, unit: unit?.unit ?? null, unitId: unit?.value ?? null, baseQuantity: itemId ? baseQuantity(qty.value, unit?.value ?? null, unitOptions) : null } : {}),
      ...(spacePicker ? { spaceId: spacePicker.get()[0] ?? null } : {}),
    };
  }
  const emit = () => options.onChange?.(current());

  function choose(next: ItemRow | null, opts: { text?: string; silent?: boolean } = {}): void {
    const changed = next?.id !== itemId;
    itemId = next?.id ?? null;
    text = next ? null : opts.text ?? null;
    duplicate = null;
    if (changed) qty.unitId = null;
    // El sitio habitual del artículo, si la persona no ha elegido otro.
    if (next?.defaultSpaceId && spacePicker && !spaceTouched) spacePicker.set(next.defaultSpaceId);
    input.value = '';
    close();
    creating = null;
    paint();
    if (!opts.silent) emit();
  }

  // --- Pintar -----------------------------------------------------------------------------------------------
  function stockLine(i: ItemRow): { text: string; low: boolean } {
    return stockSummary(i, snap.stock, { spaceIds: stockIds(), spaceName });
  }

  function paint(): void {
    const it = item();
    const showChosen = !!it || text !== null;
    searchWrap.hidden = showChosen || !!creating;
    if (it) {
      const s = stockLine(it);
      replace(chosenHost, el('div', { class: `item-chosen${it.pending ? ' pending' : ''}`, dataset: { itemId: it.id } },
        el('span', { class: 'item-chosen-text' },
          el('strong', null, it.name),
          el('span', { class: `item-stock${s.low ? ' low' : ''}` }, `${kindLabelOf(snap.kinds, it.kind)} · ${s.text}`),
          it.pending ? el('span', { class: 'item-pending' }, kt('Sin subir todavía')) : null),
        options.fixed ? null : el('button', { type: 'button', class: 'linkbtn item-change', disabled: !!options.disabled, ...mark('change'), 'aria-label': kt('Cambiar {name}', { name: it.name }), onclick: () => reopen() }, kt('Cambiar'))));
    } else if (text !== null) {
      replace(chosenHost, el('div', { class: 'item-chosen text' },
        el('span', { class: 'item-chosen-text' }, el('strong', null, text), el('span', { class: 'item-stock' }, kt('Sin artículo: solo texto'))),
        options.fixed ? null : el('button', { type: 'button', class: 'linkbtn item-change', ...mark('change'), onclick: () => reopen() }, kt('Cambiar'))));
    } else replace(chosenHost);
    paintNotice();
    paintCreate();
    paintQuantity();
  }

  function paintNotice(): void {
    if (!duplicate) { replace(notice); notice.hidden = true; return; }
    notice.hidden = false;
    replace(notice, el('p', { class: 'item-dup' }, icon('warn', 16),
      el('span', null, duplicate.existing
        ? kt('Ya existe «{name}» (lo dio de alta otro dispositivo).', { name: duplicate.existing.name })
        : kt('Ya existe un artículo llamado «{name}». Cuando llegue a este dispositivo, elígelo.', { name: duplicate.name }))),
    duplicate.existing ? el('button', { type: 'button', class: 'primary small item-use', ...mark('duplicate'), onclick: () => choose(duplicate!.existing) }, kt('Usar ese')) : null);
  }

  function reopen(): void {
    itemId = null; text = null; qty.unitId = null;
    paint();
    emit();
    input.focus();
  }

  // --- Buscar -----------------------------------------------------------------------------------------------
  function search(): void {
    const q = input.value.trim();
    if (!q && document.activeElement !== input) { close(); return; }
    const found = q
      ? searchItems(snap.items, q, { ...(options.kinds ? { kinds: options.kinds } : {}), ...(options.includeArchived ? { includeArchived: true } : {}), ...(options.aliases ? { aliases: options.aliases } : {}), ...(suggested.size ? { boost: [...suggested] } : {}) })
      : snap.items.filter((i) => suggested.has(i.id) && i.active && (!options.kinds || options.kinds.includes(i.kind))).sort((a, b) => a.name.localeCompare(b.name));
    results = found.map((i) => ({ type: 'item' as const, item: i }));
    if (q && canCreate && !sameNameItem(snap.items, q)) results.push({ type: 'create', name: q });
    if (q && options.allowText) results.push({ type: 'text', text: q });
    active = results.length ? 0 : -1;
    // El primer nombre que empieza por lo escrito (y es más largo) se puede completar.
    const nq = normalizeName(q);
    const first = q ? found.find((i) => normalizeName(i.name).startsWith(nq) && normalizeName(i.name) !== nq) : undefined;
    completion = first ? first.name : null;
    replace(completeHost, completion
      ? el('button', { type: 'button', class: 'linkbtn item-complete', tabindex: '-1', ...mark('complete'), onmousedown: (e: Event) => e.preventDefault(), onclick: () => complete() },
        kt('→ completa «{name}»', { name: completion }))
      : null);
    paintResults(q, !q && results.length > 0);
  }

  function complete(): void {
    if (!completion) return;
    input.value = completion;
    input.setSelectionRange(completion.length, completion.length);
    search();
  }

  function paintResults(q: string, suggestions = false): void {
    const open = q !== '' || suggestions;
    listbox.hidden = !open;
    input.setAttribute('aria-expanded', String(open));
    replace(listbox, ...(results.length ? results.map((r, i) => {
      const attrs = { role: 'option', id: `${id}-opt-${i}`, 'aria-selected': String(i === active), onmousedown: (e: Event) => e.preventDefault(), onclick: () => take(r) };
      if (r.type === 'item') {
        const s = stockLine(r.item);
        return el('li', { ...attrs, class: `space-result item-result${i === active ? ' active' : ''}${r.item.active ? '' : ' archived'}`, dataset: { itemId: r.item.id }, ...mark('option') },
          el('span', { class: 'space-result-name' }, r.item.name, el('span', { class: 'item-kind' }, kindLabelOf(snap.kinds, r.item.kind)), suggested.has(r.item.id) ? el('span', { class: 'item-suggested' }, options.suggestedLabel ?? kt('Sugerido')) : null, r.item.pending ? el('span', { class: 'item-pending' }, kt('sin subir')) : null),
          el('span', { class: `item-stock${s.low ? ' low' : ''}` }, s.text));
      }
      if (r.type === 'create') {
        const like = similarItems(snap.items, r.name);
        return el('li', { ...attrs, class: `space-result item-result item-new${i === active ? ' active' : ''}`, ...mark('create') },
          el('span', { class: 'space-result-name' }, icon('plus', 14), kt('Crear «{name}»', { name: r.name })),
          like.length ? el('span', { class: 'item-similar' }, like.length === 1 ? kt('Se parece a «{name}»: mira arriba antes de crear', { name: like[0]!.name }) : kt('Se parece a «{name}» y {n} más: mira arriba antes de crear', { name: like[0]!.name, n: String(like.length - 1) })) : null);
      }
      return el('li', { ...attrs, class: `space-result item-result item-text${i === active ? ' active' : ''}` },
        el('span', { class: 'space-result-name' }, kt('Usar «{text}» sin artículo', { text: r.text })),
        el('span', { class: 'item-stock' }, kt('Solo texto: no cuenta en el inventario')));
    }) : open ? [el('li', { class: 'space-result empty', role: 'option', 'aria-disabled': 'true' }, kt('Ningún artículo coincide con «{q}».', { q }))] : []));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-opt-${active}`); else input.removeAttribute('aria-activedescendant');
  }

  function take(r: Option): void {
    if (r.type === 'item') choose(r.item);
    else if (r.type === 'text') choose(null, { text: r.text });
    else startCreate(r.name);
  }

  function close(): void { results = []; active = -1; completion = null; replace(completeHost); paintResults(''); }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      paintResults(input.value.trim());
      document.getElementById(`${id}-opt-${active}`)?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowRight' && completion && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
      e.preventDefault();
      complete();
    } else if (e.key === 'Enter') {
      if (active >= 0 && results[active]) { e.preventDefault(); take(results[active]!); }
    } else if (e.key === 'Escape' && !listbox.hidden) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      close();
    }
  }

  // --- Crear ------------------------------------------------------------------------------------------------
  function startCreate(name: string): void {
    const kinds = allowedKinds();
    creating = { name, kind: kinds[0]?.kind ?? 'otro', baseUnit: kinds[0]?.consumable === false ? 'ud' : 'kg', spaceId: spacePicker?.get()[0] ?? null };
    close();
    paint();
    createHost.querySelector<HTMLInputElement>('.item-create-name')?.focus();
  }

  function paintCreate(): void {
    if (!creating) { replace(createHost); return; }
    const c = creating;
    const nameInput = el('input', { type: 'text', class: 'item-create-name', id: `${id}-new`, value: c.name, maxlength: '120', autocomplete: 'off',
      oninput: () => { c.name = nameInput.value; paintHint(); } }) as HTMLInputElement;
    const hint = el('span', { class: 'hint suggest', id: `${id}-new-hint`, 'aria-live': 'polite' });
    const save = el('button', { type: 'button', class: 'primary', ...mark('save'), onclick: () => void finishCreate() }, kt('Crear y usar')) as HTMLButtonElement;
    function paintHint(): void {
      const same = sameNameItem(snap.items, c.name);
      const like = same ? [] : similarItems(snap.items, c.name);
      save.disabled = !c.name.trim() || !!same;
      if (same) {
        replace(hint, kt('Ya existe «{name}».', { name: same.name }), ' ', el('button', { type: 'button', class: 'linkbtn suggest-use', ...mark('duplicate'), onclick: () => choose(same) }, kt('Usar «{name}»', { name: same.name })));
        hint.classList.add('warn');
      } else {
        hint.textContent = !c.name.trim() ? kt('Escribe el nombre.') : like.length ? kt('Nuevo. Se parece a {names}.', { names: like.map((l) => `«${l.name}»`).join(', ') }) : kt('Nuevo: no existe todavía.');
        hint.classList.toggle('warn', like.length > 0);
      }
    }
    const kinds = allowedKinds();
    const kindRow = el('div', { class: 'item-kinds', role: 'radiogroup', 'aria-label': kt('Tipo') },
      ...kinds.map((k) => el('button', { type: 'button', class: 'filterchip', role: 'radio', 'aria-checked': String(k.kind === c.kind), 'aria-pressed': String(k.kind === c.kind),
        onclick: () => { c.kind = k.kind; if (!k.consumable && c.baseUnit !== 'ud') c.baseUnit = 'ud'; paintCreate(); createHost.querySelector<HTMLElement>(`[aria-checked="true"]`)?.focus(); } }, k.label)));
    const unitSelect = el('select', { id: `${id}-new-unit`, onchange: () => { c.baseUnit = unitSelect.value; } },
      ...BASE_UNITS.map((u) => el('option', { value: u, selected: u === c.baseUnit }, u))) as HTMLSelectElement;
    let createSpace: SpacePicker | null = null;
    if (spaceRows.length) {
      createSpace = createSpacePicker({ label: kt('Dónde se guarda (opcional)'), rows: spaceRows, value: c.spaceId, ...(sOpt?.quick ? { quick: sOpt.quick } : {}), onChange: (ids) => { c.spaceId = ids[0] ?? null; } });
    }
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    replace(createHost, el('div', { class: 'item-create', role: 'group', 'aria-label': kt('Crear artículo') },
      el('p', { class: 'item-create-title' }, kt('Crear artículo')),
      el('label', { class: 'field suggest-field' }, el('span', null, kt('Nombre')), nameInput, hint),
      el('div', { class: 'item-create-kind' }, el('span', { class: 'space-picker-label' }, kt('Tipo')), kindRow),
      el('label', { class: 'field' }, el('span', null, kt('Unidad base')), unitSelect, el('span', { class: 'hint' }, kt('En la que se cuenta el stock. Sacos, cajas y demás se añaden en la ficha.'))),
      createSpace?.element ?? null,
      offline ? el('p', { class: 'item-offline' }, icon('offline', 16), kt('Sin conexión: se crea en este dispositivo y se sube al volver la red.')) : null,
      el('div', { class: 'item-create-actions' },
        el('button', { type: 'button', class: 'ghost', ...mark('cancel'), onclick: () => { creating = null; paint(); input.focus(); } }, kt('Cancelar')),
        save)));
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !save.disabled) { e.preventDefault(); void finishCreate(); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); creating = null; paint(); input.focus(); } });
    paintHint();
  }

  async function finishCreate(): Promise<void> {
    if (!creating || !options.source.create) return;
    const c = creating;
    const name = c.name.trim();
    if (!name || sameNameItem(snap.items, name)) return;
    const draft = { id: newItemId(), name, kind: c.kind, baseUnit: c.baseUnit, defaultSpaceId: c.spaceId };
    try {
      await options.source.create(draft);
    } catch (error) {
      const msg = createHost.querySelector<HTMLElement>('.hint.suggest');
      if (msg) { msg.textContent = kt('No se ha podido crear: {message}', { message: (error as Error)?.message ?? '' }); msg.classList.add('warn'); }
      return;
    }
    // El espejo ya tiene la fila pendiente; si aún no ha llegado al snapshot, se pone a mano.
    if (!snap.items.some((i) => i.id === draft.id)) {
      snap = { ...snap, items: [...snap.items, { id: draft.id, name, kind: c.kind, category: null, baseUnit: c.baseUnit, minQuantity: null, reorderQuantity: null, defaultSpaceId: c.spaceId, defaultSupplierId: null, tracksLots: false, tracksExpiry: false, aliases: [], attributes: {}, active: true, notes: null, pending: true }] };
    }
    choose(snap.items.find((i) => i.id === draft.id)!);
  }

  // --- Cantidad ---------------------------------------------------------------------------------------------
  const conversion = el('p', { class: 'item-conv', 'aria-live': 'polite' });
  let qtyFor: string | null = null;
  function paintQuantity(): void {
    if (!qOpt) return;
    const it = item();
    if (!it) { replace(qtyHost); quantityField = null; qtyFor = null; unitOptions = []; return; }
    unitOptions = unitsFor(it, snap.units, { supplierId: options.supplierId ?? null, supplierName: (sid) => options.source.supplierName?.(sid) ?? null });
    const key = `${it.id}|${unitOptions.map((u) => u.value).join(',')}`;
    if (key !== qtyFor) {
      qtyFor = key;
      if (!unitOptions.some((u) => u.value === qty.unitId)) qty.unitId = unitOptions[0]!.value;
      quantityField = createQuantityField({
        label: qOpt.label ?? kt('Cantidad'), name: `${id}-qty`, id: `${id}-qty`, value: qty.value, unit: qty.unitId!, decimals: 3, min: 0, disabled: !!options.disabled,
        units: unitOptions.map((u) => ({ value: u.value, label: u.label })),
        onChange: (v) => { qty = { value: v.value, unitId: v.unit }; paintQuantityNote(); emit(); },
      });
      replace(qtyHost, el('div', { class: 'item-qty' }, quantityField.element, conversion));
    }
    paintQuantityNote();
  }

  function paintQuantityNote(): void {
    const it = item();
    if (!qOpt || !it) return;
    const unit = unitOptions.find((u) => u.value === qty.unitId) ?? unitOptions[0]!;
    const total = baseQuantity(qty.value, unit.value, unitOptions);
    const parts: (string | HTMLElement)[] = [];
    if (unit.value !== 'base' && total !== null) parts.push(`= `, el('strong', null, `${formatQuantity(total, 3)} ${it.baseUnit}`), ` · ${kt('1 {unit} = {n} {base}', { unit: unit.unit, n: formatQuantity(unit.factor, 4), base: it.baseUnit })}`);
    else if (unit.value !== 'base') parts.push(kt('1 {unit} = {n} {base}', { unit: unit.unit, n: formatQuantity(unit.factor, 4), base: it.baseUnit }));
    replace(conversion, ...parts);
    conversion.hidden = !parts.length;
  }

  // --- Datos ------------------------------------------------------------------------------------------------
  function setSnapshot(next: ItemSnapshot): void {
    snap = next;
    // Con el artículo de entrada (`value`), su sitio habitual en cuanto se conoce, si nadie eligió otro.
    const it = item();
    if (it?.defaultSpaceId && spacePicker && !spaceTouched && !spacePicker.get().length) spacePicker.set(it.defaultSpaceId);
    paint();
    if (input.value && !listbox.hidden) search();
  }
  const offSource = options.source.subscribe?.(setSnapshot);
  const offDup = options.source.onDuplicate?.((dup) => {
    if (dup.draftId !== itemId) return;
    itemId = null;
    duplicate = { name: dup.name, existing: dup.existing };
    paint();
    emit();
  });
  void Promise.resolve(options.source.list()).then(setSnapshot);
  paint();

  return {
    element,
    get: current,
    set(pick) {
      if ('itemId' in pick) { itemId = pick.itemId ?? null; text = pick.text ?? null; }
      // `quantity: null` vacía la cantidad (sin `??`, que la conservaría).
      if ('quantity' in pick || 'unitId' in pick) { qty = { value: 'quantity' in pick ? pick.quantity ?? null : qty.value, unitId: pick.unitId ?? qty.unitId }; qtyFor = null; }
      if ('spaceId' in pick && spacePicker) { spacePicker.set(pick.spaceId ?? null); spaceTouched = true; }
      paint();
    },
    focus() { (searchWrap.hidden ? chosenHost.querySelector<HTMLElement>('.item-change') ?? quantityField?.input : input)?.focus(); },
    destroy() { offSource?.(); offDup?.(); offSpaces?.(); spacePicker?.destroy(); element.remove(); },
  };
}
