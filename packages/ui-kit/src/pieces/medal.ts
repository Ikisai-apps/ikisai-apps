/**
 * Medallón (MUELA-075, pieza 1): la imagen del objeto en un círculo pequeño o, si no hay, sus iniciales o un icono. En
 * tarjetas grandes, `cover` pone la imagen de fondo. Sin acciones propias: no es objetivo táctil.
 * - Decorativo (`aria-hidden`) cuando acompaña a un nombre escrito, que es lo normal.
 * - Con `label`, es la única identificación: `role="img"` con ese nombre.
 * Prefijo de clases: `medal-` (nunca `.medal` suelto, regla v45).
 */
import { el } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { itemColorStyle } from '../theme.ts';

export interface MedalOptions {
  /** URL de la imagen (o miniatura). Si no carga, salen las iniciales o el icono. */
  image?: string | null;
  /** Nombre del objeto: de él salen las iniciales si no se dan. */
  name?: string | null;
  initials?: string | null;
  /** Icono del kit o nodo propio (de la app, del tipo o del área) si no hay imagen ni nombre. */
  icon?: IconName | Node | null;
  /** Color de fondo de las iniciales o el icono (tinta calculada). */
  color?: string | null;
  /** Diámetro en px: 40 (cabecera de estantería), 44 (filas) o 72 (mostrador). Por defecto 44. */
  size?: number;
  /** Solo si el medallón es la única identificación; si no, queda decorativo. */
  label?: string | null;
  /** Imagen de fondo para una tarjeta grande (ocupa su contenedor, que debe tener `position: relative`). */
  cover?: boolean;
  /**
   * Velo de `cover`. `edges` (por defecto): oscurece abajo (título) y arriba (píldoras), y deja ver la foto en medio.
   * `full`: para tarjetas con texto en toda la foto; da 4,5:1 al texto blanco de arriba abajo, también con fotos claras.
   */
  veil?: 'edges' | 'full';
}

const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y', 'e', 'da', 'do', 'dos', 'van', 'von', 'di']);

/** «Ana López» → «AL»; «Casa de la Muela» → «CM»; «Hab 3» → «H3». Como mucho dos letras, en mayúscula. */
export function initialsOf(name: string | null | undefined): string {
  const words = (name ?? '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  const main = words.filter((w) => !PARTICLES.has(w.toLowerCase()));
  const list = main.length ? main : words;
  if (!list.length) return '';
  const first = (w: string) => [...w.replace(/^[^\p{L}\p{N}]+/u, '')][0] ?? '';
  const out = list.length === 1 ? first(list[0]!) : first(list[0]!) + first(list[list.length - 1]!);
  return out.toLocaleUpperCase();
}

export function renderMedal(options: MedalOptions): HTMLElement {
  if (options.cover) {
    return el('span', { class: `medal-cover${options.veil === 'full' ? ' medal-veil-full' : ''}`, 'aria-hidden': 'true', style: options.image ? `background-image:url("${String(options.image).replace(/["\\]/g, '')}")` : null });
  }
  const size = options.size ?? 44;
  const a11y = options.label ? { role: 'img', 'aria-label': options.label } : { 'aria-hidden': 'true' };
  const initials = options.initials ?? initialsOf(options.name);
  const fallback = (): Node => (initials
    ? el('span', { class: 'medal-initials' }, initials)
    : options.icon
      ? (typeof options.icon === 'string' ? icon(options.icon as IconName, Math.round(size * 0.5)) : options.icon)
      : el('span', { class: 'medal-initials' }, '·'));
  const style = [`--medal-size:${size}px`, options.color ? itemColorStyle(options.color) : ''].filter(Boolean).join(';');
  const box = el('span', { class: `medal-disc${options.color ? ' medal-colored' : ''}`, style, ...a11y });
  if (options.image) {
    const img = el('img', { src: options.image, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }) as HTMLImageElement;
    img.addEventListener('error', () => { box.classList.remove('medal-has-image'); img.replaceWith(fallback()); }, { once: true });
    box.classList.add('medal-has-image');
    box.append(img);
  } else box.append(fallback());
  return box;
}
