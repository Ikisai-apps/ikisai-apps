/**
 * Composer del feedback (especificación §2.3–§2.6, §3.1, §8, §19.2): capa propia por encima de cualquier hoja (no la
 * cierra): popover anclado al elemento en escritorio cuando cabe, hoja inferior en móvil. Comentario, tipo e imágenes
 * (como mucho 3, comprimidas). Al salir: vacío → se descarta; con contenido → borrador local (pin). «Ya hay N reportes
 * abiertos aquí» con «También me pasa».
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { compressImage } from '../media/compress-image.ts';
import { trapFocus } from '../overlay/focus.ts';
import { FEEDBACK_INTENT_LABELS, FEEDBACK_MAX_ATTACHMENTS, FEEDBACK_MAX_MESSAGE, type FeedbackIntent } from './constants.ts';
import type { FeedbackReport } from './client.ts';
import type { FeedbackNode } from './node.ts';
import type { FeedbackImage } from './store.ts';
import { kt } from '../i18n/i18n.ts';

export type ComposerState = 'empty' | 'draft' | 'sending' | 'pending' | 'sent' | 'error';

export interface ComposerValue { message: string; intent: FeedbackIntent; images: FeedbackImage[]; blocking: boolean }

export interface FeedbackComposerOptions {
  node: FeedbackNode;
  /** Elemento al que anclar el popover en escritorio. */
  anchor?: Element | null;
  initial?: Partial<ComposerValue>;
  intents?: FeedbackIntent[];
  /** Reportes abiertos en este nodo (se piden aparte; puede llegar tarde). */
  openReports?: Promise<FeedbackReport[]>;
  onSupport?: (report: FeedbackReport) => Promise<number>;
  /** «Enviar»: resuelve con el estado final (`sent` o `pending`) o lanza para `error`. */
  onSend: (value: ComposerValue) => Promise<'sent' | 'pending'>;
  /** Al cerrar sin enviar: `null` si estaba vacío (se descarta), o el valor para guardarlo como borrador. */
  onClose: (value: ComposerValue | null) => void;
  /** Acción secundaria «No es sobre la aplicación» (opcional). */
  onReclassify?: () => void;
  /** Dónde montar la capa; por defecto `document.body`. */
  container?: HTMLElement;
}

export interface FeedbackComposer {
  element: HTMLElement;
  close(): void;
  setState(state: ComposerState, text?: string): void;
}

let uid = 0;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `img-${Date.now()}-${uid++}`);

