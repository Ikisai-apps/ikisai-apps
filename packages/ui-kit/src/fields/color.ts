/**
 * Campo de color propio (sin el diálogo nativo, que en Android abre con los deslizadores a cero en vez de en el color
 * elegido): sugerencias, «Sin color» opcional y «Personalizado», que despliega en línea tres degradados —matiz, saturación
 * y brillo— colocados ya sobre el color actual, con vista previa y código hexadecimal.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';

export interface Hsv { h: number; s: number; v: number }

/** `#rgb` o `#rrggbb` → `#rrggbb` en minúsculas; `null` si no es un color válido. */
export function normalizeHex(value: string | null | undefined): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value ?? '').trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return `#${hex.toLowerCase()}`;
}

export function hexToHsv(hex: string): Hsv {
  const n = normalizeHex(hex) ?? '#000000';
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(n.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) + 360) % 360), s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
}

export function hsvToHex({ h, s, v }: Hsv): string {
  const sat = Math.max(0, Math.min(100, s)) / 100, val = Math.max(0, Math.min(100, v)) / 100;
  const c = val * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = val - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
}

export interface ColorFieldOptions {
  label?: string;
  /** Color inicial (`#rrggbb`) o `null` sin color. */
  value?: string | null;
  /** Colores sugeridos (los de la app). */
  suggestions?: string[];
  /** Ofrecer «Sin color». */
  allowNone?: boolean;
  /** Abrir el personalizado al empezar (p. ej. si el color actual no es una sugerencia). Por defecto, cuando no lo es. */
  openCustom?: boolean;
  onChange?: (value: string | null) => void;
  /** Ganchos de la app en el contenedor (`id`, `data-*`). */
  attrs?: Record<string, string | null | undefined>;
}

export interface ColorField {
  element: HTMLElement;
  get(): string | null;
  set(value: string | null): void;
}

export function createColorField(options: ColorFieldOptions): ColorField {
  let value = normalizeHex(options.value) ;
  let hsv = hexToHsv(value ?? (options.suggestions?.[0] ?? '#6b7b54'));
  const suggestions = (options.suggestions ?? []).map((c) => normalizeHex(c)).filter((c): c is string => !!c);
  const swatches = el('div', { class: 'cf-swatches', role: 'radiogroup', 'aria-label': options.label ?? 'Color' });
  const preview = el('span', { class: 'cf-preview', 'aria-hidden': 'true' });
  const hex = el('input', { class: 'cf-hex compact', type: 'text', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Código del color' }) as HTMLInputElement;
  const slider = (name: keyof Hsv, label: string, max: number) => el('input', { type: 'range', class: `cf-range cf-${name}`, min: '0', max: String(max), step: '1', 'aria-label': label, dataset: { channel: name } }) as HTMLInputElement;
  const sliders = { h: slider('h', 'Matiz', 359), s: slider('s', 'Saturación', 100), v: slider('v', 'Brillo', 100) };
  const custom = el('div', { class: 'cf-custom', hidden: true },
    el('label', { class: 'cf-row' }, el('span', null, 'Matiz'), sliders.h),
    el('label', { class: 'cf-row' }, el('span', null, 'Saturación'), sliders.s),
    el('label', { class: 'cf-row' }, el('span', null, 'Brillo'), sliders.v),
    el('div', { class: 'cf-result' }, preview, hex),
  );
  const customButton = el('button', { type: 'button', class: 'cf-swatch cf-more', 'aria-expanded': 'false', 'aria-label': 'Color personalizado', title: 'Personalizado' }, icon('edit', 16));
  const element = el('div', { class: 'colorfield', ...(options.attrs ?? {}) },
    options.label ? el('span', { class: 'cf-label' }, options.label) : null,
    swatches, custom);

  function emit(): void { options.onChange?.(value); }
  function paintSliders(): void {
    sliders.h.value = String(hsv.h); sliders.s.value = String(hsv.s); sliders.v.value = String(hsv.v);
    // Cada degradado se calcula a partir del color actual: así se abre ya colocado sobre él.
    sliders.s.style.setProperty('--cf-track', `linear-gradient(90deg, ${hsvToHex({ ...hsv, s: 0 })}, ${hsvToHex({ ...hsv, s: 100 })})`);
    sliders.v.style.setProperty('--cf-track', `linear-gradient(90deg, #000, ${hsvToHex({ ...hsv, v: 100 })})`);
    preview.style.background = value ?? 'transparent';
    if (document.activeElement !== hex) hex.value = value ?? '';
  }
  function paintSwatches(): void {
    const isSuggestion = !!value && suggestions.includes(value);
    replace(swatches,
      ...suggestions.map((c) => el('button', { type: 'button', class: `cf-swatch${value === c ? ' on' : ''}`, role: 'radio', 'aria-checked': String(value === c), 'aria-label': `Color ${c}`, style: `--cf-color:${c}`, dataset: { color: c }, onclick: () => { set(c); emit(); } })),
      options.allowNone ? el('button', { type: 'button', class: `cf-swatch cf-none${value === null ? ' on' : ''}`, role: 'radio', 'aria-checked': String(value === null), 'aria-label': 'Sin color', onclick: () => { set(null); emit(); } }) : null,
      customButton,
    );
    customButton.classList.toggle('on', !!value && !isSuggestion);
    customButton.style.setProperty('--cf-color', value && !isSuggestion ? value : 'transparent');
  }
  function set(next: string | null): void {
    value = normalizeHex(next);
    if (value) hsv = hexToHsv(value);
    paintSwatches(); paintSliders();
  }
  function toggleCustom(open = custom.hidden): void {
    custom.hidden = !open;
    customButton.setAttribute('aria-expanded', String(open));
    if (open && !value) { value = hsvToHex(hsv); paintSwatches(); paintSliders(); emit(); }
  }
  customButton.addEventListener('click', () => toggleCustom());
  for (const input of Object.values(sliders)) input.addEventListener('input', () => {
    hsv = { h: +sliders.h.value, s: +sliders.s.value, v: +sliders.v.value };
    value = hsvToHex(hsv); paintSwatches(); paintSliders(); emit();
  });
  hex.addEventListener('input', () => { const n = normalizeHex(hex.value); if (n) { value = n; hsv = hexToHsv(n); paintSwatches(); paintSliders(); emit(); } });
  hex.addEventListener('blur', () => { hex.value = value ?? ''; });

  set(value);
  if (options.openCustom ?? (!!value && !suggestions.includes(value))) toggleCustom(true);
  return { element, get: () => value, set };
}
