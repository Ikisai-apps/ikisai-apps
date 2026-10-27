/**
 * Formulario libre (encargo de Core del 27-10 para el catálogo de piezas de Flow, `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`):
 * preguntas que vienen de un esquema JSON, pregunta a pregunta sobre `createStepForm`. Al final se revisan las respuestas
 * («Cambiar» en cada una) y se pulsa «Registrar».
 * - Tipos: `text` (una línea, o `multiline`), `number` (`min`, `max`, `unit`), `yesno`, `choice` (`options`) y `photo`.
 * - Las opcionales llevan «Saltar» y responden `null`. Las obligatorias no avanzan vacías.
 * - Respuestas: un objeto `{ id: texto | número | true/false | valor | ref de foto | null }`, que se entrega a `onSubmit`.
 * - Foto: el kit la recomprime (`compressImage`) y se la da a `onPhoto`, que la sube y devuelve su referencia. Sin
 *   `onPhoto`, la pregunta de foto no se puede contestar.
 * - No guarda nada por su cuenta: solo registra a través de `onSubmit`.
 * Prefijo de clases: `fform-` (más los `ask-` de `createStepForm`).
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { createSaveState } from '../fields/save-state.ts';
import { compressImage, isImageFile } from '../media/compress-image.ts';
import { createStepForm, StepFormInvalid, type StepQuestion } from './step-form.ts';

export type FreeFormKind = 'text' | 'number' | 'yesno' | 'choice' | 'photo';

export interface FreeFormQuestion {
  id: string;
  label: string;
  kind: FreeFormKind;
  required?: boolean;
  hint?: string | null;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  /** Unidad del número («°C», «kg»): sale junto al campo y en la revisión. */
  unit?: string | null;
  multiline?: boolean;
}

export interface FreeFormSchema {
  version?: number;
  questions: FreeFormQuestion[];
}

export type FreeFormAnswer = string | number | boolean | null;
export type FreeFormAnswers = Record<string, FreeFormAnswer>;

export interface FreeFormOptions {
  label: string;
  schema: FreeFormSchema;
  /** Respuestas ya dadas (un borrador): esas no se preguntan y salen en la revisión. */
  value?: FreeFormAnswers;
  /** Sube la foto y devuelve su referencia (id o URL). */
  onPhoto?: (image: Blob, filename: string) => Promise<string>;
  /** Registra el formulario. Si la promesa falla, se queda en la revisión con «No se guardó». */
  onSubmit: (answers: FreeFormAnswers) => Promise<unknown> | void;
  /** Se ha registrado: por defecto, «Registrado» y «Nuevo registro». */
  onDone?: (answers: FreeFormAnswers) => void;
  submitLabel?: string;
  doneTitle?: string;
  feedbackId?: string;
}

export interface FreeForm {
  element: HTMLElement;
  answers(): FreeFormAnswers;
  /** Vuelve a empezar, vacío (o con `value`). */
  reset(value?: FreeFormAnswers): void;
}

const ID = /^[a-z][a-z0-9_]{0,30}$/;

/** Esquema válido: ids correctos y sin repetir, tipos conocidos, `choice` con opciones. Devuelve los problemas. */
export function freeFormProblems(schema: FreeFormSchema): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!schema || !Array.isArray(schema.questions) || !schema.questions.length) return ['sin preguntas'];
  if (schema.questions.length > 40) out.push('más de 40 preguntas');
  for (const q of schema.questions) {
    if (!q || typeof q.id !== 'string' || !ID.test(q.id)) { out.push(`id no válido: ${String(q?.id)}`); continue; }
    if (seen.has(q.id)) out.push(`id repetido: ${q.id}`);
    seen.add(q.id);
    if (!['text', 'number', 'yesno', 'choice', 'photo'].includes(q.kind)) out.push(`${q.id}: tipo desconocido`);
    if (typeof q.label !== 'string' || !q.label.trim()) out.push(`${q.id}: sin texto`);
    if (q.kind === 'choice' && !(q.options ?? []).length) out.push(`${q.id}: sin opciones`);
  }
  return out;
}

/** Número escrito en español o con punto («36,5» o «36.5»); `null` si no lo es. */
function parseNumber(text: string): number | null {
  const t = text.trim().replace(/\s/g, '');
  if (!/^-?\d+([.,]\d+)?$/.test(t)) return null;
  return Number(t.replace(',', '.'));
}

