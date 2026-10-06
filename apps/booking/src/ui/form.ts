/** Formularios de fila: se describen con una lista de campos y solo viaja al servidor lo que cambia. */
import type { RowOperation, SyncClient, SyncedRow, TableName } from '@ikisai/sync-client';
import { el, openSheet, toast, type Child, type Sheet } from '@ikisai/ui-kit';
import { validateFields } from '@ikisai/domain-booking';
import { guard } from '../app/guard.ts';
import { describeError } from '../app/client.ts';

export interface FieldSpec {
  key: string;
  label: string;
  type: 'text' | 'tel' | 'email' | 'number' | 'date' | 'time' | 'select' | 'check' | 'textarea';
  /** Para `number`: admite céntimos (importes). */
  decimal?: boolean;
  /** Para `select`: valor y etiqueta. Con `optional` se añade una opción vacía que guarda null. */
  options?: ReadonlyArray<readonly [string, string]>;
  optional?: boolean;
  max?: number;
  /** Guarda el texto en mayúsculas y sin espacios (documentos, códigos de país). */
  upper?: boolean;
  /** Título de sección que se pinta antes de este campo. */
  section?: string;
  hint?: string;
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
  if (spec.type === 'number') return raw === '' ? null : Number(raw);
  let text = String(raw);
  if (spec.type === 'time') text = text.slice(0, 5);
  text = spec.upper ? text.replace(/\s+/g, '').toUpperCase() : text.trim();
  return text === '' ? null : text;
}

export function buildForm(specs: readonly FieldSpec[], row: Record<string, unknown> | null, defaults: Record<string, unknown> = {}): BuiltForm {
  const listeners: Array<() => void> = [];
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const initial: Record<string, unknown> = {};
  const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
  const fire = () => { error.hidden = true; listeners.forEach((listener) => listener()); };
  const children: Child[] = [];

  for (const spec of specs) {
    const start = row && row[spec.key] !== undefined ? row[spec.key] : defaults[spec.key];
    initial[spec.key] = normalize(spec, start ?? (spec.type === 'check' ? false : null));
    const shown = initial[spec.key];
    const id = `f-${spec.key}`;
    let control: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
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
        ...(spec.max ? { maxlength: spec.max } : {}), ...(spec.type === 'number' ? { min: 0, step: spec.decimal ? 0.01 : 1, inputmode: spec.decimal ? 'decimal' : 'numeric' } : {}),
      });
    }
    controls.set(spec.key, control);
    if (spec.section) children.push(el('div', { class: 'sectionlabel formsection' }, spec.section));
    children.push(spec.type === 'check'
      ? el('label', { class: 'check' }, control, el('span', null, spec.label))
      : el('label', { class: 'field' }, el('span', null, spec.label), control, spec.hint ? el('small', { class: 'hint' }, spec.hint) : null));
  }

  function values(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const spec of specs) {
      const control = controls.get(spec.key)!;
      out[spec.key] = normalize(spec, spec.type === 'check' ? (control as HTMLInputElement).checked : control.value);
    }
    return out;
  }
  function changed(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(values()).filter(([key, value]) => value !== initial[key]));
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
  remove?: { label: string; operations: () => RowOperation[]; confirm?: string };
  savedMessage?: string;
  submitLabel?: string;
  /** Sustituye el alta o edición estándar: recibe los valores del formulario y devuelve el lote a enviar. */
  buildOperations?: (values: Record<string, unknown>) => RowOperation[];
}

/** Hoja de alta o edición de una fila. Devuelve la hoja; el pie con `Guardar` solo aparece con cambios en una edición. */
export function openRowSheet(options: RowSheetOptions): Sheet {
  const { client, row, table } = options;
  const form = buildForm(options.specs, row, options.defaults);
  const merged = () => ({ ...(row ?? {}), ...(options.insertFields ?? {}), ...form.values() });
  const extraHost = el('div');
  const paintExtra = () => { extraHost.replaceChildren(); const extra = options.extra?.(merged(), form); if (extra) extraHost.append(...(Array.isArray(extra) ? (extra as Node[]) : [extra as Node])); };
  const save = el('button', { class: 'primary', type: 'button', id: 'saveRow', onclick: () => void submit() }, options.submitLabel ?? 'Guardar');
  let sheet: Sheet;

  async function commit(operations: RowOperation[], message: string): Promise<void> {
    try {
      save.disabled = true;
      await client.commit(operations);
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
      const issue = validateFields(table, form.values(), 'update')[0];
      if (issue) return form.showError(issue.message);
      return commit(options.buildOperations(form.values()), options.savedMessage ?? 'Guardado.');
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
    ? el('button', { class: 'danger', type: 'button', id: 'removeRow', onclick: () => {
        if (options.remove!.confirm && !confirm(options.remove!.confirm)) return;
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
    body: el('form', { onsubmit: (event: Event) => { event.preventDefault(); void submit(); } }, form.element, extraHost,
      removeButton ? el('p', { style: 'margin-top:18px' }, removeButton) : null),
    foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')),
    footHidden: !!row,
    beforeClose: () => !form.dirty() || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
    onClose: () => { guard.dirtyEditor = false; },
    initialFocus: form.first(),
  });
  return sheet;
}
