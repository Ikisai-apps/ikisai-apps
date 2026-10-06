/**
 * Nombre canónico de archivo (API.md §2.12, handoff §24A):
 *   AAAA_MM_DD_(empresa)_objeto[_NN][_pNN].ext
 * La función SQL `invoices.normalized_filename` aplica exactamente las mismas reglas; `tests/invoices/domain.test.ts`
 * comprueba la paridad sobre PGlite.
 */
import type { FileMime } from './types.ts';

/** Tabla fija de sustituciones (no se depende de `unaccent` ni de NFD para que SQL y TS coincidan). */
const ACCENTS: Record<string, string> = {
  á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a', å: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i',
  ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o', ø: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c', ý: 'y', ÿ: 'y', ß: 'ss', æ: 'ae', œ: 'oe',
};
export const ACCENT_FROM = Object.keys(ACCENTS).join('');
export const ACCENT_TO = Object.values(ACCENTS).join('');

export const SLUG_MAX = 40;

/** minúsculas · sin acentos · `[^a-z0-9]+ → _` · sin `_` en los extremos · ≤ 40 caracteres. */
export function slugify(text: string, max: number = SLUG_MAX): string {
  let out = '';
  for (const ch of text.toLowerCase()) out += ACCENTS[ch] ?? ch;
  out = out.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (out.length > max) out = out.slice(0, max).replace(/_+$/g, '');
  return out;
}

export const EXTENSION_BY_MIME: Record<FileMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extensionFor(mime: string): string {
  return EXTENSION_BY_MIME[mime as FileMime] ?? 'bin';
}

export interface NormalizedFilenameInput {
  /** `AAAA-MM-DD` (ISO). */
  invoiceDate: string;
  supplierSlug: string;
  object: string;
  mime: string;
  /** Página de este archivo dentro de la factura (1..n). */
  pageOrder?: number;
  /** Número total de archivos `original` de la factura; con más de uno se añade `_pNN`. */
  pageCount?: number;
  /** Índice de colisión entre facturas con misma fecha, empresa y objeto: 1 = sin sufijo, 2 → `_02`. */
  collision?: number;
}

/** Base sin extensión ni sufijos: `2026_10_05_(makro)_alimentos_retiro_yoga`. */
export function normalizedBase(invoiceDate: string, supplierSlug: string, object: string): string {
  const date = invoiceDate.slice(0, 10).replace(/-/g, '_');
  const supplier = slugify(supplierSlug) || 'sin_proveedor';
  const subject = slugify(object) || 'sin_objeto';
  return `${date}_(${supplier})_${subject}`;
}

export function normalizedFilename(input: NormalizedFilenameInput): string {
  const base = normalizedBase(input.invoiceDate, input.supplierSlug, input.object);
  const collision = input.collision ?? 1;
  const pageCount = input.pageCount ?? 1;
  const pageOrder = input.pageOrder ?? 1;
  const collisionSuffix = collision > 1 ? `_${String(collision).padStart(2, '0')}` : '';
  const pageSuffix = pageCount > 1 ? `_p${String(pageOrder).padStart(2, '0')}` : '';
  return `${base}${collisionSuffix}${pageSuffix}.${extensionFor(input.mime)}`;
}

/** Nombre de la carpeta de una entrega: `IKISAI_COMPRAS_2026_T4`, `IKISAI_COMPRAS_2026`, `IKISAI_COMPRAS_2026_01_01_2026_02_15`. */
export function exportFolderName(kind: 'quarter' | 'year' | 'custom', year: number, quarter: number | null, from: string, to: string): string {
  if (kind === 'quarter' && quarter) return `IKISAI_COMPRAS_${year}_T${quarter}`;
  if (kind === 'year') return `IKISAI_COMPRAS_${year}`;
  return `IKISAI_COMPRAS_${from.replace(/-/g, '_')}_${to.replace(/-/g, '_')}`;
}