export function createFreeForm(options: FreeFormOptions): FreeForm {
  const problems = freeFormProblems(options.schema);
  if (problems.length) console.warn(`[ui-kit] createFreeForm: ${problems.join('; ')}`);
  const questions = (options.schema?.questions ?? []).filter((q) => q && typeof q.id === 'string' && ID.test(q.id));
  const base = options.feedbackId;
  const mark = (suffix: string, label: string) => (base ? { 'data-feedback-id': `${base}.${suffix}`, 'data-feedback-label': label } : {});
  const element = el('section', { class: 'fform-box', 'aria-label': options.label, ...(base ? { 'data-feedback-id': base, 'data-feedback-label': options.label } : {}) });
  let answers: FreeFormAnswers = {};
  /** Contestadas en esta pasada (también las saltadas, que valen `null`). */
  let given = new Set<string>();
  const thumbs = new Map<string, string>();
  const save = createSaveState();

  const display = (q: FreeFormQuestion, a: FreeFormAnswer | undefined): string => {
    if (a === null || a === undefined || a === '') return kt('Sin respuesta');
    if (q.kind === 'yesno') return a ? kt('Sí') : kt('No');
    if (q.kind === 'choice') return q.options?.find((o) => o.value === a)?.label ?? String(a);
    if (q.kind === 'number') return `${String(a).replace('.', ',')}${q.unit ? ` ${q.unit}` : ''}`;
    if (q.kind === 'photo') return kt('Foto añadida');
    return String(a);
  };

  /** Valor de `createStepForm` (texto) a respuesta tipada; lanza `StepFormInvalid` si no vale. */
  function convert(q: FreeFormQuestion, raw: string | string[]): FreeFormAnswer {
    const text = Array.isArray(raw) ? raw.join(',') : raw;
    if (text === '') {
      if (q.required) throw new StepFormInvalid(kt('Esta pregunta es obligatoria.'));
      return null;
    }
    if (q.kind === 'number') {
      const n = parseNumber(text);
      if (n === null) throw new StepFormInvalid(kt('Escribe un número.'));
      if (q.min !== undefined && n < q.min) throw new StepFormInvalid(kt('Tiene que ser {n} o más.', { n: String(q.min).replace('.', ',') }));
      if (q.max !== undefined && n > q.max) throw new StepFormInvalid(kt('Tiene que ser {n} o menos.', { n: String(q.max).replace('.', ',') }));
      return n;
    }
    if (q.kind === 'yesno') return text === 'yes';
    return text;
  }

  /** La pregunta del formulario como pregunta de `createStepForm`. */
  function toStep(q: FreeFormQuestion): StepQuestion {
    const a = answers[q.id];
    const has = given.has(q.id);
    const hint = [q.hint, q.kind === 'number' && q.unit ? kt('En {unit}', { unit: q.unit }) : null, q.required ? null : kt('Opcional')].filter(Boolean).join(' · ') || undefined;
    const common = { id: q.id, question: q.label, hint, skip: !q.required };
    if (q.kind === 'yesno') return { ...common, kind: 'choice', options: [{ value: 'yes', label: kt('Sí') }, { value: 'no', label: kt('No') }], value: has && a !== null ? (a ? 'yes' : 'no') : null };
    if (q.kind === 'choice') return { ...common, kind: 'choice', options: q.options ?? [], value: has && a !== null ? String(a) : null };
    if (q.kind === 'number') return { ...common, kind: 'text', inputType: 'text', inputAttrs: { inputmode: 'decimal', autocomplete: 'off' }, value: has && a !== null ? String(a).replace('.', ',') : null, field: { type: 'number' } };
    if (q.kind === 'photo') return { ...common, kind: 'custom', value: has && a !== null ? String(a) : null, render: (ctx) => photoControl(q, ctx) };
    return { ...common, kind: 'text', multiline: q.multiline, value: has && a !== null ? String(a) : null };
  }

  function photoControl(q: FreeFormQuestion, ctx: { submit(v: string): void; value: string | string[]; labelId: string; field: Record<string, string | null> }): HTMLElement {
    const status = el('p', { class: 'hint fform-photostatus', role: 'status' });
    const preview = el('div', { class: 'fform-photo' });
    const shown = thumbs.get(q.id);
    if (shown) preview.append(el('img', { src: shown, alt: kt('Foto de «{q}»', { q: q.label }) }));
    const input = el('input', { type: 'file', accept: 'image/*', class: 'vh', 'aria-labelledby': ctx.labelId, ...ctx.field,
      onchange: async () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (!isImageFile(file)) { status.textContent = kt('Eso no es una foto.'); return; }
        if (!options.onPhoto) { status.textContent = kt('Aquí no se pueden subir fotos.'); return; }
        status.textContent = kt('Subiendo la foto…');
        pick.disabled = true;
        try {
          const img = await compressImage(file).catch(() => null);
          const blob = img?.full ?? file;
          const ref = await options.onPhoto(blob, img?.filename ?? (file as File).name ?? 'foto');
          const url = URL.createObjectURL(img?.thumb ?? blob);
          const old = thumbs.get(q.id);
          if (old) URL.revokeObjectURL(old);
          thumbs.set(q.id, url);
          status.textContent = '';
          ctx.submit(ref);
        } catch {
          status.textContent = kt('No se pudo subir la foto. Prueba otra vez.');
        } finally {
          pick.disabled = false;
        }
      } }) as HTMLInputElement;
    const pick = el('button', { type: 'button', class: 'primary fform-pick', ...mark('foto', 'Hacer o elegir foto'), onclick: () => input.click() },
      shown ? kt('Cambiar la foto') : kt('Hacer o elegir foto'));
    const keep = shown && ctx.value ? el('button', { type: 'button', class: 'ghost', onclick: () => ctx.submit(String(ctx.value)) }, kt('Dejar esta')) : null;
    return el('div', { class: 'fform-photofield' }, preview, el('div', { class: 'ask-ok' }, pick, keep), input, status);
  }

  /** Pregunta a pregunta: lo que falta; con `only`, solo esa (desde «Cambiar»). */
  function ask(only?: FreeFormQuestion, focus = true): void {
    const list = only ? [only] : questions.filter((q) => !given.has(q.id));
    if (!list.length) { review(); return; }
    const form = createStepForm({
      label: options.label,
      questions: list.map(toStep),
      answered: () => false,
      feedbackId: base ? `${base}.preguntas` : undefined,
      onAnswer: (sq, raw) => {
        const q = questions.find((x) => x.id === sq.id)!;
        answers = { ...answers, [q.id]: convert(q, raw) };
        given.add(q.id);
      },
      onDone: () => queueMicrotask(review),
    });
    replace(element, form.element);
    if (focus) (element.querySelector<HTMLElement>('.ask-input') ?? element.querySelector<HTMLElement>('.ask-question'))?.focus();
  }

  function review(): void {
    const missing = questions.filter((q) => q.required && (answers[q.id] === null || answers[q.id] === undefined));
    const sendError = el('p', { class: 'fielderror fform-error', role: 'alert' });
    const send = el('button', { type: 'button', class: 'primary fform-send', ...mark('registrar', options.submitLabel ?? 'Registrar'), disabled: missing.length > 0,
      onclick: async () => {
        send.disabled = true;
        sendError.textContent = '';
        const work = () => Promise.resolve().then(() => options.onSubmit({ ...answers }));
        try {
          await save.track('fform', work(), { retry: work });
        } catch {
          // Sin red queda pendiente y se da por registrado; otro fallo: se dice aquí y se vuelve a pulsar «Registrar».
          if (save.field('fform').status() !== 'pending') { save.set('fform', 'idle'); sendError.textContent = kt('No se pudo registrar. Prueba otra vez.'); send.disabled = false; return; }
        }
        done();
      } }, options.submitLabel ?? kt('Registrar'));
    replace(element,
      el('h3', { class: 'fform-title', tabindex: '-1' }, kt('Revisa antes de registrar')),
      el('dl', { class: 'fform-review' }, ...questions.map((q) => {
        const a = answers[q.id];
        const thumb = q.kind === 'photo' && a ? thumbs.get(q.id) : null;
        return el('div', { class: 'fform-row', dataset: { question: q.id, empty: String(a === null || a === undefined) } },
          el('dt', null, q.label, q.required ? null : el('span', { class: 'fform-opt' }, ` · ${kt('Opcional')}`)),
          el('dd', null, thumb ? el('img', { class: 'fform-thumb', src: thumb, alt: '' }) : null, el('span', { class: 'fform-answer' }, display(q, a)),
            el('button', { type: 'button', class: 'ghost small fform-change', 'aria-label': kt('Cambiar «{q}»', { q: q.label }), ...mark('cambiar', 'Cambiar'), onclick: () => ask(q) }, kt('Cambiar'))));
      })),
      missing.length ? el('p', { class: 'fielderror', role: 'alert' }, kt('Faltan preguntas obligatorias: {list}', { list: missing.map((q) => q.label).join(', ') })) : null,
      sendError,
      el('div', { class: 'ask-foot' }, send, save.element));
    element.querySelector<HTMLElement>('.fform-title')?.focus();
  }

  function done(): void {
    const sent = { ...answers };
    if (options.onDone) { options.onDone(sent); return; }
    replace(element, el('div', { class: 'ask-done' },
      el('p', { class: 'ask-donetitle', tabindex: '-1' }, el('span', { class: 'step-check', 'aria-hidden': 'true' }, '✓'), options.doneTitle ?? kt('Registrado')),
      el('div', { class: 'ask-ok' }, el('button', { type: 'button', class: 'ghost', ...mark('nuevo', 'Nuevo registro'), onclick: () => api.reset() }, kt('Nuevo registro')))));
    element.querySelector<HTMLElement>('.ask-donetitle')?.focus();
  }

  function start(value?: FreeFormAnswers): void {
    answers = {};
    given = new Set();
    for (const q of questions) if (value && Object.prototype.hasOwnProperty.call(value, q.id)) { answers[q.id] = value[q.id] ?? null; given.add(q.id); }
    if (!questions.length) { replace(element, el('p', { class: 'hint' }, kt('Este formulario no tiene preguntas.'))); return; }
    ask(undefined, false);
  }

  const api: FreeForm = {
    element,
    answers: () => ({ ...answers }),
    reset(value) { for (const u of thumbs.values()) URL.revokeObjectURL(u); thumbs.clear(); start(value); element.querySelector<HTMLElement>('.ask-input, .ask-question')?.focus(); },
  };
  start(options.value);
  return api;
}
