import { el } from '../dom.ts';
import { icon } from '../icons.ts';

export interface QuantityUnit {
  /** Valor que se guarda (`g`, `kg`, `ud`, `l`, `EUR`). */
  value: string;
  /** Texto visible; por defecto el valor. */
  label?: string;
}

export interface QuantityFieldOptions {
  label: string;
  name: string;
  id?: string;
  value?: number | null;
  /** Unidad inicial; con una sola unidad se muestra fija. */
  unit?: string;
  units?: QuantityUnit[];
  /** Decimales admitidos; por defecto 2. */
  decimals?: number;
  /** Mostrar siempre todos los decimales (importes): `1234,50`. */
  fixedDecimals?: boolean;
  min?: number;
  max?: number;
  /** Paso de los botones + y −; sin paso no hay botones. */
  step?: number;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  onChange?: (value: QuantityValue) => void;
  locale?: string;
}

export interface QuantityValue {
  value: number | null;
  unit: string | null;
}

export interface QuantityField {
  element: HTMLElement;
  input: HTMLInputElement;
  select: HTMLSelectElement | null;
  get(): QuantityValue;
  set(value: QuantityValue): void;
  /** Muestra un error bajo el campo; cadena vacía lo quita. */
  setError(message: string): void;
  /** `null` si vacío, `NaN` si no es un número válido. */
  parse(): number | null;
}

/** Interpreta un número escrito a la española o a la inglesa: «1.234,5», «1234.5», «1 234,5». */
export function parseQuantity(text: string): number | null {
  const raw = text.trim().replace(/\s/g, '');
  if (!raw) return null;
  let normalized = raw;
  const lastComma = raw.lastIndexOf(','), lastDot = raw.lastIndexOf('.');
  if (lastComma > lastDot) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (lastDot > lastComma) normalized = raw.replace(/,/g, '');
  if (!/^-?\d*(\.\d+)?$/.test(normalized) || normalized === '-' || normalized === '') return Number.NaN;
  return Number(normalized);
}

export function formatQuantity(value: number | null, decimals = 2, locale = 'es-ES', fixed = false): string {
  if (value === null || Number.isNaN(value)) return '';
  return new Intl.NumberFormat(locale, { minimumFractionDigits: fixed ? decimals : 0, maximumFractionDigits: decimals, useGrouping: false }).format(value);
}

/** Campo de cantidad con unidad (gramos, unidades, euros…): decimales a la española, botones de paso y validación. */
export function createQuantityField(options: QuantityFieldOptions): QuantityField {
  const id = options.id ?? `qty-${options.name}`;
  const decimals = options.decimals ?? 2;
  const units = options.units ?? (options.unit ? [{ value: options.unit }] : []);
  const input = el('input', {
    id, name: options.name, type: 'text', inputmode: decimals > 0 ? 'decimal' : 'numeric', autocomplete: 'off', spellcheck: 'false',
    placeholder: options.placeholder ?? (decimals > 0 ? '0,00' : '0'), required: !!options.required, disabled: !!options.disabled,
    value: formatQuantity(options.value ?? null, decimals, options.locale, options.fixedDecimals), 'aria-describedby': `${id}-error`,
  });
  const select = units.length > 1
    ? el('select', { id: `${id}-unit`, name: `${options.name}_unit`, 'aria-label': `Unidad de ${options.label.toLowerCase()}`, disabled: !!options.disabled },
      ...units.map((u) => el('option', { value: u.value, selected: u.value === (options.unit ?? units[0]!.value) }, u.label ?? u.value)))
    : null;
  const fixedUnit = units.length === 1 ? el('span', { class: 'qty-unit', 'aria-hidden': 'true' }, units[0]!.label ?? units[0]!.value) : null;
  const error = el('span', { class: 'fielderror', id: `${id}-error`, role: 'alert' });
  const stepButtons = options.step
    ? [
      el('button', { class: 'iconbtn small qty-step', type: 'button', 'aria-label': 'Restar', disabled: !!options.disabled, onclick: () => nudge(-1) }, icon('minus', 16)),
      el('button', { class: 'iconbtn small qty-step', type: 'button', 'aria-label': 'Sumar', disabled: !!options.disabled, onclick: () => nudge(1) }, icon('plus', 16)),
    ]
    : [];

  const control = el('div', { class: `qty${select ? ' with-select' : ''}${fixedUnit ? ' with-unit' : ''}` }, stepButtons[0] ?? null, el('div', { class: 'qty-input' }, input, fixedUnit), select, stepButtons[1] ?? null);
  const element = el('div', { class: 'field qtyfield' }, el('label', { for: id }, options.label), control, options.hint ? el('span', { class: 'hint' }, options.hint) : null, error);

  function parse(): number | null {
    return parseQuantity(input.value);
  }

  function get(): QuantityValue {
    const value = parse();
    return { value: value === null || Number.isNaN(value) ? null : value, unit: select ? select.value : units[0]?.value ?? null };
  }

  function validate(): boolean {
    const value = parse();
    if (value === null) {
      setError(options.required ? 'Indica una cantidad.' : '');
      return !options.required;
    }
    if (Number.isNaN(value)) { setError('Escribe un número, por ejemplo 12,5.'); return false; }
    if (options.min !== undefined && value < options.min) { setError(`Mínimo ${formatQuantity(options.min, decimals)}.`); return false; }
    if (options.max !== undefined && value > options.max) { setError(`Máximo ${formatQuantity(options.max, decimals)}.`); return false; }
    const scaled = Math.round(value * 10 ** decimals) / 10 ** decimals;
    if (scaled !== value) { setError(decimals === 0 ? 'Sin decimales.' : `Como mucho ${decimals} decimales.`); return false; }
    setError('');
    return true;
  }

  function setError(message: string): void {
    error.textContent = message;
    element.classList.toggle('invalid', !!message);
    input.setAttribute('aria-invalid', String(!!message));
  }

  function nudge(direction: 1 | -1): void {
    const step = options.step ?? 1;
    const current = parse();
    let next = (current === null || Number.isNaN(current) ? 0 : current) + step * direction;
    if (options.min !== undefined) next = Math.max(options.min, next);
    if (options.max !== undefined) next = Math.min(options.max, next);
    next = Math.round(next * 10 ** decimals) / 10 ** decimals;
    input.value = formatQuantity(next, decimals, options.locale, options.fixedDecimals);
    validate();
    options.onChange?.(get());
  }

  input.addEventListener('input', () => { if (error.textContent) validate(); options.onChange?.(get()); });
  input.addEventListener('blur', () => { if (validate()) { const v = parse(); if (v !== null && !Number.isNaN(v)) input.value = formatQuantity(v, decimals, options.locale, options.fixedDecimals); } });
  input.addEventListener('keydown', (e) => {
    if (!options.step) return;
    if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
  });
  select?.addEventListener('change', () => options.onChange?.(get()));

  return {
    element,
    input,
    select,
    get,
    set({ value, unit }) {
      input.value = formatQuantity(value, decimals, options.locale, options.fixedDecimals);
      if (select && unit) select.value = unit;
      setError('');
    },
    setError,
    parse,
  };
}
