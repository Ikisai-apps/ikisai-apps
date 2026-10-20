/**
 * Firma del registro de entrada (API.md §9.6): solo en modo `ses` y con los datos completos (decisión del usuario del
 * 7-10-2026). Resumen de lo que se firma, declaración de Central, quién firma (desde 14 años el propio huésped; por debajo,
 * quien le acompaña, `signsOwnEntry`) y un recuadro para firmar con el dedo. Sin red, la firma espera en el dispositivo y
 * se envía sola; no se da por hecha hasta que Booking responde.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { signsOwnEntry } from '@ikisai/domain-booking';
import { commonText, textVersion } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { dateRange, missingText } from '../app/labels.ts';
import { backLink, centralText, staleNote } from './common.ts';
import { requestChange, reviewList } from './data.ts';

/** Recuadro de firma: trazos con puntero (dedo, ratón o lápiz) y exportación PNG recortada a la firma (API.md §8). */
export interface SignaturePad { element: HTMLElement; isEmpty(): boolean; clear(): void; toBlob(): Promise<Blob | null> }

export function createSignaturePad(label: string): SignaturePad {
  const canvas = el('canvas', { id: 'signaturePad', class: 'gpad', 'aria-label': label, role: 'img', 'data-feedback-ignore': '' }) as HTMLCanvasElement;
  const strokes: Array<Array<[number, number]>> = [];
  let drawing: Array<[number, number]> | null = null;
  const ratio = () => Math.max(1, Math.min(3, window.devicePixelRatio || 1));

  function size(): void {
    const box = canvas.getBoundingClientRect();
    canvas.width = Math.round((box.width || 320) * ratio());
    canvas.height = Math.round((box.height || 180) * ratio());
    redraw();
  }
  function context(): CanvasRenderingContext2D {
    const g = canvas.getContext('2d')!;
    g.lineWidth = 2.4 * ratio(); g.lineCap = 'round'; g.lineJoin = 'round';
    g.strokeStyle = getComputedStyle(canvas).color || '#1d2433';
    return g;
  }
  function redraw(): void {
    const g = context();
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of strokes) {
      g.beginPath();
      stroke.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      if (stroke.length === 1) g.lineTo(stroke[0]![0] + 0.1, stroke[0]![1]);
      g.stroke();
    }
  }
  const point = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return [(event.clientX - box.left) * ratio(), (event.clientY - box.top) * ratio()];
  };
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing = [point(event)];
    strokes.push(drawing);
    redraw();
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!drawing) return;
    drawing.push(point(event));
    redraw();
  });
  const end = () => { drawing = null; canvas.dispatchEvent(new Event('change')); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  requestAnimationFrame(size);

  return {
    element: canvas,
    isEmpty: () => strokes.every((s) => s.length < 2),
    clear() { strokes.length = 0; redraw(); canvas.dispatchEvent(new Event('change')); },
    toBlob() {
      const points = strokes.flat();
      if (!points.length) return Promise.resolve(null);
      const pad = 8 * ratio();
      const xs = points.map((p) => p[0]); const ys = points.map((p) => p[1]);
      const x = Math.max(0, Math.min(...xs) - pad); const y = Math.max(0, Math.min(...ys) - pad);
      const w = Math.min(canvas.width, Math.max(...xs) + pad) - x; const h = Math.min(canvas.height, Math.max(...ys) + pad) - y;
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(w)); out.height = Math.max(1, Math.round(h));
      const g = out.getContext('2d')!;
      g.drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
      return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
    },
  };
}

