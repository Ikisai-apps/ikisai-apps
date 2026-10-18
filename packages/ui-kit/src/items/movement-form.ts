/**
 * Entrada, salida o traslado a mano (`createMovementForm`, R3; aprobado el 18-10-2026).
 *
 * - **Siempre:** artículo (`createItemPicker`; fijo si se abre desde una fila), cantidad en sus unidades, sitio y nota.
 * - **Entrada** (`entrada_manual`): coste por unidad base opcional (cuenta en el coste medio); si el artículo lleva lotes o
 *   caducidad, un lote que ya existe o uno nuevo con su código y fecha.
 * - **Salida** (`salida_manual`): motivo obligatorio; sale primero lo que caduca antes y lo dice, o de un lote elegido.
 * - **Traslado:** de un sitio a otro con el mismo lote: dos filas con el mismo `transfer_id`, en **un solo lote** de commit
 *   (el servidor lo exige); si hay que tirar de varios lotes, un par por lote.
 * - Enseña lo que quedará y avisa (sin bloquear) si se saca más de lo que consta en el dispositivo.
 * - Sin red: se guarda en el dispositivo y se sube al volver. El consumo de servicios y tareas no va aquí (`resources.consume`).
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { kt } from '../i18n/i18n.ts';
import { formatQuantity, parseQuantity } from '../fields/quantity.ts';
import { createSpacePicker, type SpacePicker } from '../spaces/picker.ts';
import { indexSpaces, type SpaceRow, type SpaceSource } from '../spaces/model.ts';
import { createItemPicker, type ItemPick, type ItemPicker } from './picker.ts';
import { expiryText } from './catalog.ts';
import {
  DEFAULT_ITEM_KINDS, EXIT_REASON_LABELS, fefoPlan, lotsWithStock, newItemId, stockAt, stockBySpace,
  type ItemRow, type ItemSnapshot, type ItemSource, type LotRow, type MovementDraft,
} from './model.ts';

export type MovementMode = 'entry' | 'exit' | 'transfer';

export interface MovementFormOptions {
  source: ItemSource;
  spaces?: SpaceSource | SpaceRow[];
  mode?: MovementMode;
  /** Modos que se ofrecen (por defecto los tres). Con uno solo no hay selector: «Gastar» de Tasks = `['exit']`. */
  modes?: MovementMode[];
  itemId?: string | null;
  /** Fijo en `itemId`, sin «Cambiar». Por defecto, fijo si viene `itemId`. */
  fixedItem?: boolean;
  spaceId?: string | null;
  /** Motivo de salida preelegido (`uso` en «Gastar»). */
  reason?: string;
  kinds?: string[];
  /** De dónde viene (tarea, servicio…), para `source_app`/`source_ref`. */
  sourceApp?: string;
  sourceRef?: string;
  quickSpaces?: string[];
  onDone?: (movements: MovementDraft[]) => void;
  onCancel?: () => void;
  today?: string;
  feedbackId?: string;
}

export interface MovementForm {
  element: HTMLElement;
  setMode(mode: MovementMode): void;
  focus(): void;
  destroy(): void;
}

export const MOVEMENT_FORM_MARKS = {
  mode: ['modo', 'Entrada, salida o traslado'],
  reason: ['motivo', 'Motivo de la salida'],
  lot: ['lote', 'Lote'],
  save: ['guardar', 'Registrar el movimiento'],
  cancel: ['cancelar', 'Cancelar'],
} as const;

