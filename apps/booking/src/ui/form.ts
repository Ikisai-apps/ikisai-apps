/** Formularios de fila: se describen con una lista de campos y solo viaja al servidor lo que cambia. */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { attachSuggestions, confirmDialog, el, openSheet, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { validateFields } from '@ikisai/domain-booking';
import { guard } from '../app/guard.ts';
import { describeError } from '../app/client.ts';
import { settleBatch } from '../app/settle.ts';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'tel' | 'email' | 'number' | 'date' | 'time' | 'select' | 'check' | 'textarea' | 'multi';
  /** Para `number`: admite céntimos (importes). */
  decimal?: boolean;
  /** Para `number`: admite valores negativos (descuentos). */
  negative?: boolean;
  /** Para `select` y `multi`: valor y etiqueta. Con `optional` se añade una opción vacía que guarda null. */
  options?: ReadonlyArray<readonly [string, string]>;
  optional?: boolean;
  max?: number;
  /** Guarda el texto en mayúsculas y sin espacios (documentos, códigos de país). */
  upper?: boolean;
  /** Título de sección que se pinta antes de este campo. */
  section?: string;
  hint?: string;
  /** Para `date`: límites (AAAA-MM-DD) del selector. */
  dateMin?: string | null;
  dateMax?: string | null;
  /** No es una columna: pide un dato para `buildOperations` y no viaja como campo. */
  local?: boolean;
  /** Solo se muestra cuando otro campo del formulario tiene ese valor (p. ej. camas solo en habitaciones). */
  showWhen?: { key: string; value: unknown };
  /**
   * Para `text`: nombres que ya existen (FB_2026_014). Se ofrecen en una lista con búsqueda y se avisa si el valor es nuevo o
   * parecido a uno existente. `suggestMode`: `pick` (elegir entre lo que hay: zona, lugar) o `unique` (no repetir: nombre).
   */
  suggestions?: readonly string[];
  suggestMode?: 'pick' | 'unique';
  /** Dato personal (contacto, documento…): se marca `data-feedback-ignore`. Teléfonos y correos lo son siempre. */
  personal?: boolean;
}

export interface BuiltForm {
  element: HTMLElement;
  /** Valores normalizados (null para vacío), listos para `fields`. */
  values(): Record<string, unknown>;
  /** Solo los campos que difieren de la fila de partida. */
  changed(): Record<string, unknown>;
  dirty(): boolean;
  showError(message: string | null): void;
  onChange(listener: () => void): void;
  first(): HTMLElement | null;
}

function normalize(spec: FieldSpec, raw: unknown): unknown {
  if (spec.type === 'check') return raw === true;
  if (raw === null || raw === undefined) return null;
  // Casillas múltiples: lista en el orden del catálogo; vacía = null.
  if (spec.type === 'multi') {
    const chosen = Array.isArray(raw) ? raw.map(String) : [];
    const ordered = (spec.options ?? []).map(([value]) => value).filter((value) => chosen.includes(value));
    return ordered.length ? ordered : null;
  }
  if (spec.type === 'number') return raw === '' ? null : Number(raw);
  let text = String(raw);
  if (spec.type === 'time') text = text.slice(0, 5);
  text = spec.upper ? text.replace(/\s+/g, '').toUpperCase() : text.trim();
  return text === '' ? null : text;
}

/** Marca pequeña junto a la etiqueta de un campo (p. ej. quién lo rellenó); null si no hay. */
export type FieldMark = (key: string) => Child;

/**
 * `feedbackBase` (p. ej. `booking.reservas.alta`) da a cada campo el id `<base>.<clave>`; la etiqueta es la del campo.
 * Sin base no se marca nada (formularios de otras pantallas que ya marcan por su cuenta).
 */
