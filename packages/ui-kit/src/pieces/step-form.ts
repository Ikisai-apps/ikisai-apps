/**
 * Pregunta a pregunta (MUELA-075, pieza 20: Guests y Central): una pregunta cada vez, **solo de lo que falta**, con
 * «Pregunta 2 de 7» y su barra. Las opciones guardan al tocarlas y pasan a la siguiente; el texto se acepta con
 * «Aceptar» o Intro. Lo que se pregunta, qué falta, cómo se valida y dónde se guarda es de la app.
 * Es la mecánica del formulario progresivo de «Ayuda y sugerencias» (`createFeedbackProgressiveForm`), sacada para
 * cualquier formulario; aquel sigue igual (allí no se cuentan pasos porque la hoja crece al contestar).
 * - Guardado: `onAnswer` devuelve una promesa; el estado se ve con `createSaveState` («Guardando…», «Guardado»,
 *   «Pendiente: se guardará con conexión»).
 * - Error de validación: `onAnswer` lanza `StepFormInvalid` con el texto; sale bajo la pregunta y no avanza.
 * - La barra no retrocede aunque deje de faltar algo por el camino.
 * - Inventario de campos: con `feedbackId`, cada pregunta se marca sola como `<feedbackId>.<id>` (en minúsculas, `checkIn` →
 *   `check_in`) con su tipo; `field` en la pregunta añade entidad, propiedad, permiso, sensibilidad…
 * Prefijo de clases: `ask-`.
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { createSaveState } from '../fields/save-state.ts';
import { fieldAttrs, type FieldSpec } from '../fields/field-mark.ts';

export interface StepQuestion {
  id: string;
  question: string;
  /** `choice`: una opción (guarda al tocar). `multi`: varias y «Aceptar». `text`: un campo y «Aceptar» o Intro. */
  kind: 'choice' | 'multi' | 'text';
  options?: { value: string; label: string }[];
  /** Una línea bajo la pregunta («Lo pide el registro de viajeros»). */
  hint?: string;
  /** Tipo del campo de texto (`date`, `email`, `tel`…). */
  inputType?: string;
  placeholder?: string;
  value?: string | string[] | null;
  /** Inventario de campos (`field-mark.ts`): entidad, propiedad, obligatorio, permiso, sensibilidad… El id sale de `feedbackId` e `id`. */
  field?: Partial<FieldSpec>;
}

/** Lánzalo desde `onAnswer` para no avanzar y enseñar el motivo bajo la pregunta. */
export class StepFormInvalid extends Error {}

export interface StepFormOptions {
  label: string;
  /** Todas las preguntas, en orden. */
  questions: StepQuestion[];
  /** Ya contestada (no se pregunta). Por defecto, las que traen `value`. */
  answered?: (q: StepQuestion) => boolean;
  /** Guarda la respuesta; si lanza `StepFormInvalid`, no avanza. */
  onAnswer: (q: StepQuestion, value: string | string[]) => Promise<unknown> | void;
  onDone?: () => void;
  doneTitle?: string;
  doneText?: string;
  feedbackId?: string;
}

export interface StepForm {
  element: HTMLElement;
  /** Vuelve a una pregunta (p. ej. «Cambiar» desde una revisión). */
  goTo(id: string): void;
}

