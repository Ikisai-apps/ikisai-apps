/**
 * Ikisai Central · «Textos y contacto» (docs/central/API.md §2.12): textos legales, avisos, declaraciones y datos de contacto
 * que ven las personas y los portales, editados siempre desde Central. Marcadores, versión y Markdown sencillo.
 * La sustitución de marcadores es la misma que hace `central.render_text` en SQL (vista previa sin red en la app).
 */
import { formatIban, venueMap } from './entity.ts';

export const TEXTS_TABLE = 'central.texts';
export const TEXTS_PROJECTION = 'central.common_texts_projection';
export const TEXT_KINDS = ['legal', 'mensaje', 'info', 'contacto'] as const;
export type TextKind = typeof TEXT_KINDS[number];
export const TEXT_KIND_LABELS: Record<TextKind, string> = { legal: 'Legal', mensaje: 'Mensajes y avisos', info: 'Información práctica', contacto: 'Contacto' };
export const TEXT_KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
/** Idiomas de los textos (portales bilingües): `es` obligatorio, `en` opcional; si falta, los portales usan el español. */
export const TEXT_LANGS = ['es', 'en'] as const;
export type TextLang = typeof TEXT_LANGS[number];
export const TEXT_LANG_LABELS: Record<TextLang, string> = { es: 'Español', en: 'Inglés' };
/** Públicos con correo propio (decisión del usuario del 8-10-2026). El de facturas es el correo de la Entidad. */
export const CONTACT_AUDIENCES = ['organizers', 'guests', 'staff', 'suppliers'] as const;
export type ContactAudience = typeof CONTACT_AUDIENCES[number];
export const CONTACT_AUDIENCE_LABELS: Record<ContactAudience, string> = { organizers: 'Organizadores', guests: 'Huéspedes', staff: 'Equipo', suppliers: 'Proveedores' };
/** Clave del correo de un público, como `central.contact_email_key`. */
export const contactEmailKey = (audience: ContactAudience) => `contact.${audience}.email`;
export const isContactEmailKey = (key: string) => CONTACT_AUDIENCES.some((a) => contactEmailKey(a) === key);
export const CONTACT_KEYS = { phone: 'contact.phone' } as const;

/** Marcadores admitidos, con lo que significan (para la ayuda del editor). */
export const TEXT_MARKERS: ReadonlyArray<{ marker: string; label: string }> = [
  { marker: '{{entidad.razon_social}}', label: 'Razón social' },
  { marker: '{{entidad.nif}}', label: 'NIF/CIF' },
  { marker: '{{entidad.domicilio}}', label: 'Domicilio fiscal' },
  { marker: '{{entidad.lugar}}', label: 'Dirección del lugar de los retiros' },
  { marker: '{{entidad.mapa}}', label: 'Enlace del mapa del lugar' },
  { marker: '{{entidad.iban}}', label: 'IBAN' },
  { marker: '{{entidad.bizum}}', label: 'Bizum' },
  { marker: '{{contacto.organizadores}}', label: 'Correo para organizadores' },
  { marker: '{{contacto.huespedes}}', label: 'Correo para huéspedes' },
  { marker: '{{contacto.trabajadores}}', label: 'Correo para el equipo' },
  { marker: '{{contacto.proveedores}}', label: 'Correo para proveedores' },
  { marker: '{{contacto.correo}}', label: 'Correo de contacto (antiguo: el de organizadores)' },
  { marker: '{{contacto.telefono}}', label: 'Teléfono de contacto' },
];

/**
 * Bloques condicionales: lo de dentro solo se ve si la Entidad tiene ese dato; si no, el bloque desaparece entero (como
 * `central.render_blocks`). Por ahora, solo el Bizum.
 */
export const TEXT_BLOCKS: ReadonlyArray<{ open: string; close: string; label: string; help: string }> = [
  { open: '{{#entidad.bizum}}', close: '{{/entidad.bizum}}', label: 'Solo si hay Bizum',
    help: 'Lo que escribas entre {{#entidad.bizum}} y {{/entidad.bizum}} solo se ve si la Entidad tiene Bizum; si no, desaparece entero.' },
];

