/**
 * Textos legales, de contacto e información práctica: se leen de Central (`central.common_texts_projection`; decisión del
 * usuario del 7-10-2026), nunca fijos en el código. Lo que hay aquí es solo la reserva para cuando la lectura falla.
 * Idioma (API.md §9.10, CE1 en la migración 0570 de Central): la proyección trae una fila por clave e idioma; si falta el
 * inglés, la fila `en` lleva el español con `fallback = true`, y aquí se muestra el español con `spanishOnly`. La
 * versión que se guarda al aceptar o firmar es `<idioma de origen>-<versión>` («es-v2»). Son textos públicos: la última
 * copia se guarda sin persona.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { locale, type Locale } from './i18n.ts';

export interface CommonText {
  key: string; title: string | null; body: string; version: string | null; kind: string | null;
  lang?: string | null; source_lang?: string | null; fallback?: boolean | null;
}
export interface ShownText extends CommonText { spanishOnly: boolean }

export const INFO_KEYS = ['info.arrival', 'info.parking', 'info.facilities', 'info.rules', 'info.bring'] as const;
const KEYS = ['portal.privacy', 'contact.email', 'contact.phone', 'guests.data_why', 'guests.signature_statement', 'guests.allergies_notice', ...INFO_KEYS] as const;
export type TextKey = (typeof KEYS)[number];
const STORE = 'ikisai-guests-texts';

type ByLang = Partial<Record<Locale, Partial<Record<TextKey, CommonText>>>>;

const text = (key: TextKey, kind: string, body: string, title: string | null = null): CommonText => ({ key, title, body, version: null, kind });
const FALLBACK: ByLang = {
  es: {
    'portal.privacy': text('portal.privacy', 'legal', 'Ikisai trata tus datos para gestionar tu estancia y, cuando la ley lo exige, para el registro de viajeros, que se conserva tres años. Puedes consultarlos, corregirlos o pedir su supresión escribiendo a Ikisai.', 'Protección de datos'),
    'contact.email': text('contact.email', 'contact', 'organiza@ikisai.com'),
    'contact.phone': text('contact.phone', 'contact', '614 76 57 96'),
    'guests.data_why': text('guests.data_why', 'mensaje', 'La ley obliga a los alojamientos a registrar a cada viajero y comunicarlo al Ministerio del Interior (Real Decreto 933/2021). Solo pedimos lo que exige ese registro.', '¿Por qué te lo pedimos?'),
    'guests.signature_statement': text('guests.signature_statement', 'legal', 'Declaro que estos datos son ciertos. Se incorporan al registro de viajeros de Ikisai, que la ley obliga a conservar tres años.', 'Declaración'),
    'guests.allergies_notice': text('guests.allergies_notice', 'mensaje', 'La cocina de Ikisai tendrá en cuenta lo que indiques. Si tu alergia es grave, recuérdalo también al llegar.'),
  },
  en: {
    'portal.privacy': text('portal.privacy', 'legal', 'Ikisai processes your data to manage your stay and, where the law requires it, for the guest register, which is kept for three years. You can access, correct or ask us to delete it by writing to Ikisai.', 'Data protection'),
    'guests.data_why': text('guests.data_why', 'mensaje', 'Spanish law requires accommodation providers to register every guest and report it to the Ministry of the Interior (Royal Decree 933/2021). We only ask for what that register needs.', 'Why do we ask?'),
    'guests.signature_statement': text('guests.signature_statement', 'legal', 'I declare that this information is true. It becomes part of Ikisai\'s guest register, which the law requires us to keep for three years.', 'Declaration'),
    'guests.allergies_notice': text('guests.allergies_notice', 'mensaje', 'Ikisai\'s kitchen will take what you tell us into account. If your allergy is severe, please remind us when you arrive too.'),
  },
};

let loaded: ByLang = readStored();

function readStored(): ByLang {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}') as ByLang;
  } catch {
    return {};
  }
}

function store(rows: CommonText[]): void {
  const next: ByLang = { es: { ...loaded.es }, en: { ...loaded.en } };
  let any = false;
  for (const row of rows) {
    if (!(KEYS as readonly string[]).includes(row.key) || typeof row.body !== 'string' || !row.body.trim()) continue;
    if (row.lang === 'en' && row.fallback) continue; // el español ya llega en su propia fila
    const lang: Locale = row.lang === 'en' ? 'en' : 'es';
    next[lang]![row.key as TextKey] = { ...row, source_lang: row.source_lang ?? lang };
    any = true;
  }
  if (!any) return;
  loaded = next;
  try { localStorage.setItem(STORE, JSON.stringify(loaded)); } catch { /* solo en memoria */ }
}

/** Pide los textos a Central (con sesión). Si falla, se quedan la última copia o la reserva. */
export async function loadCommonTexts(client: SyncClient): Promise<void> {
  try {
    const out = await client.api<{ rows?: CommonText[]; items?: CommonText[] }>('/read/central.common_texts_projection?limit=200');
    store(out.rows ?? out.items ?? []);
  } catch {
    /* sin red, sin acceso aún o Central sin publicar: reserva */
  }
}

/** Contacto sin sesión (petición C1: `GET /api/v1/public/contact?lang=`); si la ruta aún no existe, queda la reserva. */
export async function loadPublicContact(): Promise<void> {
  try {
    const res = await fetch(`/api/v1/public/contact?lang=${locale()}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const out = (await res.json()) as { items?: CommonText[]; rows?: CommonText[] } & Record<string, unknown>;
    const rows: CommonText[] = out.items ?? out.rows ?? Object.entries(out)
      .filter(([, v]) => typeof v === 'string' || (v && typeof (v as CommonText).body === 'string'))
      .map(([key, v]) => (typeof v === 'string' ? { key, body: v, title: null, version: null, kind: 'contact' } : { ...(v as CommonText), key }));
    store(rows.filter((r) => r.key === 'contact.email' || r.key === 'contact.phone'));
  } catch {
    /* sin red: copia guardada o reserva */
  }
}

/** Texto en el idioma elegido, o en español (con `spanishOnly`), o la reserva; null si no existe (información práctica). */
export function commonText(key: TextKey): ShownText | null {
  const lang = locale();
  const own = loaded[lang]?.[key] ?? (lang === 'es' ? null : FALLBACK[lang]?.[key] && !loaded.es?.[key] ? FALLBACK[lang]![key]! : null);
  if (own) return { ...own, spanishOnly: false };
  const spanish = loaded.es?.[key] ?? FALLBACK.es?.[key];
  if (!spanish) return null;
  return { ...spanish, spanishOnly: lang !== 'es' && key !== 'contact.email' && key !== 'contact.phone' };
}

export function contactEmail(): string { return commonText('contact.email')?.body ?? ''; }
export function contactPhone(): string { return commonText('contact.phone')?.body ?? ''; }

/** Versión del texto que se muestra ahora («es-v2»); `null` si es el texto de reserva del código. */
export function textVersion(key: TextKey): string | null {
  const shown = commonText(key);
  if (!shown?.version) return null;
  return `${shown.source_lang ?? (shown.spanishOnly ? 'es' : locale())}-${shown.version}`;
}

/** Versiones vigentes de un texto en cualquier idioma: aceptar el aviso en español vale también en inglés. */
export function textVersions(key: TextKey): string[] {
  return (['es', 'en'] as const).flatMap((lang) => {
    const row = loaded[lang]?.[key];
    return row?.version ? [`${row.source_lang ?? lang}-${row.version}`] : [];
  });
}
