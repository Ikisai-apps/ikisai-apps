/**
 * Recuadro de firma (portales Organizers y Guests; Booking puede pasar el suyo a este): se firma con el dedo, el lápiz o
 * el ratón; «Deshacer» quita el último trazo y «Borrar» todo. `toBlob()` da un PNG **recortado** a la firma (con margen)
 * y fondo transparente.
 * Accesible: el lienzo tiene nombre y estado («Firma vacía» / «Firmado»), los botones van con teclado, y quien no pueda
 * trazar puede **escribir su nombre** («Escribir mi nombre»), que se dibuja en el recuadro como firma.
 * Ignora el gesto de feedback (`data-feedback-ignore`) y no desplaza la página al firmar (`touch-action: none`).
 */
import { el, replace } from '../dom.ts';
import { kt } from '../i18n/i18n.ts';
import { icon } from '../icons.ts';

export interface SignaturePadOptions {
  /** Etiqueta visible; por defecto «Firma». */
  label?: string;
  /** Alto del recuadro en píxeles CSS; por defecto 180. El ancho es el del contenedor. */
  height?: number;
  /** Color del trazo; por defecto el de la tinta del tema. */
  color?: string;
  /** Permite «Escribir mi nombre» como alternativa (por defecto sí). */
  typed?: boolean;
  onChange?: (empty: boolean) => void;
  /** Atributos extra del contenedor (ganchos de la app, `data-feedback-id`). */
  attrs?: Record<string, string>;
}

export interface SignaturePad {
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  isEmpty(): boolean;
  clear(): void;
  undo(): void;
  /** PNG recortado a la firma con 8 px de margen; `null` si está vacía. */
  toBlob(): Promise<Blob | null>;
}

type Point = [number, number];

