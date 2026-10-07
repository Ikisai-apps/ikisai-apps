/**
 * Formulario progresivo de los portales («Ayuda y sugerencias», especificación §3.2, §4 y §5): una pregunta cada vez,
 * la hoja crece al contestar (nada de «Paso 1 de 7»). Lo define la app con un catálogo de pasos, sin código de UI:
 * - `choice`: opciones; cada una puede llevar a otro paso (`next`), así se ramifica (Aplicación / Retiro / Espacio).
 * - `text`: comentario (y hasta 3 imágenes con `images: true`); es el último paso y lleva «Enviar».
 * - `signal`: «Mantén pulsado sobre el lugar de la aplicación…»: el botón arma el gesto **solo para este reporte**
 *   (`captureFeedbackTarget`, sin el interruptor «Señalar para comentar», que los portales no tienen); lo señalado
 *   queda como respuesta y va en `result.node`. Una app puede dar su propio `onSignal`.
 * Cambiar una respuesta anterior borra las de después. Lo que ya se sabe por el contexto (`known`) no se pregunta, y
 * `suggest` ofrece primero la opción probable («¿Es sobre Habitación 3?» · Sí · Otro sitio).
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { compressImage } from '../media/compress-image.ts';
import { FEEDBACK_MAX_ATTACHMENTS, FEEDBACK_MAX_MESSAGE } from './constants.ts';
import { captureFeedbackTarget } from './capture.ts';
import type { FeedbackNode } from './node.ts';
import type { FeedbackImage } from './store.ts';
import { kitLocaleNow, kt, onKitLocaleChange, type Locale } from '../i18n/i18n.ts';

export type ProgressiveAnswers = Record<string, string>;

/** Texto de un paso u opción: literal o por idioma (`{ es: 'Espacio', en: 'Space' }`), según el idioma del kit. */
export type LocalizedText = string | Partial<Record<Locale, string>>;

/** Texto en el idioma actual del kit (o español, o el primero que haya). */
export function localized(text: LocalizedText | undefined): string {
  if (text === undefined) return '';
  if (typeof text === 'string') return text;
  return text[kitLocaleNow()] ?? text.es ?? Object.values(text).find(Boolean) ?? '';
}

export interface ProgressiveOption { value: string; label: LocalizedText; hint?: LocalizedText; next?: string | null }

export interface ProgressiveStep {
  id: string;
  kind: 'choice' | 'text' | 'signal';
  question: LocalizedText;
  options?: ProgressiveOption[] | ((answers: ProgressiveAnswers) => ProgressiveOption[]);
  /** Opción probable por el contexto: se pregunta «¿Es sobre …?» antes de enseñar todas. */
  suggest?: (answers: ProgressiveAnswers) => ProgressiveOption | null | undefined;
  /** Paso siguiente cuando la opción elegida no dice otro. */
  next?: string | null;
  placeholder?: LocalizedText;
  /** `text`: permitir imágenes. */
  images?: boolean;
  /** `signal`: texto del botón. */
  action?: LocalizedText;
}

export interface ProgressiveFormConfig { start: string; steps: ProgressiveStep[] }

export interface ProgressiveResult {
  answers: ProgressiveAnswers; message: string; images: FeedbackImage[];
  /** Elemento señalado en un paso `signal` (id y ruta de etiquetas). */
  node?: { id: string; path: string[] };
}