/** Aplica los bloques condicionales; sin el dato, quita el bloque y los saltos de línea que lo separaban, como en SQL. */
export function renderBlocks(body: string, hasBizum: boolean): string {
  if (!body.includes('{{#entidad.bizum}}')) return body;
  const block = /\{\{#entidad\.bizum\}\}([\s\S]*?)\{\{\/entidad\.bizum\}\}/g;
  if (hasBizum) return body.replace(block, '$1');
  return body.replace(block, '\u0001').replace(/\n*\u0001/g, '').replace(/^\n+/, '');
}

export interface MarkerSource {
  entity?: { legal_name?: string | null; tax_id?: string | null; address_line?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null; iban?: string | null; bizum?: string | null; venue_address?: string | null; venue_map_url?: string | null } | null;
  /** Correo de organizadores (y de {{contacto.correo}}); `emails` lo sustituye si trae `organizers`. */
  email?: string | null;
  emails?: Partial<Record<ContactAudience, string | null>>;
  phone?: string | null;
}

/** Domicilio en una línea, como en SQL: «Calle, 28000 Madrid, Provincia» (país solo si no es España). */
export function entityAddress(e: MarkerSource['entity']): string | null {
  if (!e) return null;
  const place = [e.postal_code, e.city].filter((x) => x && String(x).trim()).join(' ').trim();
  const parts = [e.address_line, place, e.province, e.country && e.country !== 'ES' ? e.country : null].filter((x) => x && String(x).trim());
  return parts.length ? parts.join(', ') : null;
}

/** Sustituye los marcadores; lo que falta se escribe «—» (igual que `central.render_text`). */
export function renderMarkers(body: string, source: MarkerSource): string {
  const e = source.entity ?? null;
  const org = (source.emails?.organizers ?? source.email)?.trim();
  const values: Record<string, string> = {
    '{{entidad.razon_social}}': e?.legal_name || '—',
    '{{entidad.nif}}': e?.tax_id || '—',
    '{{entidad.domicilio}}': entityAddress(e) || '—',
    '{{entidad.lugar}}': e?.venue_address?.trim() || '—',
    '{{entidad.mapa}}': venueMap(e) || '—',
    '{{entidad.iban}}': formatIban(e?.iban) || '—',
    '{{entidad.bizum}}': e?.bizum?.trim() || '—',
    '{{contacto.correo}}': org || '—',
    '{{contacto.organizadores}}': org || '—',
    '{{contacto.huespedes}}': source.emails?.guests?.trim() || '—',
    '{{contacto.trabajadores}}': source.emails?.staff?.trim() || '—',
    '{{contacto.proveedores}}': source.emails?.suppliers?.trim() || '—',
    '{{contacto.telefono}}': source.phone?.trim() || '—',
  };
  return Object.entries(values).reduce((text, [marker, value]) => text.split(marker).join(value), renderBlocks(body, !!e?.bizum?.trim()));
}

/** Marcadores escritos que no existen (`{{entidad.cif}}`): la interfaz los avisa antes de guardar. */
export function unknownMarkers(body: string): string[] {
  const known = new Set([...TEXT_MARKERS.map((m) => m.marker), ...TEXT_BLOCKS.flatMap((b) => [b.open, b.close])]);
  return [...new Set(body.match(/\{\{[^}]*\}\}/g) ?? [])].filter((m) => !known.has(m));
}

/** Versión que tendrá el texto al guardar un cambio de contenido (`v3` → `v4`), como el disparador de la base. */
export function nextVersion(version: string | null | undefined): string {
  const n = Number(/^v(\d+)$/.exec(version ?? '')?.[1] ?? '0');
  return `v${(n || 0) + 1}`;
}

/** Trozo de una línea: texto normal o en **negrita**. */
export interface Inline { text: string; bold: boolean }

/**
 * Markdown sencillo de los textos: párrafos separados por una línea en blanco, saltos de línea dentro del párrafo y
 * **negrita**. Devuelve párrafos → líneas → trozos, para pintarlos sin `innerHTML` (los portales hacen lo mismo).
 */
export function parseSimpleMarkdown(text: string): Inline[][][] {
  return text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).map((paragraph) =>
    paragraph.split('\n').map((line) => {
      const out: Inline[] = [];
      const parts = line.split('**');
      parts.forEach((part, i) => { if (part) out.push({ text: part, bold: i % 2 === 1 && i < parts.length - (parts.length % 2 === 0 ? 1 : 0) }); });
      return out;
    }));
}