export function openFeedbackComposer(options: FeedbackComposerOptions): FeedbackComposer {
  const intents = options.intents ?? ['bug', 'improvement', 'idea'];
  let intent: FeedbackIntent = options.initial?.intent ?? intents[0]!;
  let images: FeedbackImage[] = (options.initial?.images ?? []).slice();
  let closed = false;
  const opener = document.activeElement as HTMLElement | null;

  const message = el('textarea', { class: 'fb-message', rows: '4', maxlength: String(FEEDBACK_MAX_MESSAGE), placeholder: kt('¿Qué pasa o qué propones?'), 'aria-label': kt('Comentario') }) as HTMLTextAreaElement;
  message.value = options.initial?.message ?? '';
  const counter = el('small', { class: 'fb-counter', 'aria-live': 'polite' });
  const intentsRow = el('div', { class: 'segmented fb-intents', role: 'radiogroup', 'aria-label': kt('Tipo') });
  const imagesRow = el('div', { class: 'fb-images' });
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, class: 'fb-file' }) as HTMLInputElement;
  const blocking = el('input', { type: 'checkbox', class: 'fb-blocking-input' }) as HTMLInputElement;
  blocking.checked = !!options.initial?.blocking;
  const blockingRow = el('label', { class: 'field check fb-blocking' }, blocking, el('span', null, kt('Me bloquea: no puedo seguir trabajando')));
  const status = el('p', { class: 'fb-status', role: 'status', 'aria-live': 'polite' });
  const dupes = el('div', { class: 'fb-dupes', hidden: true });
  const send = el('button', { type: 'button', class: 'primary fb-send' }, kt('Enviar'));
  const closeButton = el('button', { type: 'button', class: 'iconbtn small fb-close', 'aria-label': kt('Cerrar comentario') }, icon('close', 18));

  function isEmpty(): boolean { return !message.value.trim() && !images.length; }
  function value(): ComposerValue { return { message: message.value.trim(), intent, images, blocking: blocking.checked }; }
  function paintCounter(): void {
    const left = FEEDBACK_MAX_MESSAGE - message.value.length;
    counter.textContent = left < 400 ? kt('Quedan {left} caracteres', { left }) : '';
  }
  function paintIntents(): void {
    replace(intentsRow, ...intents.map((i) => el('button', {
      type: 'button', role: 'radio', 'aria-checked': String(i === intent), class: i === intent ? 'on' : '', dataset: { intent: i },
      onclick: () => { intent = i; paintIntents(); },
    }, kt(FEEDBACK_INTENT_LABELS[i]))));
  }
  function paintImages(): void {
    replace(imagesRow,
      ...images.map((img) => {
        const url = URL.createObjectURL(img.blob);
        return el('figure', { class: 'fb-thumb', dataset: { image: img.id } },
          el('img', { src: url, alt: kt('Imagen adjunta'), onload: () => URL.revokeObjectURL(url) }),
          el('button', { type: 'button', class: 'fb-remove', 'aria-label': kt('Quitar imagen'), onclick: () => { images = images.filter((x) => x.id !== img.id); paintImages(); } }, '×'));
      }),
      images.length < FEEDBACK_MAX_ATTACHMENTS ? el('button', { type: 'button', class: 'ghost small fb-add-image', onclick: () => fileInput.click() }, icon('camera', 16), kt('Imagen')) : null,
    );
  }
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files ?? []).slice(0, FEEDBACK_MAX_ATTACHMENTS - images.length);
    fileInput.value = '';
    for (const file of files) {
      try {
        const c = await compressImage(file, { thumbSide: 0 });
        images = [...images, { id: newId(), blob: c.full, mime: c.mime, filename: c.filename }];
      } catch { setState('error', kt('No se pudo leer esa imagen.')); }
    }
    paintImages();
  });
  message.addEventListener('input', paintCounter);

  function setState(state: ComposerState, text?: string): void {
    panel.dataset.state = state;
    const texts: Record<ComposerState, string> = {
      empty: '', draft: '', sending: kt('Enviando…'), pending: kt('Pendiente de enviar: se enviará al volver la conexión.'),
      sent: kt('Enviado. Gracias.'), error: kt('No se pudo enviar.'),
    };
    status.textContent = text ?? texts[state];
    status.className = `fb-status${state === 'error' ? ' error' : ''}`;
    send.disabled = state === 'sending';
  }

  send.addEventListener('click', async () => {
    if (!message.value.trim()) { setState('error', kt('Escribe un comentario antes de enviar.')); message.focus(); return; }
    setState('sending');
    try {
      const result = await options.onSend(value());
      setState(result);
      setTimeout(() => finish(), result === 'sent' ? 700 : 1400);
    } catch (error) {
      setState('error', (error as Error)?.message || kt('No se pudo enviar.'));
    }
  });

  const panel = el('section', { class: 'fb-composer', role: 'dialog', 'aria-modal': 'true', 'aria-label': kt('Comentar este elemento'), tabindex: '-1' },
    el('header', { class: 'fb-head' },
      el('div', { class: 'fb-where' }, el('small', null, kt('Sobre')), el('strong', null, options.node.path.join(' › '))),
      closeButton),
    dupes,
    intentsRow,
    message, counter,
    imagesRow, fileInput,
    blockingRow,
    status,
    el('div', { class: 'fb-foot' },
      options.onReclassify ? el('button', { type: 'button', class: 'linkbtn fb-reclassify', onclick: () => { finish(); options.onReclassify?.(); } }, kt('No es sobre la aplicación')) : null,
      send),
  );
  const catcher = el('div', { class: 'fb-catcher', onclick: () => leave() });
  const layer = el('div', { class: 'ikisai-fb-layer fb-layer' }, catcher, panel);
  (options.container ?? document.body).appendChild(layer);

  /** La capa sigue a la parte visible (`visualViewport`): con el teclado de Android abierto o la página ampliada, la hoja
   *  inferior y «Enviar» quedan a la vista en vez de debajo del teclado. */
  function fitViewport(): void {
    const vv = window.visualViewport;
    if (!vv) return;
    layer.style.top = `${vv.offsetTop}px`;
    layer.style.left = `${vv.offsetLeft}px`;
    layer.style.width = `${vv.width}px`;
    layer.style.height = `${vv.height}px`;
    layer.style.right = layer.style.bottom = 'auto';
  }
  function place(): void {
    fitViewport();
    const desktop = innerWidth >= 720;
    const rect = options.anchor?.getBoundingClientRect();
    layer.classList.toggle('sheet-mode', !desktop || !rect);
    if (!desktop || !rect) { panel.style.left = panel.style.top = ''; return; }
    const w = Math.min(380, innerWidth - 24);
    const h = panel.offsetHeight || 320;
    let left = Math.min(Math.max(12, rect.left), innerWidth - w - 12);
    let top = rect.bottom + 8;
    if (top + h > innerHeight - 12) top = Math.max(12, rect.top - h - 8);
    if (top < 12) { top = 12; left = Math.min(innerWidth - w - 12, rect.right + 8); }
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }
  const onKey = (e: KeyboardEvent) => {
    if (closed) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); leave(); }
    else if (e.key === 'Tab') trapFocus(e, panel);
  };
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.visualViewport?.addEventListener('resize', place);
  window.visualViewport?.addEventListener('scroll', fitViewport);

  function finish(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('resize', place);
    window.visualViewport?.removeEventListener('scroll', fitViewport);
    layer.remove();
    if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
  }
  function leave(): void {
    if (closed) return;
    const v = isEmpty() ? null : value();
    finish();
    options.onClose(v);
  }
  closeButton.addEventListener('click', leave);

  options.openReports?.then((reports) => {
    if (closed || !reports.length) return;
    dupes.hidden = false;
    replace(dupes,
      el('p', null, el('strong', null, reports.length === 1 ? kt('Ya hay 1 reporte abierto aquí') : kt('Ya hay {count} reportes abiertos aquí', { count: reports.length }))),
      el('ul', { class: 'fb-dupe-list' }, ...reports.slice(0, 3).map((r) => el('li', null, el('span', { class: 'fb-dupe-msg' }, r.message.slice(0, 120)),
        options.onSupport ? el('button', { type: 'button', class: 'ghost small fb-support', dataset: { report: r.id }, onclick: async (e: Event) => {
          const b = e.currentTarget as HTMLButtonElement; b.disabled = true;
          try { const n = await options.onSupport!(r); b.textContent = kt('Te sumaste · {count}', { count: n }); setTimeout(() => finish(), 600); options.onClose(null); } catch { b.disabled = false; }
        } }, kt('También me pasa')) : null))),
      el('button', { type: 'button', class: 'linkbtn fb-new', onclick: () => { dupes.hidden = true; message.focus(); } }, kt('Es otra cosa: nueva sugerencia')),
    );
    place();
  }).catch(() => { /* sin duplicados */ });

  paintIntents(); paintImages(); paintCounter();
  setState(isEmpty() ? 'empty' : 'draft');
  place();
  requestAnimationFrame(() => { place(); message.focus({ preventScroll: true }); });
  return { element: panel, close: finish, setState };
}
