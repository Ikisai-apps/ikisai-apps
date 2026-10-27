/**
 * Estrella de nivel (petición de Central, para el nivel de las capacidades; Tasks la adoptará en P2 para la prioridad):
 * una sola estrella que se rellena por pasos, con el aspecto de la estrella de prioridad de Tasks (vacía, media, llena con
 * tres niveles). Pulsar pasa al siguiente nivel y vuelve al primero; las flechas suben y bajan, Inicio y Fin van a los
 * extremos. Objetivo táctil de 44×44 y el nombre del nivel se anuncia al cambiar.
 */
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { fieldAttrs, type FieldSpec } from './field-mark.ts';

const STAR = 'M12 3.2l2.7 5.6 6.1.8-4.5 4.2 1.2 6.1L12 17l-5.5 2.9 1.2-6.1-4.5-4.2 6.1-.8z';
const SVG = 'http://www.w3.org/2000/svg';

/** Proporción rellena de la estrella para el nivel `value` de `levels` (0 vacía, 1 llena). */
export function levelFill(value: number, levels: number): number {
  if (levels <= 1) return 1;
  return Math.max(0, Math.min(1, value / (levels - 1)));
}

function starSvg(fill: number): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'level-star-icon');
  const outline = document.createElementNS(SVG, 'path');
  outline.setAttribute('d', STAR);
  outline.setAttribute('class', 'level-star-outline');
  const solid = document.createElementNS(SVG, 'path');
  solid.setAttribute('d', STAR);
  solid.setAttribute('class', 'level-star-fill');
  // Relleno de izquierda a derecha, como la estrella «alta» (media) de Tasks.
  solid.style.clipPath = `inset(0 ${Math.round((1 - fill) * 100)}% 0 0)`;
  if (fill === 0) solid.style.opacity = '0';
  svg.append(outline, solid);
  return svg;
}

/** Estrella de solo lectura para filas y tarjetas (`role="img"` con el nombre del nivel). */
export function renderLevelStar(value: number, levels: number, label: string): HTMLElement {
  return el('span', { class: 'level-star static', role: 'img', 'aria-label': label, dataset: { level: String(value) } }, starSvg(levelFill(value, levels)));
}

export interface LevelStarOptions {
  /** Número de niveles (3: vacía, media, llena). */
  levels: number;
  /** Nombre de cada nivel, del más bajo al más alto (`['Aprendiz', 'Sabe', 'Experto']`). */
  labels: string[];
  /** Nivel actual, de 0 a `levels - 1`. */
  value?: number;
  onChange?: (value: number) => void;
  readonly?: boolean;
  /** Qué mide, para el nombre accesible: «Nivel», «Prioridad». */
  name?: string;
  /** Muestra el nombre del nivel junto a la estrella (como el botón de prioridad de la ficha de Tasks). */
  showLabel?: boolean;
  /** Marca de feedback y uso del botón. */
  feedbackId?: string;
  feedbackLabel?: string;
  /** Inventario de campos (`field-mark.ts`): id estable, entidad, propiedad, permiso y sensibilidad. */
  field?: FieldSpec;
}

export interface LevelStar {
  element: HTMLElement;
  get(): number;
  /** Cambia el nivel sin llamar a `onChange`. */
  set(value: number): void;
  setReadonly(readonly: boolean): void;
}

export function createLevelStar(options: LevelStarOptions): LevelStar {
  const levels = Math.max(1, options.levels);
  const clamp = (v: number) => Math.max(0, Math.min(levels - 1, Math.round(Number.isFinite(v) ? v : 0)));
  let value = clamp(options.value ?? 0);
  let readonly = !!options.readonly;
  const what = options.name ?? kt('Nivel');
  const labelOf = (v: number) => options.labels[v] ?? String(v + 1);

  const live = el('span', { class: 'vh', 'aria-live': 'polite' });
  const text = el('span', { class: 'level-star-label' });
  const button = el('button', {
    type: 'button', class: `level-star${options.showLabel ? ' with-label' : ''}`,
    ...fieldAttrs(options.field, { type: 'level', label: what }),
    ...(options.feedbackId ? { 'data-feedback-id': options.feedbackId, 'data-feedback-label': options.feedbackLabel ?? what } : {}),
    onclick: () => { if (!readonly) change((value + 1) % levels); },
    onkeydown: (e: Event) => {
      const ev = e as KeyboardEvent;
      if (readonly) return;
      const keys: Record<string, number> = { ArrowUp: value + 1, ArrowRight: value + 1, ArrowDown: value - 1, ArrowLeft: value - 1, Home: 0, End: levels - 1 };
      if (!(ev.key in keys)) return;
      ev.preventDefault();
      change(clamp(keys[ev.key]!));
    },
  });
  const element = el('span', { class: 'level-star-wrap' }, button, live);

  function paint(): void {
    const name = labelOf(value);
    button.replaceChildren(starSvg(levelFill(value, levels)), ...(options.showLabel ? [text] : []));
    text.textContent = name;
    button.dataset.level = String(value);
    button.setAttribute('aria-label', readonly
      ? kt('{what}: {level}', { what, level: name })
      : kt('{what}: {level}. Pulsa para cambiar; flechas arriba y abajo para subir o bajar', { what, level: name }));
    button.title = readonly ? name : kt('{level} · pulsa para cambiar', { level: name });
    button.setAttribute('aria-disabled', String(readonly));
    button.classList.toggle('readonly', readonly);
  }

  function change(next: number): void {
    if (next === value) return;
    value = next;
    paint();
    live.textContent = kt('{what}: {level}', { what, level: labelOf(value) });
    options.onChange?.(value);
  }

  paint();
  return {
    element,
    get: () => value,
    set(next) { value = clamp(next); paint(); },
    setReadonly(next) { readonly = next; paint(); },
  };
}
