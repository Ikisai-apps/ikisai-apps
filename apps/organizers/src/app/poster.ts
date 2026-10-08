/**
 * Cartel del retiro (fase 5, API.md §16.3): se dibuja en el dispositivo sobre un `canvas`, sin servidor, con plantillas
 * fijas (no es un editor libre). El mismo dibujo sirve para el JPG de redes y, a tamaño A4, para imprimir o guardar en PDF.
 * Contraste: el texto va siempre sobre un fondo liso o sobre la foto oscurecida.
 */

export type PosterTemplate = 'foto' | 'banda' | 'liso';
export type PosterFormat = 'a4' | 'cuadrado' | 'vertical';

/** Píxeles de cada formato: A4 a 150 ppp, cuadrado y vertical de redes. */
export const POSTER_SIZES: Record<PosterFormat, [number, number]> = { a4: [1240, 1754], cuadrado: [1080, 1080], vertical: [1080, 1920] };

export interface PosterOffer { name: string; price: string; includes?: string | null }

export interface PosterContent {
  title: string;
  dates: string;
  place: string;
  offers: PosterOffer[];
  /** Línea final: contacto o «Plazas limitadas». */
  note?: string | null;
  logo?: CanvasImageSource & { width: number; height: number } | null;
  background?: CanvasImageSource & { width: number; height: number } | null;
}

const PLUM = '#3f2f45';
const PAPER = '#f6f2f6';
const INK = '#2a1f2e';
const LIGHT = '#ffffff';
const ACCENT = '#d9c6dd';

function fontFamily(): string {
  try {
    return getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif';
  } catch {
    return 'system-ui, sans-serif';
  }
}

/** Parte un texto en líneas que caben en `width`; corta con «…» si pasa de `max` líneas. */
export function wrapText(measure: (s: string) => number, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(next) <= width || !line) line = next;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, max);
  let last = kept[max - 1]!;
  while (last.length > 1 && measure(`${last}…`) > width) last = last.slice(0, -1);
  kept[max - 1] = `${last}…`;
  return kept;
}

function cover(ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale; const sh = h / scale;
  ctx.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, x, y, w, h);
}

export function drawPoster(canvas: HTMLCanvasElement, content: PosterContent, template: PosterTemplate, format: PosterFormat): void {
  const [W, H] = POSTER_SIZES[format];
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const family = fontFamily();
  const pad = Math.round(W * 0.075);
  const tpl: PosterTemplate = template !== 'liso' && !content.background ? 'liso' : template;

  // Fondo
  let textTop = pad;
  let ink = LIGHT;
  let accent = ACCENT;
  if (tpl === 'foto' && content.background) {
    cover(ctx, content.background, 0, 0, W, H);
    const shade = ctx.createLinearGradient(0, 0, 0, H);
    shade.addColorStop(0, 'rgba(25,15,30,0.45)');
    shade.addColorStop(1, 'rgba(25,15,30,0.80)');
    ctx.fillStyle = shade; ctx.fillRect(0, 0, W, H);
    textTop = Math.round(H * 0.38);
  } else if (tpl === 'banda' && content.background) {
    const band = Math.round(H * (format === 'cuadrado' ? 0.42 : 0.4));
    ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
    cover(ctx, content.background, 0, 0, W, band);
    textTop = band + pad;
    ink = INK; accent = PLUM;
  } else {
    ctx.fillStyle = PLUM; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.arc(W * 0.92, H * 0.08, W * 0.45, 0, Math.PI * 2); ctx.fill();
    textTop = Math.round(H * (format === 'cuadrado' ? 0.2 : 0.24));
  }

  // Logotipo arriba a la izquierda (sobre la banda, con un fondo claro para que se lea).
  if (content.logo) {
    const maxH = H * 0.09; const maxW = W * 0.35;
    const s = Math.min(maxH / content.logo.height, maxW / content.logo.width);
    const lw = content.logo.width * s; const lh = content.logo.height * s;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    const r = pad * 0.25;
    ctx.beginPath();
    ctx.roundRect?.(pad - r, pad - r, lw + 2 * r, lh + 2 * r, r);
    if (!ctx.roundRect) ctx.rect(pad - r, pad - r, lw + 2 * r, lh + 2 * r);
    ctx.fill();
    ctx.drawImage(content.logo, pad, pad, lw, lh);
  }

  const width = W - 2 * pad;
  let y = textTop;
  ctx.textBaseline = 'top';
  ctx.fillStyle = ink;

  // Título
  const titleSize = Math.round(W * (format === 'cuadrado' ? 0.07 : 0.078));
  ctx.font = `700 ${titleSize}px ${family}`;
  for (const line of wrapText((s) => ctx.measureText(s).width, content.title, width, 3)) { ctx.fillText(line, pad, y); y += titleSize * 1.12; }
  y += titleSize * 0.25;
  ctx.fillStyle = accent; ctx.fillRect(pad, y, W * 0.12, Math.max(4, W * 0.006)); y += W * 0.03;

  // Fechas y lugar
  const sub = Math.round(W * 0.042);
  ctx.fillStyle = ink;
  ctx.font = `600 ${sub}px ${family}`;
  ctx.fillText(content.dates, pad, y); y += sub * 1.3;
  ctx.font = `400 ${Math.round(sub * 0.85)}px ${family}`;
  for (const line of wrapText((s) => ctx.measureText(s).width, content.place, width, 2)) { ctx.fillText(line, pad, y); y += sub * 1.1; }
  y += sub * 0.8;

  // Ofertas: nombre a la izquierda, precio a la derecha; lo que incluye debajo, más pequeño.
  const offerSize = Math.round(W * (format === 'cuadrado' ? 0.036 : 0.038));
  const limit = H - pad - (content.note ? offerSize * 2 : 0);
  for (const offer of content.offers) {
    if (y + offerSize * 1.4 > limit) break;
    ctx.font = `700 ${offerSize}px ${family}`;
    const priceWidth = ctx.measureText(offer.price).width;
    ctx.textAlign = 'right'; ctx.fillText(offer.price, W - pad, y);
    ctx.textAlign = 'left';
    ctx.font = `600 ${offerSize}px ${family}`;
    const name = wrapText((s) => ctx.measureText(s).width, offer.name, width - priceWidth - pad * 0.5, 1)[0] ?? '';
    ctx.fillText(name, pad, y);
    y += offerSize * 1.3;
    if (offer.includes) {
      const small = Math.round(offerSize * 0.72);
      ctx.font = `400 ${small}px ${family}`;
      for (const line of wrapText((s) => ctx.measureText(s).width, offer.includes, width, 2)) {
        if (y + small > limit) break;
        ctx.fillText(line, pad, y); y += small * 1.25;
      }
    }
    y += offerSize * 0.5;
  }

  // Nota final, abajo.
  if (content.note) {
    const noteSize = Math.round(W * 0.03);
    ctx.font = `500 ${noteSize}px ${family}`;
    const lines = wrapText((s) => ctx.measureText(s).width, content.note, width, 2);
    let ny = H - pad - lines.length * noteSize * 1.25;
    for (const line of lines) { ctx.fillText(line, pad, ny); ny += noteSize * 1.25; }
  }
}

/** Imagen lista para el canvas a partir de una URL (se descarga como blob para no «contaminar» el lienzo). */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const local = URL.createObjectURL(blob);
  const img = new Image();
  img.decoding = 'async';
  await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('imagen')); img.src = local; });
  return img;
}