export function createStepForm(options: StepFormOptions): StepForm {
  const answered = options.answered ?? ((q) => q.value != null && q.value !== '' && !(Array.isArray(q.value) && !q.value.length));
  // Lo que falta al empezar fija el total: así la barra no vuelve atrás.
  let queue = options.questions.filter((q) => !answered(q));
  const total = Math.max(1, queue.length);
  let index = 0;
  const answers = new Map<string, string | string[]>();
  const save = createSaveState();
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const element = el('section', { class: 'ask-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) });
  let uid = 0;
  const fieldOf = (q: StepQuestion) => {
    const own = q.field?.id ?? (base ? `${base}.${q.id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}` : null);
    if (!own || !/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$/.test(own)) return {};
    return fieldAttrs({ ...q.field, id: own }, { type: q.kind === 'text' ? q.inputType ?? 'text' : q.kind === 'choice' ? 'select' : 'multi', label: q.question });
  };

  async function submit(q: StepQuestion, value: string | string[], error: HTMLElement): Promise<void> {
    error.textContent = '';
    const work = () => Promise.resolve().then(() => options.onAnswer(q, value));
    try {
      await save.track(q.id, work(), { retry: work });
    } catch (e) {
      if (e instanceof StepFormInvalid) { save.set(q.id, 'idle'); error.textContent = e.message; return; }
      // Sin red, queda pendiente y se sigue; cualquier otro fallo se queda aquí con «No se guardó» y «Reintentar».
      if (save.field(q.id).status() !== 'pending') return;
    }
    answers.set(q.id, value);
    index += 1;
    paint(true);
  }

  function paint(focus = false): void {
    if (index >= queue.length) {
      replace(element, el('div', { class: 'ask-done' },
        el('p', { class: 'ask-donetitle', tabindex: '-1' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), options.doneTitle ?? kt('¡Listo! Ya está todo')),
        options.doneText ? el('p', null, options.doneText) : null, save.element));
      if (focus) element.querySelector<HTMLElement>('.ask-donetitle')?.focus();
      options.onDone?.();
      return;
    }
    const q = queue[index]!;
    const n = total - (queue.length - index) + 1;
    const id = `kit-ask-${++uid}`;
    const error = el('p', { class: 'fielderror ask-error', role: 'alert' });
    const current = answers.get(q.id) ?? q.value ?? (q.kind === 'multi' ? [] : '');
    let body: HTMLElement;
    if (q.kind === 'text') {
      const input = el('input', { id: `${id}-input`, class: 'ask-input', type: q.inputType ?? 'text', value: String(current ?? ''), placeholder: q.placeholder ?? null, 'aria-describedby': `${id}-hint`, ...fieldOf(q),
        onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); void submit(q, input.value.trim(), error); } } }) as HTMLInputElement;
      body = el('div', { class: 'ask-field' }, input,
        el('div', { class: 'ask-ok' }, el('button', { type: 'button', class: 'primary', ...mark('aceptar', 'Aceptar'), onclick: () => void submit(q, input.value.trim(), error) }, kt('Aceptar')), el('span', { class: 'hint' }, kt('o pulsa Intro'))));
    } else {
      const picked = new Set(Array.isArray(current) ? current : current ? [current] : []);
      const group = el('div', { class: 'ask-choices', role: 'group', 'aria-labelledby': `${id}-q`, ...fieldOf(q) },
        ...(q.options ?? []).map((o, i) => {
          const btn = el('button', { type: 'button', class: 'ask-choice', 'aria-pressed': String(picked.has(o.value)), ...mark('opcion', 'Opción'),
            onclick: () => {
              if (q.kind === 'choice') {
                for (const b of group.querySelectorAll('.ask-choice')) b.setAttribute('aria-pressed', 'false');
                btn.setAttribute('aria-pressed', 'true');
                // Se ve marcada un momento antes de pasar.
                setTimeout(() => void submit(q, o.value, error), 350);
              } else {
                if (picked.has(o.value)) picked.delete(o.value); else picked.add(o.value);
                btn.setAttribute('aria-pressed', String(picked.has(o.value)));
              }
            } },
          el('span', { class: 'ask-key', 'aria-hidden': 'true' }, String.fromCharCode(65 + i)), o.label);
          return btn;
        }));
      body = el('div', { class: 'ask-field' }, group,
        q.kind === 'multi' ? el('div', { class: 'ask-ok' }, el('button', { type: 'button', class: 'primary', ...mark('aceptar', 'Aceptar'), onclick: () => void submit(q, [...picked], error) }, kt('Aceptar'))) : null);
    }
    replace(element,
      el('p', { class: 'ask-meta' }, kt('Pregunta {n} de {m}', { n: String(n), m: String(total) })),
      el('div', { class: 'ask-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n), 'aria-label': kt('Pregunta {n} de {m}', { n: String(n), m: String(total) }) },
        el('span', { style: `width:${Math.round((n / total) * 100)}%` })),
      el(q.kind === 'text' ? 'label' : 'p', { class: 'ask-question', id: `${id}-q`, ...(q.kind === 'text' ? { for: `${id}-input` } : {}), tabindex: '-1' }, q.question),
      q.hint ? el('p', { class: 'hint ask-hint', id: `${id}-hint` }, q.hint) : null,
      body, error,
      el('div', { class: 'ask-foot' },
        index > 0 ? el('button', { type: 'button', class: 'ghost', ...mark('atras', 'Atrás'), onclick: () => { index -= 1; paint(true); } }, kt('Atrás')) : el('span'),
        save.element));
    if (focus) (element.querySelector<HTMLElement>('.ask-input') ?? element.querySelector<HTMLElement>('.ask-question'))?.focus();
  }

  paint();
  return {
    element,
    goTo(id) {
      let at = queue.findIndex((q) => q.id === id);
      if (at < 0) { const q = options.questions.find((x) => x.id === id); if (!q) return; queue = [...queue, q]; at = queue.length - 1; }
      index = at;
      paint(true);
    },
  };
}