export function createSignaturePad(options: SignaturePadOptions = {}): SignaturePad {
  const height = options.height ?? 180;
  const strokes: Point[][] = [];
  let typedName = '';
  let current: Point[] | null = null;
  const canvas = el('canvas', { class: 'signature-canvas', role: 'img', 'data-feedback-ignore': '' }) as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const status = el('span', { class: 'signature-status vh', 'aria-live': 'polite' });
  const undoButton = el('button', { type: 'button', class: 'ghost small signature-undo' }, icon('undo', 16), kt('Deshacer')) as HTMLButtonElement;
  const clearButton = el('button', { type: 'button', class: 'ghost small signature-clear' }, icon('trash', 16), kt('Borrar')) as HTMLButtonElement;
  const typedInput = el('input', { type: 'text', class: 'signature-typed', autocomplete: 'name', 'aria-label': kt('Escribe tu nombre como firma'), hidden: true, maxlength: '60' }) as HTMLInputElement;
  const typedToggle = options.typed === false ? null : el('button', { type: 'button', class: 'linkbtn signature-type-toggle' }, kt('Escribir mi nombre')) as HTMLButtonElement;
  const label = el('span', { class: 'signature-label' }, options.label ?? kt('Firma'));
  const element = el('div', { class: 'signature-pad', ...(options.attrs ?? {}) },
    label,
    el('div', { class: 'signature-box', style: `height:${height}px` }, canvas, el('span', { class: 'signature-line', 'aria-hidden': 'true' })),
    typedInput,
    el('div', { class: 'signature-actions' }, typedToggle, el('span', { class: 'spacer' }), undoButton, clearButton),
    status);

  const ink = () => options.color ?? (getComputedStyle(element).getPropertyValue('--ink').trim() || '#1d2a1c');
  const isEmpty = () => !strokes.length && !typedName.trim();

  /** Ajusta el lienzo a su tamaño en pantalla y a la densidad de píxeles, y redibuja. */
  function fit(): void {
    const box = canvas.getBoundingClientRect();
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(box.width * ratio));
    const h = Math.max(1, Math.round(box.height * ratio));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    redraw();
  }
  function redraw(): void {
    const ratio = canvas.width / Math.max(1, canvas.getBoundingClientRect().width || canvas.width);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.strokeStyle = ctx.fillStyle = ink();
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const stroke of strokes) drawStroke(stroke);
    if (typedName.trim()) {
      const cssW = canvas.width / ratio;
      const cssH = canvas.height / ratio;
      let size = Math.min(48, cssH * 0.45);
      ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
      while (ctx.measureText(typedName).width > cssW - 24 && size > 14) { size -= 2; ctx.font = `italic ${size}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`; }
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(typedName, 12, cssH * 0.62);
    }
  }
  function drawStroke(points: Point[]): void {
    if (!points.length) return;
    ctx.beginPath();
    ctx.moveTo(points[0]![0], points[0]![1]);
    if (points.length === 1) { ctx.arc(points[0]![0], points[0]![1], 1.3, 0, Math.PI * 2); ctx.fill(); return; }
    // Curvas por los puntos medios: trazo suave sin picos.
    for (let i = 1; i < points.length - 1; i++) {
      const [x, y] = points[i]!;
      const [nx, ny] = points[i + 1]!;
      ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
    }
    const last = points[points.length - 1]!;
    ctx.lineTo(last[0], last[1]);
    ctx.stroke();
  }
  function changed(): void {
    const empty = isEmpty();
    undoButton.disabled = !strokes.length && !typedName;
    clearButton.disabled = empty;
    canvas.setAttribute('aria-label', `${options.label ?? kt('Firma')}: ${empty ? kt('vacía') : kt('firmado')}`);
    status.textContent = empty ? '' : kt('Firmado');
    element.dataset.empty = String(empty);
    options.onChange?.(empty);
  }

  const point = (e: PointerEvent): Point => {
    const box = canvas.getBoundingClientRect();
    return [e.clientX - box.left, e.clientY - box.top];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    if (typedName) { typedName = ''; typedInput.value = ''; }
    current = [point(e)];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    for (const ev of e.getCoalescedEvents?.() ?? [e]) current.push(point(ev));
    redraw();
  });
  const end = () => { if (!current) return; current = null; changed(); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);

  function clear(): void { strokes.length = 0; typedName = ''; typedInput.value = ''; redraw(); changed(); }
  function undo(): void { if (typedName && !strokes.length) { typedName = ''; typedInput.value = ''; } else strokes.pop(); redraw(); changed(); }
  undoButton.addEventListener('click', undo);
  clearButton.addEventListener('click', clear);
  typedToggle?.addEventListener('click', () => {
    typedInput.hidden = !typedInput.hidden;
    replace(typedToggle, typedInput.hidden ? kt('Escribir mi nombre') : kt('Firmar a mano'));
    if (!typedInput.hidden) { strokes.length = 0; typedInput.focus(); } else { typedName = ''; typedInput.value = ''; }
    redraw(); changed();
  });
  typedInput.addEventListener('input', () => { typedName = typedInput.value; strokes.length = 0; redraw(); changed(); });

  async function toBlob(): Promise<Blob | null> {
    if (isEmpty()) return null;
    fit();
    const { data, width, height: h } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let minX = width, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
    if (maxX < 0) return null;
    const pad = 8 * (canvas.width / Math.max(1, canvas.getBoundingClientRect().width || canvas.width));
    const sx = Math.max(0, Math.floor(minX - pad)); const sy = Math.max(0, Math.floor(minY - pad));
    const sw = Math.min(width, Math.ceil(maxX + pad)) - sx; const sh = Math.min(h, Math.ceil(maxY + pad)) - sy;
    const out = document.createElement('canvas');
    out.width = sw; out.height = sh;
    out.getContext('2d')!.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'));
  }

  // Tamaño real al entrar en el DOM y al cambiar (giro del móvil): se redibuja con los trazos guardados en CSS px.
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(canvas);
  requestAnimationFrame(fit);
  changed();
  return { element, canvas, isEmpty, clear, undo, toBlob };
}