export function buildForm(specs: readonly FieldSpec[], row: Record<string, unknown> | null, defaults: Record<string, unknown> = {}, mark?: FieldMark, feedbackBase?: string): BuiltForm {
  const listeners: Array<() => void> = [];
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const multis = new Map<string, HTMLInputElement[]>();
  const initial: Record<string, unknown> = {};
  const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
  const children: Child[] = [];
  const conditional: Array<{ wrap: HTMLElement; spec: FieldSpec }> = [];
  const syncVisibility = () => {
    for (const { wrap, spec } of conditional) {
      const control = controls.get(spec.showWhen!.key);
      wrap.hidden = !!control && control.value !== String(spec.showWhen!.value);
    }
  };
  const fieldMarks = (spec: FieldSpec): Record<string, string> => feedbackBase
    ? { 'data-feedback-id': `${feedbackBase}.${spec.key}`, 'data-feedback-label': spec.label.slice(0, 60), ...(spec.personal || spec.type === 'tel' || spec.type === 'email' ? { 'data-feedback-ignore': '' } : {}) }
    : {};
  const fire = () => { error.hidden = true; syncVisibility(); listeners.forEach((listener) => listener()); };

  for (const spec of specs) {
    const start = row && row[spec.key] !== undefined ? row[spec.key] : defaults[spec.key];
    initial[spec.key] = normalize(spec, start ?? (spec.type === 'check' ? false : null));
    const shown = initial[spec.key];
    const id = `f-${spec.key}`;
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
    if (spec.type === 'multi') {
      const chosen = Array.isArray(shown) ? shown : [];
      const boxes = (spec.options ?? []).map(([value]) => el('input', { type: 'checkbox', value, checked: chosen.includes(value), onchange: fire }));
      multis.set(spec.key, boxes);
      if (spec.section) children.push(el('div', { class: 'sectionlabel formsection' }, spec.section));
      children.push(el('fieldset', { class: 'field multi', id, ...fieldMarks(spec) }, el('legend', null, spec.label),
        (spec.options ?? []).map(([, text], i) => el('label', { class: 'check' }, boxes[i]!, el('span', null, text))),
        spec.hint ? el('small', { class: 'hint' }, spec.hint) : null));
      continue;
    }
    if (spec.type === 'select') {
      control = el('select', { id, onchange: fire },
        spec.optional ? el('option', { value: '' }, '—') : null,
        (spec.options ?? []).map(([value, label]) => el('option', { value }, label)));
      control.value = shown === null ? '' : String(shown);
    } else if (spec.type === 'textarea') {
      control = el('textarea', { id, rows: 3, maxlength: spec.max ?? 10000, oninput: fire }, shown === null ? '' : String(shown));
    } else if (spec.type === 'check') {
      control = el('input', { id, type: 'checkbox', checked: shown === true, onchange: fire });
    } else {
      control = el('input', {
        id, type: spec.type, value: shown === null ? '' : String(shown), autocomplete: 'off', oninput: fire,
        ...(spec.max && spec.type !== 'date' ? { maxlength: spec.max } : {}),
        ...(spec.type === 'date' && spec.dateMin ? { min: spec.dateMin } : {}), ...(spec.type === 'date' && spec.dateMax ? { max: spec.dateMax } : {}), ...(spec.type === 'number' ? { ...(spec.negative ? {} : { min: 0 }), step: spec.decimal ? 0.01 : 1, inputmode: spec.decimal ? 'decimal' : 'numeric' } : {}),
      });
    }
    controls.set(spec.key, control);
    if (spec.section) children.push(el('div', { class: 'sectionlabel formsection' }, spec.section));
    const suggest = spec.type === 'text' && spec.suggestions ? attachSuggestions(control as HTMLInputElement, { values: spec.suggestions, mode: spec.suggestMode ?? 'pick', ...(feedbackBase ? { feedbackId: `${feedbackBase}.${spec.key}` } : {}) }).element : null;
    const wrap = spec.type === 'check'
      ? el('label', { class: 'check', ...fieldMarks(spec) }, control, el('span', null, spec.label, mark?.(spec.key) ?? null))
      : el('label', { class: 'field', ...fieldMarks(spec) }, el('span', null, spec.label, mark?.(spec.key) ?? null), control, suggest, spec.hint ? el('small', { class: 'hint' }, spec.hint) : null);
    if (spec.showWhen) conditional.push({ wrap, spec });
    children.push(wrap);
  }
  syncVisibility();

  function values(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const spec of specs) {
      if (spec.type === 'multi') { out[spec.key] = normalize(spec, multis.get(spec.key)!.filter((box) => box.checked).map((box) => box.value)); continue; }
      const control = controls.get(spec.key)!;
      out[spec.key] = normalize(spec, spec.type === 'check' ? (control as HTMLInputElement).checked : control.value);
    }
    return out;
  }
  function changed(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(values()).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(initial[key])));
  }

  return {
    element: el('div', { class: 'rowform' }, children, error),
    values,
    changed,
    dirty: () => Object.keys(changed()).length > 0,
    showError(message) { error.hidden = !message; error.textContent = message ?? ''; },
    onChange(listener) { listeners.push(listener); },
    first: () => controls.get(specs[0]?.key ?? '') ?? null,
  };
}