export interface ProgressiveFormOptions {
  config: ProgressiveFormConfig;
  /** Respuestas que ya da el contexto (no se preguntan; se pueden cambiar). */
  known?: ProgressiveAnswers;
  onSubmit: (result: ProgressiveResult) => Promise<'sent' | 'pending'>;
  /**
   * Paso `signal` a medida: la app deja señalar y devuelve el nodo (o `null`). Por defecto, `captureFeedbackTarget`
   * arma el gesto una sola vez. Si devuelve `void`, el paso queda sin responder (comportamiento anterior).
   */
  onSignal?: (answers: ProgressiveAnswers) => void | Promise<FeedbackNode | { id: string; path: string[] } | null | void>;
  /** Nodo de reserva para lo señalado sin `data-feedback-id`, y capa donde va la barra de señalar. */
  fallbackNode?: () => { id: string; path: string[] };
  container?: () => HTMLElement;
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
  const message = el('textarea', { class: 'fb-message', rows: '4', maxlength: String(FEEDBACK_MAX_MESSAGE), 'aria-label': kt('Comentario') }) as HTMLTextAreaElement;
  let images: FeedbackImage[] = [];
  const element = el('div', { class: 'fb-progressive' });
  /** Nodos señalados por paso `signal`. */
  const signalled = new Map<string, { id: string; path: string[] }>();

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
      if ((step.kind !== 'choice' && step.kind !== 'signal') || !(step.id in answers)) break;
      id = nextOf(step);
    }
    return out;
  }
  /** Al cambiar una respuesta se olvidan las de los pasos que ya no están en el camino o van después. */
  function set(stepId: string, value: string): void {
    const path = chain().map((s) => s.id);
    const at = path.indexOf(stepId);
    for (const id of path.slice(at + 1)) { delete answers[id]; known.delete(id); declined.delete(id); signalled.delete(id); }
    answers[stepId] = value;
    for (const id of Object.keys(answers)) if (!chain().some((s) => s.id === id)) delete answers[id];
    options.onChange?.({ ...answers });
    paint(stepId);
  }
  function reset(stepId: string): void {
    const path = chain().map((s) => s.id);
    for (const id of path.slice(path.indexOf(stepId))) { delete answers[id]; known.delete(id); signalled.delete(id); }
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
        return el('figure', { class: 'fb-thumb' }, el('img', { src: url, alt: kt('Imagen adjunta'), onload: () => URL.revokeObjectURL(url) }),
          el('button', { type: 'button', class: 'fb-remove', 'aria-label': kt('Quitar imagen'), onclick: () => { images = images.filter((x) => x.id !== img.id); paintImages(); } }, '×'));
      }),
      images.length < FEEDBACK_MAX_ATTACHMENTS ? el('button', { type: 'button', class: 'ghost small fb-add-image', onclick: () => fileInput.click() }, icon('camera', 16), kt('Imagen (opcional)')) : null);
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
        const found = opts.find((o) => o.value === answered);
        const label = found ? localized(found.label) : answered;
        replace(block,
          el('p', { class: 'fb-step-q' }, localized(step.question)),
          el('div', { class: 'fb-step-answer' }, el('strong', null, label),
            el('button', { type: 'button', class: 'linkbtn fb-change', 'aria-label': kt('Cambiar: {question}', { question: localized(step.question) }), onclick: () => reset(step.id) }, kt('Cambiar'))));
        if (known.has(step.id)) block.classList.add('known');
        return block;
      }
      if (step.kind === 'choice') {
        const guess = !declined.has(step.id) ? step.suggest?.(answers) : null;
        if (guess) {
          replace(block,
            el('p', { class: 'fb-step-q' }, kt('¿Es sobre {label}?', { label: localized(guess.label) })),
            el('div', { class: 'fb-choices' },
              el('button', { type: 'button', class: 'fb-choice', dataset: { value: guess.value }, onclick: () => set(step.id, guess.value) }, kt('Sí')),
              el('button', { type: 'button', class: 'fb-choice', dataset: { value: '' }, onclick: () => { declined.add(step.id); paint(step.id); } }, kt('Otro sitio'))));
          return block;
        }
        replace(block, el('p', { class: 'fb-step-q' }, localized(step.question)),
          el('div', { class: 'fb-choices', role: 'group', 'aria-label': localized(step.question) }, ...opts.map((o) => el('button', {
            type: 'button', class: 'fb-choice', dataset: { value: o.value }, onclick: () => set(step.id, o.value),
          }, el('span', null, localized(o.label)), o.hint ? el('small', null, localized(o.hint)) : null))));
        return block;
      }
      if (step.kind === 'signal' && answered !== undefined) {
        const node = signalled.get(step.id);
        replace(block,
          el('p', { class: 'fb-step-q' }, localized(step.question)),
          el('div', { class: 'fb-step-answer' }, el('strong', null, node?.path.join(' › ') || answered),
            el('button', { type: 'button', class: 'linkbtn fb-change', 'aria-label': kt('Cambiar: {question}', { question: localized(step.question) }), onclick: () => reset(step.id) }, kt('Cambiar'))));
        return block;
      }
      if (step.kind === 'signal') {
        const button = el('button', { type: 'button', class: 'primary fb-signal' }, icon('pin', 16), (step.action ? localized(step.action) : kt('Señalar en la pantalla'))) as HTMLButtonElement;
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            const node = options.onSignal
              ? await options.onSignal({ ...answers })
              : await captureFeedbackTarget({ text: localized(step.question), fallbackNode: options.fallbackNode, container: options.container });
            if (node && typeof node === 'object' && 'id' in node) {
              signalled.set(step.id, { id: node.id, path: node.path });
              set(step.id, node.id);
            }
          } finally { button.disabled = false; }
        });
        replace(block, el('p', { class: 'fb-step-q' }, localized(step.question)), button);
        return block;
      }
      // text: último paso.
      message.placeholder = localized(step.placeholder);
      const status = el('p', { class: 'fb-status', role: 'status', 'aria-live': 'polite' });
      const send = el('button', { type: 'button', class: 'primary fb-send' }, kt('Enviar'));
      send.addEventListener('click', async () => {
        if (!message.value.trim()) { status.textContent = kt('Escribe un comentario antes de enviar.'); status.className = 'fb-status error'; message.focus(); return; }
        send.disabled = true; status.className = 'fb-status'; status.textContent = kt('Enviando…');
        try {
          const node = [...chain()].reverse().map((s) => signalled.get(s.id)).find(Boolean);
          const result = await options.onSubmit({ answers: { ...answers }, message: message.value.trim(), images, ...(node ? { node } : {}) });
          status.textContent = result === 'sent' ? kt('Enviado. Gracias.') : kt('Pendiente de enviar: se enviará al volver la conexión.');
          element.dataset.state = result;
        } catch (error) {
          send.disabled = false; status.className = 'fb-status error'; status.textContent = (error as Error)?.message || kt('No se pudo enviar.');
        }
      });
      replace(block, el('p', { class: 'fb-step-q' }, localized(step.question)), message,
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
  // Con idiomas (portales), al cambiar de idioma se repinta con los textos nuevos.
  onKitLocaleChange(() => paint());
  return { element, answers: () => ({ ...answers }), set };
}
