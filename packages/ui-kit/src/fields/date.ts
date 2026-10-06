import { el, replace } from '../dom.ts';
import { addDays, fromDayKey, todayKey, type DayKey } from '../calendar/calendar.ts';

export interface DateShortcut {
  label: string;
  /** Días desde hoy (`0` hoy, `1` mañana, `7` en una semana) o una fecha fija. */
  days?: number;
  date?: DayKey;
  /** Vacía el campo. */
  clear?: boolean;
}

export const DEFAULT_SHORTCUTS: DateShortcut[] = [
  { label: 'Hoy', days: 0 },
  { label: 'Mañana', days: 1 },
  { label: '+7 días', days: 7 },
  { label: 'Quitar', clear: true },
];

export interface DateFieldOptions {
  label: string;
  name: string;
  id?: string;
  value?: DayKey | null;
  min?: DayKey | null;
  max?: DayKey | null;
  /** Atajos; por defecto Hoy, Mañana, +7 días y Quitar. `[]` los oculta. */
  shortcuts?: DateShortcut[];
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  /** Mostrar bajo el campo la fecha en palabras y la distancia a hoy; por defecto sí. */
  describe?: boolean;
  onChange?: (value: DayKey | null) => void;
  locale?: string;
}

export interface DateField {
  element: HTMLElement;
  input: HTMLInputElement;
  get(): DayKey | null;
  set(value: DayKey | null): void;
  setMin(min: DayKey | null): void;
  setMax(max: DayKey | null): void;
  setError(message: string): void;
  /** Comprueba obligatorio y límites; muestra el error y devuelve si es válido. */
  validate(): boolean;
}

/** «Hoy», «Mañana», «Ayer», «en 3 días», «hace 2 días», «en 3 semanas»… */
export function relativeDayLabel(key: DayKey, from: DayKey = todayKey()): string {
  const diff = Math.round((fromDayKey(key).getTime() - fromDayKey(from).getTime()) / 86_400_000);
  if (diff === 0) return 'Hoy';
  if (diff === 1) return 'Mañana';
  if (diff === -1) return 'Ayer';
  const abs = Math.abs(diff);
  const unit = abs >= 60 ? [Math.round(abs / 30), 'mes', 'meses'] as const : abs >= 14 ? [Math.round(abs / 7), 'semana', 'semanas'] as const : [abs, 'día', 'días'] as const;
  const text = `${unit[0]} ${unit[0] === 1 ? unit[1] : unit[2]}`;
  return diff > 0 ? `en ${text}` : `hace ${text}`;
}

/** «martes, 13 de octubre de 2026». */
export function longDayLabel(key: DayKey, locale = 'es-ES'): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(fromDayKey(key));
}

function isDayKey(value: string): value is DayKey {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(fromDayKey(value).getTime());
}

/** Campo de fecha (nativo, con selector del sistema en móvil) con atajos, descripción en palabras y validación de límites. */
export function createDateField(options: DateFieldOptions): DateField {
  const id = options.id ?? `date-${options.name}`;
  const shortcuts = options.shortcuts ?? DEFAULT_SHORTCUTS;
  let min = options.min ?? null;
  let max = options.max ?? null;
  const input = el('input', { id, name: options.name, type: 'date', value: options.value ?? '', min: min ?? null, max: max ?? null, required: !!options.required, disabled: !!options.disabled, 'aria-describedby': `${id}-desc ${id}-error` });
  const description = el('span', { class: 'hint date-desc', id: `${id}-desc` });
  const error = el('span', { class: 'fielderror', id: `${id}-error`, role: 'alert' });
  const row = shortcuts.length
    ? el('div', { class: 'date-shortcuts', role: 'group', 'aria-label': `Atajos de ${options.label.toLowerCase()}` }, ...shortcuts.map((s) => el('button', {
      class: `ghost small${s.clear ? ' date-clear' : ''}`, type: 'button', disabled: !!options.disabled, dataset: { shortcut: s.clear ? 'clear' : s.date ?? `+${s.days ?? 0}` },
      onclick: () => { set(s.clear ? null : s.date ?? addDays(todayKey(), s.days ?? 0)); options.onChange?.(get()); input.focus({ preventScroll: true }); },
    }, s.label)))
    : null;
  const element = el('div', { class: 'field datefield' }, el('label', { for: id }, options.label), input, row, options.hint ? el('span', { class: 'hint' }, options.hint) : null, description, error);

  function get(): DayKey | null {
    return isDayKey(input.value) ? input.value : null;
  }

  function describe(): void {
    const value = get();
    if (options.describe === false || !value) { replace(description); description.hidden = true; return; }
    description.hidden = false;
    const long = longDayLabel(value, options.locale);
    replace(description, `${long.charAt(0).toUpperCase()}${long.slice(1)} · ${relativeDayLabel(value)}`);
    row?.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
      const s = b.dataset.shortcut!;
      const target = s === 'clear' ? null : s.startsWith('+') ? addDays(todayKey(), Number(s.slice(1))) : s;
      b.classList.toggle('active', target !== null && target === value);
      b.setAttribute('aria-pressed', String(target !== null && target === value));
    });
  }

  function setError(message: string): void {
    error.textContent = message;
    element.classList.toggle('invalid', !!message);
    input.setAttribute('aria-invalid', String(!!message));
  }

  function validate(): boolean {
    const value = get();
    if (!value) {
      if (input.value && !isDayKey(input.value)) { setError('Fecha no válida.'); return false; }
      setError(options.required ? 'Indica una fecha.' : '');
      return !options.required;
    }
    if (min && value < min) { setError(`No puede ser anterior al ${new Intl.DateTimeFormat(options.locale ?? 'es-ES', { day: 'numeric', month: 'short' }).format(fromDayKey(min))}.`); return false; }
    if (max && value > max) { setError(`No puede ser posterior al ${new Intl.DateTimeFormat(options.locale ?? 'es-ES', { day: 'numeric', month: 'short' }).format(fromDayKey(max))}.`); return false; }
    setError('');
    return true;
  }

  function set(value: DayKey | null): void {
    input.value = value ?? '';
    describe();
    if (error.textContent) validate();
  }

  input.addEventListener('input', () => { describe(); if (error.textContent) validate(); options.onChange?.(get()); });
  input.addEventListener('blur', () => validate());
  describe();

  return {
    element,
    input,
    get,
    set,
    setMin(next) { min = next; if (next) input.min = next; else input.removeAttribute('min'); },
    setMax(next) { max = next; if (next) input.max = next; else input.removeAttribute('max'); },
    setError,
    validate,
  };
}