export interface RowSheetOptions {
  client: SyncClient;
  title: string;
  table: TableName;
  specs: readonly FieldSpec[];
  /** Fila existente (edición) o null (alta). */
  row: SyncedRow | null;
  /** Valores iniciales de un alta. */
  defaults?: Record<string, unknown>;
  /** Campos que se añaden al alta sin estar en el formulario (enlace con el padre). */
  insertFields?: Record<string, unknown>;
  /** Id del alta; por defecto uno nuevo. */
  insertId?: string;
  /** Regla sobre la fila completa (fusionada). Devuelve el mensaje de error o null. */
  check?: (merged: Record<string, unknown>) => string | null;
  /** Contenido extra bajo el formulario (avisos, acciones). Se vuelve a pedir en cada cambio. */
  extra?: (merged: Record<string, unknown>, form: BuiltForm) => Child;
  /** Operaciones adicionales del mismo lote. */
  extraOperations?: (id: string, fields: Record<string, unknown>) => RowOperation[];
  /** Botón de borrado en el pie: operaciones que mandan la fila a la papelera. */
  remove?: { label: string; operations: () => RowOperation[]; confirm?: string; /** Confirmación con el diálogo del kit (en vez de `confirm` del navegador). */ confirmDialog?: { title: string; text: string; confirmLabel: string } };
  savedMessage?: string;
  /** Marca junto a la etiqueta de cada campo (origen del dato). */
  mark?: FieldMark;
  /** Base del id de feedback de la hoja (`booking.reservas.alta`): el formulario, cada campo y los botones cuelgan de ella. */
  feedbackId?: string;
  /** Etiqueta corta de la hoja para «Sugerencias y QA»; por defecto, el título. */
  feedbackLabel?: string;
  /** Con red, espera a que el servidor resuelva el lote y, si lo rechaza, deja la hoja abierta con el motivo (reglas que solo comprueba el servidor). */
  settle?: boolean;
  submitLabel?: string;
  /** Sustituye el alta o edición estándar: recibe los valores del formulario y devuelve el lote a enviar. */
  buildOperations?: (values: Record<string, unknown>) => RowOperation[] | Promise<RowOperation[]>;
}