const MODE_LABELS: Record<MovementMode, string> = { entry: 'Entrada', exit: 'Salida', transfer: 'Traslado' };
const SAVE_LABELS: Record<MovementMode, string> = { entry: 'Registrar entrada', exit: 'Registrar salida', transfer: 'Trasladar' };
let uid = 0;

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function createMovementForm(options: MovementFormOptions): MovementForm {
  const id = `kit-movement-${++uid}`;
  const base = options.feedbackId;
  const mark = (key: keyof typeof MOVEMENT_FORM_MARKS): Record<string, string> => (base ? { 'data-feedback-id': `${base}.${MOVEMENT_FORM_MARKS[key][0]}`, 'data-feedback-label': MOVEMENT_FORM_MARKS[key][1] } : {});
  const modes = options.modes?.length ? options.modes : (['entry', 'exit', 'transfer'] as MovementMode[]);
  const today = options.today ?? localToday();
  let mode: MovementMode = options.mode && modes.includes(options.mode) ? options.mode : modes[0]!;
  let snap: ItemSnapshot = { items: [], units: [], kinds: DEFAULT_ITEM_KINDS, stock: [] };
  let spaceRows: SpaceRow[] = Array.isArray(options.spaces) ? options.spaces : [];
  let spaceIndex = indexSpaces(spaceRows);
  // Lo que se conserva al cambiar de modo.
  let pick: ItemPick = { itemId: options.itemId ?? null, spaceId: options.spaceId ?? null };
  let toSpace: string | null = null;
  let reason: string | null = options.reason ?? null;
  let lotChoice = 'auto';
  let newLotCode = '';
  let newLotExpiry = '';
  let cost = '';
  let note = '';
  let saving = false;

  const item = (): ItemRow | null => (pick.itemId ? snap.items.find((i) => i.id === pick.itemId) ?? null : null);
  const spaceName = (sid: string | null | undefined) => (sid ? spaceIndex.get(sid)?.name ?? kt('Sin sitio') : '—');
  const qty = (n: number, unit: string) => `${formatQuantity(n, 3)} ${unit}`;

  const modeBar = el('div', { class: 'stk-modes', role: 'radiogroup', 'aria-label': kt('Tipo de movimiento') });
  const pickerHost = el('div', { class: 'stk-mov-picker' });
  const extra = el('div', { class: 'stk-mov-extra' });
  const summary = el('p', { class: 'stk-mov-summary', 'aria-live': 'polite' });
  const error = el('p', { class: 'fielderror stk-mov-error', role: 'alert' });
  const status = el('p', { class: 'stk-save-status', role: 'status', 'aria-live': 'polite' });
  const saveBtn = el('button', { type: 'button', class: 'primary', ...mark('save'), onclick: () => void submit() }) as HTMLButtonElement;
  const element = el('section', { class: 'stk-movement', 'aria-label': kt('Movimiento'), ...(base ? { 'data-feedback-id': base, 'data-feedback-label': kt('Movimiento a mano') } : {}) },
    modes.length > 1 ? modeBar : null, pickerHost, extra, summary, error,
    el('div', { class: 'stk-sheet-actions' },
      options.onCancel ? el('button', { type: 'button', class: 'ghost', ...mark('cancel'), onclick: () => options.onCancel!() }, kt('Cancelar')) : null,
      saveBtn),
    status);

  // --- Artículo, cantidad y sitio de origen -------------------------------------------------------------------
  let picker: ItemPicker | null = null;
  let toPicker: SpacePicker | null = null;
  function buildPicker(): void {
    picker?.destroy();
    const fixed = options.fixedItem ?? !!options.itemId;
    const spaceLabel = mode === 'entry' ? kt('Dónde entra') : mode === 'exit' ? kt('De dónde') : kt('De');
    picker = createItemPicker({
      label: kt('Artículo'), source: options.source, ...(options.kinds ? { kinds: options.kinds } : {}), ...(options.spaces ? { spaces: options.spaces } : {}),
      value: pick.itemId, fixed: fixed && !!pick.itemId, create: mode === 'entry',
      quantity: { label: mode === 'entry' ? kt('Cuánto entra') : mode === 'exit' ? kt('Cuánto sale') : kt('Cuánto'), value: pick.quantity ?? null, unitId: pick.unitId ?? null },
      space: { label: spaceLabel, value: pick.spaceId ?? null, ...(options.quickSpaces ? { quick: options.quickSpaces } : {}) },
      ...(base ? { feedbackId: `${base}.articulo` } : {}),
      onChange: (next) => {
        // Lote, motivo, nota y destino solo se rehacen si cambia el artículo o el sitio: con cada tecla de la
        // cantidad basta el resumen (y así no se pierde el foco de la nota).
        const structural = next.itemId !== pick.itemId || next.spaceId !== pick.spaceId;
        if (next.itemId !== pick.itemId) { lotChoice = 'auto'; newLotCode = ''; newLotExpiry = ''; }
        pick = next;
        error.textContent = '';
        if (structural) paintExtra(); else paintSummary();
      },
    });
    replace(pickerHost, picker.element);
    pick = { ...pick, ...picker.get() };
  }

  // --- Modo --------------------------------------------------------------------------------------------------
  function paintModes(): void {
    replace(modeBar, ...modes.map((m) => el('button', {
      type: 'button', role: 'radio', class: 'stk-mode', 'aria-checked': String(m === mode), ...mark('mode'),
      onclick: () => setMode(m),
    }, kt(MODE_LABELS[m]))));
    saveBtn.textContent = kt(SAVE_LABELS[mode]);
  }
  function setMode(next: MovementMode): void {
    if (!modes.includes(next) || next === mode) return;
    if (picker) pick = { ...pick, ...picker.get() };
    mode = next;
    lotChoice = 'auto';
    error.textContent = '';
    status.textContent = '';
    paintModes();
    buildPicker();
    paintExtra();
  }

  // --- Lote, motivo, coste, destino y nota ---------------------------------------------------------------------
  function lotLabel(l: LotRow | null): string {
    if (!l) return kt('sin lote');
    const code = l.code ? kt('lote {code}', { code: l.code }) : kt('lote sin código');
    return l.expiresOn ? `${code} · ${expiryText(l.expiresOn, today)}` : code;
  }

  function paintExtra(): void {
    const it = item();
    const from = pick.spaceId ?? null;
    const parts: (HTMLElement | null)[] = [];
    if (it && mode === 'entry' && (it.tracksLots || it.tracksExpiry)) {
      const existing = (snap.lots ?? []).filter((l) => l.itemId === it.id);
      const select = el('select', { id: `${id}-lot`, ...mark('lot'), onchange: () => { lotChoice = select.value; paintExtra(); } },
        el('option', { value: 'new', selected: lotChoice === 'new' || lotChoice === 'auto' }, kt('Lote nuevo')),
        ...existing.map((l) => el('option', { value: l.id, selected: lotChoice === l.id }, lotLabel(l)))) as HTMLSelectElement;
      if (lotChoice === 'auto') lotChoice = 'new';
      parts.push(el('label', { class: 'field' }, el('span', null, kt('Lote')), select));
      if (lotChoice === 'new') {
        parts.push(el('div', { class: 'stk-grid2' },
          it.tracksLots ? el('label', { class: 'field' }, el('span', null, kt('Código del lote')), el('input', { type: 'text', value: newLotCode, maxlength: '60', oninput: (e: Event) => { newLotCode = (e.target as HTMLInputElement).value; } })) : null,
          it.tracksExpiry ? el('label', { class: 'field' }, el('span', null, kt('Caduca el')), el('input', { type: 'date', value: newLotExpiry, oninput: (e: Event) => { newLotExpiry = (e.target as HTMLInputElement).value; paintSummary(); } })) : null));
      }
    }
    if (it && mode !== 'entry' && from) {
      const lots = lotsWithStock(it.id, snap.stock, snap.lots ?? [], [from]).filter((l) => l.lot);
      if (lots.length) {
        const select = el('select', { id: `${id}-lot`, ...mark('lot'), onchange: () => { lotChoice = select.value; paintSummary(); } },
          el('option', { value: 'auto', selected: lotChoice === 'auto' }, kt('Primero lo que caduca antes')),
          ...lots.map((l) => el('option', { value: l.lot!.id, selected: lotChoice === l.lot!.id }, `${lotLabel(l.lot)} (${qty(l.quantity, it.baseUnit)})`))) as HTMLSelectElement;
        parts.push(el('label', { class: 'field' }, el('span', null, kt('Lote')), select));
      }
    }
    if (mode === 'exit') {
      parts.push(el('div', { class: 'stk-reasons-field' }, el('span', { class: 'space-picker-label', id: `${id}-reason` }, kt('Motivo')),
        el('div', { class: 'stk-reasons', role: 'radiogroup', 'aria-labelledby': `${id}-reason` },
          ...Object.entries(EXIT_REASON_LABELS).map(([value, label]) => el('button', {
            type: 'button', role: 'radio', class: 'filterchip', 'aria-checked': String(reason === value), ...mark('reason'),
            onclick: () => { reason = value; error.textContent = ''; paintExtra(); },
          }, kt(label))))));
    }
    if (mode === 'entry' && it) {
      parts.push(el('label', { class: 'field' }, el('span', null, kt('Coste por {unit} (opcional)', { unit: it.baseUnit })),
        el('input', { type: 'text', inputmode: 'decimal', value: cost, placeholder: '0,00', oninput: (e: Event) => { cost = (e.target as HTMLInputElement).value; } }),
        el('span', { class: 'hint' }, kt('Con coste, cuenta en el coste medio.'))));
    }
    if (mode === 'transfer') {
      toPicker?.destroy();
      toPicker = createSpacePicker({
        label: kt('A'), ...(Array.isArray(options.spaces) ? { rows: options.spaces } : options.spaces ? { source: options.spaces } : {}), value: toSpace,
        ...(options.quickSpaces ? { quick: options.quickSpaces } : {}), ...(base ? { feedbackId: `${base}.destino` } : {}),
        onChange: (ids) => { toSpace = ids[0] ?? null; error.textContent = ''; paintSummary(); },
      });
      parts.push(toPicker.element);
    }
    parts.push(el('label', { class: 'field' }, el('span', null, kt('Nota (opcional)')),
      el('input', { type: 'text', value: note, maxlength: '500', placeholder: mode === 'exit' ? kt('p. ej. abiertos sin tapa') : '', oninput: (e: Event) => { note = (e.target as HTMLInputElement).value; } })));
    replace(extra, ...parts);
    paintSummary();
  }

  // --- Plan y resumen ----------------------------------------------------------------------------------------
  type Plan = { movements: MovementDraft[]; lots: LotRow[]; text: (string | HTMLElement)[]; warn: string | null };
  function plan(): Plan | { problem: string } {
    const it = item();
    if (!it) return { problem: kt('Elige el artículo.') };
    const amount = pick.baseQuantity ?? null;
    if (pick.quantity === null || pick.quantity === undefined) return { problem: kt('Indica cuánto.') };
    if (amount === null) return { problem: kt('Esa unidad no se pasa a {unit}: añade la conversión en la ficha.', { unit: it.baseUnit }) };
    if (amount <= 0) return { problem: kt('La cantidad tiene que ser mayor que 0.') };
    const from = pick.spaceId ?? null;
    if (!from) return { problem: mode === 'entry' ? kt('Elige dónde entra.') : kt('Elige de dónde sale.') };
    const common = { reason: null, unitCost: null, transferId: null, sourceApp: options.sourceApp ?? null, sourceRef: options.sourceRef ?? null, note: note.trim() || null };
    if (mode === 'entry') {
      const c = cost.trim() ? parseQuantity(cost) : null;
      if (c !== null && (Number.isNaN(c) || c < 0)) return { problem: kt('El coste tiene que ser un número.') };
      let lotId: string | null = null;
      const lots: LotRow[] = [];
      if (it.tracksLots || it.tracksExpiry) {
        if (lotChoice === 'new' || lotChoice === 'auto') {
          if (it.tracksExpiry && !newLotExpiry) return { problem: kt('Indica la fecha de caducidad.') };
          lotId = newItemId();
          lots.push({ id: lotId, itemId: it.id, code: newLotCode.trim() || null, expiresOn: newLotExpiry || null });
        } else lotId = lotChoice;
      }
      const after = Math.round((stockBySpace(snap.stock, it.id, [from]).get(from) ?? 0) * 1e6) / 1e6 + amount;
      return { movements: [{ id: newItemId(), itemId: it.id, spaceId: from, lotId, quantity: amount, kind: 'entrada_manual', ...common, unitCost: c }], lots,
        text: [kt('Habrá '), el('strong', null, qty(after, it.baseUnit)), ` ${kt('en {space}.', { space: spaceName(from) })}`], warn: null };
    }
    if (mode === 'exit' && !reason) return { problem: kt('Elige el motivo.') };
    if (mode === 'transfer') {
      if (!toSpace) return { problem: kt('Elige a dónde va.') };
      if (toSpace === from) return { problem: kt('El destino tiene que ser otro sitio.') };
    }
    const lots = snap.lots ?? [];
    const parts = lotChoice !== 'auto'
      ? { parts: [{ lotId: lotChoice, quantity: amount }], shortfall: 0 }
      : fefoPlan(it.id, from, amount, snap.stock, lots);
    const pieces = [...parts.parts, ...(parts.shortfall > 0 ? [{ lotId: null, quantity: parts.shortfall }] : [])];
    const movements: MovementDraft[] = [];
    for (const p of pieces) {
      if (mode === 'exit') movements.push({ id: newItemId(), itemId: it.id, spaceId: from, lotId: p.lotId, quantity: -p.quantity, kind: 'salida_manual', ...common, reason });
      else {
        const transferId = newItemId();
        movements.push({ id: newItemId(), itemId: it.id, spaceId: from, lotId: p.lotId, quantity: -p.quantity, kind: 'traslado', ...common, transferId });
        movements.push({ id: newItemId(), itemId: it.id, spaceId: toSpace!, lotId: p.lotId, quantity: p.quantity, kind: 'traslado', ...common, transferId });
      }
    }
    const here = stockBySpace(snap.stock, it.id, [from]).get(from) ?? 0;
    const left = Math.round((here - amount) * 1e6) / 1e6;
    const byId = new Map(lots.map((l) => [l.id, l]));
    const named = parts.parts.filter((p) => p.lotId).map((p) => byId.get(p.lotId!) ?? null);
    const text: (string | HTMLElement)[] = [];
    if (named.length) text.push(named.length === 1 ? kt('Sale del ') : kt('Sale de '), el('strong', null, named.map((l) => lotLabel(l)).join(', ')), '. ');
    text.push(kt('Quedarán '), el('strong', null, qty(Math.max(left, 0), it.baseUnit)), ` ${kt('en {space}', { space: spaceName(from) })}`);
    if (mode === 'transfer') text.push(` ${kt('y habrá')} `, el('strong', null, qty((stockBySpace(snap.stock, it.id, [toSpace!]).get(toSpace!) ?? 0) + amount, it.baseUnit)), ` ${kt('en {space}', { space: spaceName(toSpace) })}`);
    text.push('.');
    const lotQty = lotChoice !== 'auto' ? stockAt(snap.stock, it.id, from, lotChoice) : here;
    const warn = amount > lotQty + 1e-9 ? kt('En este dispositivo constan {q}: se registra igual (puede faltar algo por sincronizar).', { q: qty(Math.max(lotQty, 0), it.baseUnit) }) : null;
    return { movements, lots: [], text, warn };
  }

  function paintSummary(): void {
    const p = plan();
    if ('problem' in p) { replace(summary); summary.hidden = true; return; }
    summary.hidden = false;
    replace(summary, ...p.text, p.warn ? el('span', { class: 'stk-warn stk-mov-warn' }, icon('warn', 14), p.warn) : null);
  }

  async function submit(): Promise<void> {
    if (saving || !options.source.record) return;
    if (picker) pick = { ...pick, ...picker.get() };
    const p = plan();
    if ('problem' in p) { error.textContent = p.problem; return; }
    saving = true;
    saveBtn.disabled = true;
    try {
      await options.source.record({ movements: p.movements, lots: p.lots });
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
      status.textContent = offline ? kt('Registrado en este dispositivo: se sube al volver la red.') : kt('Registrado.');
      options.onDone?.(p.movements);
      // Listo para otro del mismo artículo: se vacía la cantidad y la nota.
      note = '';
      cost = '';
      newLotCode = '';
      picker?.set({ quantity: null });
      pick = { ...pick, quantity: null, baseQuantity: null };
      paintExtra();
    } catch (e) {
      error.textContent = kt('No se ha registrado: {message}', { message: (e as Error)?.message ?? '' });
    } finally {
      saving = false;
      saveBtn.disabled = false;
    }
  }

  // --- Datos -------------------------------------------------------------------------------------------------
  // El primer dato pinta los lotes; después, cada aviso de la fuente (otra sincronización) solo cambia el resumen,
  // para no rehacer los campos mientras se escribe.
  let loaded = false;
  const setSnapshot = (next: ItemSnapshot) => { snap = next; if (!loaded) { loaded = true; paintExtra(); } else paintSummary(); };
  const offSource = options.source.subscribe?.(setSnapshot);
  const offSpaces = options.spaces && !Array.isArray(options.spaces) ? options.spaces.subscribe((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paintSummary(); }) : null;
  if (options.spaces && !Array.isArray(options.spaces)) void Promise.resolve(options.spaces.list()).then((rows) => { spaceRows = rows; spaceIndex = indexSpaces(rows); paintSummary(); });
  void Promise.resolve(options.source.list()).then(setSnapshot);
  paintModes();
  buildPicker();
  paintExtra();

  return {
    element,
    setMode,
    focus() { picker?.focus(); },
    destroy() { offSource?.(); offSpaces?.(); picker?.destroy(); toPicker?.destroy(); element.remove(); },
  };
}
