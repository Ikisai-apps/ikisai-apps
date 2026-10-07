/**
 * Formulario progresivo de los portales («Ayuda y sugerencias», especificación §3.2, §4 y §5): una pregunta cada vez,
 * la hoja crece al contestar (nada de «Paso 1 de 7»). Lo define la app con un catálogo de pasos, sin código de UI:
 * - `choice`: opciones; cada una puede llevar a otro paso (`next`), así se ramifica (Aplicación / Retiro / Espacio).
 * - `text`: comentario (y hasta 3 imágenes con `images: true`); es el último paso y lleva «Enviar».
 * - `signal`: «Mantén pulsado sobre el lugar de la aplicación…» con un botón para señalar.
 * Cambiar una respuesta anterior borra las de después. Lo que ya se sabe por el contexto (`known`) no se pregunta, y
 * `suggest` ofrece primero la opción probable («¿Es sobre Habitación 3?» · Sí · Otro sitio).
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { compressImage } from '../media/compress-image.ts';
import { FEEDBACK_MAX_ATTACHMENTS, FEEDBACK_MAX_MESSAGE } from './constants.ts';
import type { FeedbackImage } from './store.ts';

export type ProgressiveAnswers = Record<string, string>;

export interface ProgressiveOption { value: string; label: string; hint?: string; next?: string | null }

export interface ProgressiveStep {
  id: string;
  kind: 'choice' | 'text' | 'signal';
  question: string;
  options?: ProgressiveOption[] | ((answers: ProgressiveAnswers) => ProgressiveOption[]);
  /** Opción probable por el contexto: se pregunta «¿Es sobre …?» antes de enseñar todas. */
  suggest?: (answers: ProgressiveAnswers) => ProgressiveOption | null | undefined;
  /** Paso siguiente cuando la opción elegida no dice otro. */
  next?: string | null;
  placeholder?: string;
  /** `text`: permitir imágenes. */
  images?: boolean;
  /** `signal`: texto del botón. */
  action?: string;
}

export interface ProgressiveFormConfig { start: string; steps: ProgressiveStep[] }

export interface ProgressiveResult { answers: ProgressiveAnswers; message: string; images: FeedbackImage[] }

export interface ProgressiveFormOptions {
  config: ProgressiveFormConfig;
  /** Respuestas que ya da el contexto (no se preguntan; se pueden cambiar). */
  known?: ProgressiveAnswers;
  onSubmit: (result: ProgressiveResult) => Promise<'sent' | 'pending'>;
  /** Paso `signal`: la app deja señalar un elemento (p. ej. cerrando la hoja y activando el gesto). */
  onSignal?: (answers: ProgressiveAnswers) => void;
  onChange?: (answers: ProgressiveAnswers) => void;
}

export interface ProgressiveForm {
  element: HTMLElement;
  answers(): ProgressiveAnswers;
  set(stepId: string, value: string): void;
}

let uid = 0;

