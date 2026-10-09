/**
 * Texto con sugerencias (de Booking, FB_2026_014; también para etiquetas de Tasks y proveedores de Finance): el campo
 * ofrece los valores que ya existen en una lista con búsqueda (`<datalist>` nativo: filtra al escribir y deja escribir uno
 * nuevo) y avisa si el valor es nuevo o se parece a uno que ya hay salvo mayúsculas, tildes o espacios («Sala Roble»
 * frente a «sala  roble»), con «Usar «X»» para quedarse con el existente.
 * - `mode: 'pick'`: se elige entre lo que hay (zona, lugar, proveedor): avisa de «parecido» y de «nuevo».
 * - `mode: 'unique'`: el nombre no debería repetirse (un espacio, una etiqueta): avisa si ya existe.
 * Mismo marcado que la versión de Booking (`small.hint.suggest[role=status]`), para migrar sin cambiar sus pruebas.
 */
import { el, replace } from '../dom.ts';
import { kitLocaleTag, kt } from '../i18n/i18n.ts';

/** Forma comparable: minúsculas, sin tildes, espacios simples y sin espacios en los extremos. */
export function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Valores únicos y no vacíos, en orden alfabético (idioma del kit); entre parecidos se queda el primero que aparece. */
export function uniqueNames(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const raw of values) {
    const value = (raw ?? '').trim();
    if (value && !seen.has(normalizeName(value))) seen.set(normalizeName(value), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, kitLocaleTag()));
}

export type NameMatch =
  | { kind: 'empty' }
  | { kind: 'exact'; match: string }
  | { kind: 'similar'; match: string }
  | { kind: 'new' };

/** ¿Existe ya? Exacto, parecido (mismo nombre salvo mayúsculas, tildes o espacios) o nuevo. */
export function matchName(value: string, existing: readonly string[]): NameMatch {
  const text = value.trim();
  if (!text) return { kind: 'empty' };
  const exact = existing.find((e) => e.trim() === text);
  if (exact) return { kind: 'exact', match: exact };
  const similar = existing.find((e) => normalizeName(e) === normalizeName(text));
  return similar ? { kind: 'similar', match: similar } : { kind: 'new' };
}

export type SuggestMode = 'pick' | 'unique';

/** Texto del aviso bajo el campo, o `null` si no hay nada que decir. */
export function suggestMessage(found: NameMatch, mode: SuggestMode): { text: string; use?: string; warn: boolean } | null {
  if (found.kind === 'empty') return null;
  if (mode === 'pick') {
    if (found.kind === 'exact') return null;
    if (found.kind === 'similar') return { text: kt('Ya existe «{match}».', { match: found.match }), use: found.match, warn: true };
    return { text: kt('Nuevo: no existe todavía.'), warn: false };
  }
  if (found.kind === 'new') return null;
  return { text: kt('Ya hay uno que se llama «{match}».', { match: found.match }), warn: true };
}

export interface SuggestOptions {
  /** Valores que ya existen (se limpian, se quitan repetidos y se ordenan). */
  values: ReadonlyArray<string | null | undefined>;
  mode?: SuggestMode;
  /** Se llama al usar el existente con «Usar «X»» (la app guarda). El campo ya tiene el valor nuevo. */
  onUse?: (value: string) => void;
  /** Base de la marca de feedback: el botón lleva `<feedbackId>_usar` («Usar el existente»). */
  feedbackId?: string;
}

export interface SuggestHandle {
  /** Lista (`datalist`) y aviso: van justo después del campo. */
  element: HTMLElement;
  /** Cambia los valores que existen. */
  setValues(values: ReadonlyArray<string | null | undefined>): void;
  /** Vuelve a mirar el valor del campo (si la app lo cambia por código). */
  check(): void;
  /** Coincidencia del valor actual. */
  match(): NameMatch;
}

let uid = 0;

/** Engancha la lista y el aviso a un campo que ya existe (como hace el formulario de Booking). */
export function attachSuggestions(input: HTMLInputElement, options: SuggestOptions): SuggestHandle {
  const mode = options.mode ?? 'pick';
  let values = uniqueNames(options.values);
  const id = input.id || `kit-suggest-${++uid}`;
  const listId = `${id}-list`;
  input.setAttribute('list', listId);
  const datalist = el('datalist', { id: listId });
  const status = el('small', { class: 'hint suggest', id: `${id}-suggest`, role: 'status' });
  input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), status.id].filter(Boolean).join(' '));

  function paintList(): void { replace(datalist, ...values.map((value) => el('option', { value }))); }
  function check(): void {
    const message = suggestMessage(matchName(input.value, values), mode);
    status.classList.toggle('warn', !!message?.warn);
    replace(status, message ? message.text : null, message?.use ? el('button', {
      type: 'button', class: 'linkbtn suggest-use',
      ...(options.feedbackId ? { 'data-feedback-id': `${options.feedbackId}_usar`, 'data-feedback-label': 'Usar el existente' } : {}),
      onclick: () => {
        input.value = message.use!;
        check();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        options.onUse?.(message.use!);
      },
    }, ' ', kt('Usar «{match}»', { match: message.use })) : null);
  }
  input.addEventListener('input', check);
  paintList();
  check();
  return {
    element: el('span', { class: 'suggest-wrap' }, datalist, status),
    setValues(next) { values = uniqueNames(next); paintList(); check(); },
    check,
    match: () => matchName(input.value, values),
  };
}

export interface SuggestFieldOptions extends SuggestOptions {
  label: string;
  name?: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  onChange?: (value: string) => void;
  attrs?: Record<string, string>;
}

export interface SuggestField extends SuggestHandle {
  input: HTMLInputElement;
  get(): string;
  set(value: string): void;
}

/** Campo de texto completo con sugerencias (etiqueta, campo, lista y aviso). */
export function createSuggestField(options: SuggestFieldOptions): SuggestField {
  const input = el('input', { type: 'text', name: options.name ?? null, placeholder: options.placeholder ?? null, required: options.required ?? false, autocomplete: 'off', id: `kit-suggest-field-${++uid}` }) as HTMLInputElement;
  input.value = options.value ?? '';
  input.addEventListener('change', () => options.onChange?.(input.value.trim()));
  const handle = attachSuggestions(input, options);
  const element = el('label', { class: 'field suggest-field', ...(options.attrs ?? {}) },
    el('span', null, options.label), input, handle.element, options.hint ? el('small', { class: 'hint' }, options.hint) : null);
  return {
    ...handle,
    element,
    input,
    get: () => input.value.trim(),
    set(value) { input.value = value; handle.check(); },
  };
}