/** Hoja de alta o edición de una fila. Devuelve la hoja; el pie con `Guardar` solo aparece con cambios en una edición. */
export function openRowSheet(options: RowSheetOptions): Sheet {
  const { client, row, table } = options;
  const form = buildForm(options.specs, row, options.defaults, options.mark, options.feedbackId);
  const fbAttrs = (suffix: string, label: string): Record<string, string> => (options.feedbackId ? { 'data-feedback-id': `${options.feedbackId}.${suffix}`, 'data-feedback-label': label } : {});
  const merged = () => ({ ...(row ?? {}), ...(options.insertFields ?? {}), ...form.values() });
  const extraHost = el('div');
  const paintExtra = () => { extraHost.replaceChildren(); const extra = options.extra?.(merged(), form); if (extra) extraHost.append(...(Array.isArray(extra) ? (extra as Node[]) : [extra as Node])); };
  const save = el('button', { class: 'primary', type: 'button', id: 'saveRow', ...fbAttrs('guardar', 'Guardar'), onclick: () => void submit() }, options.submitLabel ?? 'Guardar');
  let sheet: Sheet;

  async function commit(operations: RowOperation[], message: string): Promise<void> {
    try {
      save.disabled = true;
      const { requestId } = await client.commit(operations);
      if (options.settle) {
        const rejected = await settleBatch(client, requestId);
        if (rejected) return form.showError(describeError(rejected.error));
      }
      guard.dirtyEditor = false;
      await sheet.close(true);
      toast(navigator.onLine ? message : `${message} Se enviará al reconectar.`);
    } catch (error) {
      form.showError(describeError(error));
    } finally {
      save.disabled = false;
    }
  }

  async function submit(): Promise<void> {
    if (options.buildOperations) {
      const problem = options.check?.(merged());
      if (problem) return form.showError(problem);
      const issue = validateFields(table, form.values(), 'update')[0];
      if (issue) return form.showError(issue.message);
      let operations: RowOperation[];
      try { operations = await options.buildOperations(form.values()); } catch (error) { return form.showError(error instanceof Error ? error.message : describeError(error)); }
      return commit(operations, options.savedMessage ?? 'Guardado.');
    }
    const id = row?.id ?? options.insertId ?? crypto.randomUUID();
    let fields: Record<string, unknown>;
    if (row) {
      fields = form.changed();
      if (Object.keys(fields).length === 0) return void sheet.close(true);
    } else {
      // En un alta no viajan los vacíos: la base pone sus valores por defecto.
      fields = { ...Object.fromEntries(Object.entries(form.values()).filter(([, value]) => value !== null)), ...(options.insertFields ?? {}) };
    }
    // Primero la regla de la pantalla (mensaje más concreto); después la validación común con la Edge.
    const problem = options.check?.(merged());
    if (problem) return form.showError(problem);
    const issue = validateFields(table, fields, row ? 'update' : 'insert')[0];
    if (issue) return form.showError(issue.message);
    const operation: RowOperation = row
      ? { op: 'update', table, id, expectedRevision: row.revision, fields }
      : { op: 'insert', table, id, fields };
    await commit([operation, ...(options.extraOperations?.(id, fields) ?? [])], options.savedMessage ?? 'Guardado.');
  }

  const removeButton = options.remove && row
    ? el('button', { class: 'danger', type: 'button', id: 'removeRow', ...fbAttrs('eliminar', 'Eliminar'), onclick: async () => {
        if (options.remove!.confirm && !confirm(options.remove!.confirm)) return;
        if (options.remove!.confirmDialog && !(await confirmDialog({ ...options.remove!.confirmDialog, danger: true }))) return;
        void commit(options.remove!.operations(), 'Enviado a la papelera.');
      } }, options.remove.label)
    : null;

  form.onChange(() => {
    guard.dirtyEditor = form.dirty();
    // El pie (Guardar y Cancelar) solo aparece en una edición cuando hay cambios; la hoja siempre tiene su aspa.
    sheet.setFootHidden(!!row && !guard.dirtyEditor);
    paintExtra();
  });
  paintExtra();

  sheet = openSheet({
    title: options.title,
    ...(row ? { meta: `Revisión ${row.revision}` } : {}),
    body: el('form', { ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.feedbackLabel ?? options.title } : {}), onsubmit: (event: Event) => { event.preventDefault(); void submit(); } }, form.element, extraHost,
      removeButton ? el('p', { style: 'margin-top:18px' }, removeButton) : null),
    foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', ...fbAttrs('cancelar', 'Cancelar'), onclick: () => void sheet.close() }, 'Cancelar')),
    footHidden: !!row,
    beforeClose: () => !form.dirty() || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
    onClose: () => { guard.dirtyEditor = false; },
    initialFocus: form.first(),
  });
  return sheet;
}