export function createFeedbackProgressiveForm(options: ProgressiveFormOptions): ProgressiveForm {
  const steps = new Map(options.config.steps.map((s) => [s.id, s]));
  let answers: ProgressiveAnswers = { ...(options.known ?? {}) };
  const known = new Set(Object.keys(options.known ?? {}));
  const declined = new Set<string>();
  const message = el('textarea', { class: 'fb-message', rows: '4', maxlength: String(FEEDBACK_MAX_MESSAGE), 'aria-label': 'Comentario' }) as HTMLTextAreaElement;
  let images: FeedbackImage[] = [];
  const element = el('div', { class: 'fb-progressive' });

  const optionsOf = (step: ProgressiveStep) => (typeof step.options === 'function' ? step.options(answers) : step.options ?? []);
  const nextOf = (step: ProgressiveStep): string | null => {
    const chosen = optionsOf(step).find((o) => o.value === answers[step.id]);
    return chosen?.next !== undefined ? chosen.next : step.next ?? null;
  };
  /** Pasos por los que pasa el camino con las respuestas de ahora; el último es el que falta por contestar. */
  function chain(): ProgressiveStep[] {
    const out: ProgressiveStep[] = [];
    const seen = new Set<string>();
    for (let id: string | null = options.config.start; id && !seen.has(id); ) {
      seen.add(id);
      const step = steps.get(id);
      if (!step) break;
      out.push(step);
      if (step.kind !== 'choice' || !(step.id in answers)) break;
      id = nextOf(step);
    }
    return out;
  }
  /** Al cambiar una respuesta se olvidan las de los pasos que ya no están en el camino o van después. */
  function set(stepId: string, value: string): void {
    const path = chain().map((s) => s.id);
    const at = path.indexOf(stepId);
    for (const id of path.slice(at + 1)) { delete answers[id]; known.delete(id); declined.delete(id); }
    answers[stepId] = value;
    for (const id of Object.keys(answers)) if (!chain().some((s) => s.id === id)) delete answers[id];
    options.onChange?.({ ...answers });
    paint(stepId);
  }
  function reset(stepId: string): void {
    const path = chain().map((s) => s.id);
    for (const id of path.slice(path.indexOf(stepId))) { delete answers[id]; known.delete(id); }
    declined.add(stepId);
    options.onChange?.({ ...answers });
    paint(stepId);
  }

  const imagesRow = el('div', { class: 'fb-images' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true }) as HTMLInputElement;
  function paintImages(): void {
    replace(imagesRow,
      ...images.map((img) => {
        const url = URL.createObjectURL(img.blob);
        return el('figure', { class: 'fb-thumb' }, el('img', { src: url, alt: 'Imagen adjunta', onload: () => URL.revokeObjectURL(url) }),
          el('button', { type: 'button', class: 'fb-remove', 'aria-label': 'Quitar imagen', onclick: () => { images = images.filter((x) => x.id !== img.id); paintImages(); } }, '×'));
      }),
      images.length < FEEDBACK_MAX_ATTACHMENTS ? el('button', { type: 'button', class: 'ghost small fb-add-image', onclick: () => fileInput.click() }, icon('camera', 16), 'Imagen (opcional)') : null);
  }
  fileInput.addEventListener('change', async () => {
    for (const file of Array.from(fileInput.files ?? []).slice(0, FEEDBACK_MAX_ATTACHMENTS - images.length)) {
      try { const c = await compressImage(file, { thumbSide: 0 }); images = [...images, { id: `pimg-${Date.now()}-${uid++}`, blob: c.full, mime: c.mime, filename: c.filename }]; } catch { /* imagen ilegible: se ignora */ }
    }
    fileInput.value = '';
    paintImages();
  });

  function paint(focusAfter?: string): void {
    const path = chain();
    const blocks = path.map((step) => {
      const answered = answers[step.id];
      const opts = optionsOf(step);
      const block = el('section', { class: 'fb-step', dataset: { step: step.id } });
      if (step.kind === 'choice' && answered !== undefined) {
        const label = opts.find((o) => o.value === answered)?.label ?? answered;
        replace(block,
          el('p', { class: 'fb-step-q' }, step.question),
          el('div', { class: 'fb-step-answer' }, el('strong', null, label),
            el('button', { type: 'button', class: 'linkbtn fb-change', 'aria-label': `Cambiar: ${step.question}`, onclick: () => reset(step.id) }, 'Cambiar')));
        if (known.has(step.id)) block.classList.add('known');
        return block;
      }
      if (step.kind === 'choice') {
        const guess = !declined.has(step.id) ? step.suggest?.(answers) : null;
        if (guess) {
          replace(block,
            el('p', { class: 'fb-step-q' }, `¿Es sobre ${guess.label}?`),
            el('div', { class: 'fb-choices' },
              el('button', { type: 'button', class: 'fb-choice', dataset: { value: guess.value }, onclick: () => set(step.id, guess.value) }, 'Sí'),
              el('button', { type: 'button', class: 'fb-choice', dataset: { value: '' }, onclick: () => { declined.add(step.id); paint(step.id); } }, 'Otro sitio')));
          return block;
        }
        replace(block, el('p', { class: 'fb-step-q' }, step.question),
          el('div', { class: 'fb-choices', role: 'group', 'aria-label': step.question }, ...opts.map((o) => el('button', {
            type: 'button', class: 'fb-choice', dataset: { value: o.value }, onclick: () => set(step.id, o.value),
          }, el('span', null, o.label), o.hint ? el('small', null, o.hint) : null))));
        return block;
      }
      if (step.kind === 'signal') {
        replace(block, el('p', { class: 'fb-step-q' }, step.question),
          el('button', { type: 'button', class: 'primary fb-signal', onclick: () => options.onSignal?.({ ...answers }) }, icon('pin', 16), step.action ?? 'Señalar en la pantalla'));
        return block;
      }
      // text: último paso.
      message.placeholder = step.placeholder ?? '';
      const status = el('p', { class: 'fb-status', role: 'status', 'aria-live': 'polite' });
      const send = el('button', { type: 'button', class: 'primary fb-send' }, 'Enviar');
      send.addEventListener('click', async () => {
        if (!message.value.trim()) { status.textContent = 'Escribe un comentario antes de enviar.'; status.className = 'fb-status error'; message.focus(); return; }
        send.disabled = true; status.className = 'fb-status'; status.textContent = 'Enviando…';
        try {
          const result = await options.onSubmit({ answers: { ...answers }, message: message.value.trim(), images });
          status.textContent = result === 'sent' ? 'Enviado. Gracias.' : 'Pendiente de enviar: se enviará al volver la conexión.';
          element.dataset.state = result;
        } catch (error) {
          send.disabled = false; status.className = 'fb-status error'; status.textContent = (error as Error)?.message || 'No se pudo enviar.';
        }
      });
      replace(block, el('p', { class: 'fb-step-q' }, step.question), message,
        step.images ? imagesRow : null, step.images ? fileInput : null, status, el('div', { class: 'fb-foot' }, send));
      if (step.images) paintImages();
      return block;
    });
    replace(element, ...blocks);
    if (focusAfter) {
      const after = element.querySelector<HTMLElement>(`[data-step="${CSS.escape(focusAfter)}"] ~ .fb-step .fb-choice, [data-step="${CSS.escape(focusAfter)}"] ~ .fb-step textarea, [data-step="${CSS.escape(focusAfter)}"] .fb-choice`);
      after?.focus({ preventScroll: false });
    }
  }

  paint();
  return { element, answers: () => ({ ...answers }), set };
}
