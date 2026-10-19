/**
 * Recorrido con la etapa marcada (MUELA-075, pieza 4): las etapas en fila, la actual marcada, ✓ en las hechas y «!» en
 * las que tienen aviso. La etapa de cada cosa la calcula la app (p. ej. la proyección de estados de una factura).
 * - `<ol>` con `aria-label` «Recorrido: etapa n de N, X» y `aria-current="step"` en la actual.
 * - Con `onPick`, cada etapa es un botón de al menos 64 px con «hecho / ahora / parado / después, con avisos»; sin él, no
 *   es tocable y no cuenta como objetivo.
 * - `mini` para filas de lista: puntos pequeños y las etiquetas ocultas solo a la vista.
 * Prefijo de clases: `stage-`.
 */
import { el } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';

export interface Stage {
  key: string;
  label: string;
}

export type StageState = 'done' | 'here' | 'later' | 'stop';

export interface StagesOptions {
  /** Nombre del recorrido («Recorrido de la reserva»). */
  label: string;
  stages: Stage[];
  /** Etapa actual por clave o por posición; `-1` o `null` = parado (cancelada, en la papelera…). */
  current: string | number | null;
  /** Etapas con aviso: claves o `{ clave: true }`. */
  bad?: string[] | Record<string, boolean>;
  /** Tocar una etapa (abrir su pestaña). Sin esto, el recorrido no es tocable. */
  onPick?: (key: string) => void;
  mini?: boolean;
  /** Una línea bajo el recorrido («Siguiente: cobrar la señal»). */
  caption?: string | null;
  /** Lo que se dice cuando está parado; por defecto «El recorrido está parado.». */
  stopText?: string | null;
  feedbackId?: string;
}

const STATE_TEXT: Record<StageState, string> = { done: 'hecho', here: 'ahora', later: 'después', stop: 'parado' };

/** Estado de cada etapa según la actual (función pura, para la app y las pruebas). */
export function stageStates(stages: Stage[], current: string | number | null): StageState[] {
  const index = typeof current === 'number' ? current : current === null ? -1 : stages.findIndex((s) => s.key === current);
  return stages.map((_, i) => (index < 0 || index >= stages.length ? 'stop' : i < index ? 'done' : i === index ? 'here' : 'later'));
}

export function renderStages(options: StagesOptions): HTMLElement {
  const { stages } = options;
  const states = stageStates(stages, options.current);
  const here = states.indexOf('here');
  const stopped = here < 0;
  const badSet = new Set(Array.isArray(options.bad) ? options.bad : Object.entries(options.bad ?? {}).filter(([, v]) => v).map(([k]) => k));
  const base = options.feedbackId;
  const summary = stopped
    ? kt('{label}: parado', { label: options.label })
    : kt('{label}: etapa {n} de {m}, {stage}', { label: options.label, n: String(here + 1), m: String(stages.length), stage: stages[here]!.label });
  const list = el('ol', {
    class: `stage-list${options.mini ? ' stage-mini' : ''}${options.onPick ? ' stage-pickable' : ''}`, 'aria-label': summary, style: `--stage-count:${stages.length}`,
    ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}),
  },
  ...stages.map((stage, i) => {
    const state = states[i]!;
    const bad = badSet.has(stage.key) && state !== 'done';
    const said = `${stage.label}: ${kt(STATE_TEXT[state])}${bad ? kt(', con avisos') : ''}`;
    const inner = [
      el('span', { class: 'stage-dot', 'aria-hidden': 'true' }, state === 'done' ? '✓' : String(i + 1)),
      el('span', { class: `stage-label${options.mini ? ' vh' : ''}`, 'aria-hidden': options.onPick ? 'true' : null }, stage.label),
      bad ? el('span', { class: 'stage-bad', 'aria-hidden': 'true' }, '!') : null,
      options.onPick ? null : el('span', { class: 'vh' }, `: ${kt(STATE_TEXT[state])}${bad ? kt(', con avisos') : ''}`),
    ];
    return el('li', { class: 'stage-item', dataset: { state, stage: stage.key, ...(bad ? { bad: 'true' } : {}) }, 'aria-current': state === 'here' ? 'step' : null },
      options.onPick
        ? el('button', { type: 'button', class: 'stage-step', 'aria-label': said, ...(base ? { 'data-feedback-id': `${base}.etapa`, 'data-feedback-label': 'Etapa del recorrido' } : {}), onclick: () => options.onPick!(stage.key) }, ...inner)
        : el('span', { class: 'stage-step' }, ...inner));
  }));
  const caption = stopped ? (options.stopText ?? kt('El recorrido está parado.')) : options.caption;
  return el('div', { class: 'stage-box' }, list, caption ? el('p', { class: `hint ${stopped ? 'stage-stop' : 'stage-caption'}` }, caption) : null);
}