export function mountSign(main: HTMLElement, ctx: GuestContext, base: string): () => void {
  let sending = false;

  function paint(): void {
    const g = ctx.guest();
    const r = g.reservation;
    const stale = ctx.staleAt() ? staleNote(ctx.staleAt()!) : null;
    const head = el('div', { class: 'pagehead' }, el('h2', null, t('fill.check')), el('p', { class: 'muted' }, g.mode === 'ses' ? t('fill.checkIntro') : t('sign.intro')));
    // «Cambiar» abre esa pregunta en Tus datos y vuelve aquí.
    const review = () => reviewList(ctx, (key) => { requestChange(key, `${base}/firma`); location.hash = `${base}/datos`; });
    if (g.mode !== 'ses') {
      replace(main, backLink(base), stale, head, review(), el('p', { id: 'signNotNeeded' }, t('sign.notNeeded')));
      return;
    }
    if (g.signed) {
      replace(main, backLink(base), stale, head, review(), el('section', { class: 'card gcard gdone', id: 'signDone', 'data-feedback-id': 'guests.firma.hecha', 'data-feedback-label': 'Firma hecha' },
        icon('check', 22), el('p', null, t('sign.done'))),
        el('a', { class: 'primary wide', href: base, id: 'nextTask', 'data-feedback-id': 'guests.firma.volver', 'data-feedback-label': 'Volver a tu retiro' }, t('fill.backRetreat'), icon('chevronRight', 16)));
      return;
    }
    if (sending || ctx.writer.busy() && ctx.writer.state() === 'offline') {
      replace(main, backLink(base), stale, head, el('p', { class: 'banner', id: 'signPending', role: 'status' }, icon('sync', 18), ' ',
        ctx.writer.state() === 'offline' ? t('sign.pendingOffline') : t('sign.sending')));
      return;
    }
    if (g.missing.length) {
      replace(main, backLink(base), stale, head, el('section', { class: 'card gcard', id: 'signNeedsData' },
        el('p', null, t('sign.needsData', { list: missingText(g.missing) })),
        el('a', { class: 'primary', href: `${base}/datos`, 'data-feedback-id': 'guests.firma.datos.abrir', 'data-feedback-label': 'Completar mis datos' }, t('sign.completeData'))));
      return;
    }

    const f = g.fields;
    const own = r.start_date ? signsOwnEntry({ birth_date: f.birth_date as string | null, is_minor: f.is_minor === true }, r.start_date) : f.is_minor !== true;
    const fullName = [f.first_name, f.last_name_1, f.last_name_2].filter(Boolean).join(' ');
    const signer = el('input', { id: 'signerName', type: 'text', maxlength: '200', autocomplete: 'name', 'data-feedback-ignore': '',
      value: own ? fullName : String(f.guardian_name ?? '') }) as HTMLInputElement;
    const pad = createSignaturePad(t('sign.pad'));
    const error = el('p', { class: 'ghint', id: 'signError', role: 'alert' });
    const submit = el('button', { type: 'button', class: 'primary wide', id: 'signSubmit', 'data-feedback-id': 'guests.firma.recuadro.firmar', 'data-feedback-label': 'Firmar',
      onclick: async () => {
        if (!signer.value.trim()) { error.textContent = t('sign.nameRequired'); signer.focus(); return; }
        if (pad.isEmpty()) { error.textContent = t('sign.padRequired'); return; }
        const image = await pad.toBlob();
        if (!image) return;
        sending = true;
        ctx.writer.enqueue({ kind: 'sign', image, name: signer.value.trim(), textVersion: textVersion('guests.signature_statement') });
        paint();
      } }, t('sign.submit'));
    const statement = commonText('guests.signature_statement');
    replace(main, backLink(base), stale, head,
      ctx.signatureReset() ? el('p', { class: 'banner warn', id: 'signatureReset' }, icon('warn', 18), ' ', t('data.signatureReset')) : null,
      // «Comprueba tus respuestas» (MUELA-018): todo lo que se firma, con «Cambiar» en cada dato.
      el('section', { id: 'signSummary', 'data-feedback-id': 'guests.firma.resumen', 'data-feedback-label': 'Lo que firmas' },
        el('p', { class: 'small' }, `${t('sign.stay')}: ${dateRange(r.start_date, r.end_date)}`), review()),
      statement ? centralText(statement.body, statement.spanishOnly, { id: 'signStatement', class: 'gtext card gcard' }) : null,
      el('section', { class: 'card gcard', 'data-feedback-id': 'guests.firma.recuadro', 'data-feedback-label': 'Recuadro de firma' },
        el('p', { id: 'signWho' }, own ? t('sign.own') : t('sign.companion', { name: String(f.first_name ?? '') })),
        el('div', { class: 'gfield' }, el('label', { for: 'signerName' }, own ? t('sign.signerOwn') : t('sign.signerCompanion')), signer),
        el('p', { class: 'muted small' }, t('sign.padHelp')),
        pad.element,
        el('div', { class: 'btnrow' },
          el('button', { type: 'button', class: 'ghost', id: 'signClear', 'data-feedback-id': 'guests.firma.recuadro.borrar', 'data-feedback-label': 'Borrar firma', onclick: () => { pad.clear(); error.textContent = ''; } }, t('sign.clear')),
          submit),
        error));
  }

  /** Fase de la pantalla: solo se repinta si cambia, para no borrar una firma a medio dibujar. */
  function phase(): string {
    const g = ctx.guest();
    if (g.mode !== 'ses') return 'off';
    if (g.signed) return 'done';
    if (sending || (ctx.writer.busy() && ctx.writer.state() === 'offline')) return `sending:${ctx.writer.state() === 'offline'}`;
    // Con los datos que se firman: si cambian (p. ej. al volver de «Cambiar»), la revisión y el nombre se repintan.
    return g.missing.length ? `data:${g.missing.join()}` : `pad:${ctx.signatureReset()}:${JSON.stringify(g.fields)}`;
  }

  let shown = '';
  const repaint = () => { shown = phase(); paint(); };
  repaint();
  const off = ctx.onChange((reason) => {
    if (reason === 'rejected' && ctx.lastRejected()?.op.kind === 'sign') {
      sending = false;
      repaint();
      const error = main.querySelector('#signError');
      if (error) error.textContent = t('sign.failed');
      return;
    }
    if (sending && !ctx.writer.busy()) sending = false;
    if (phase() !== shown) repaint();
  });
  return off;
}
