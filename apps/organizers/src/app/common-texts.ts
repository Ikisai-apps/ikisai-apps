/**
 * Textos legales y de contacto: se leen de Central (`central.common_texts_projection`, decisión del usuario del 7-10-2026),
 * nunca fijos en el código. Lo que hay aquí es solo la reserva para cuando la lectura falla (sin red y sin copia).
 * Son textos públicos: la última copia se guarda en el dispositivo sin persona, para la pantalla de entrada sin sesión.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { i18n, t } from './i18n.ts';

export interface CommonText { key: string; title: string | null; body: string; version: string | null; kind: string | null; lang?: string; source_lang?: string }

export type TextKey = 'organizers.declaration' | 'portal.privacy' | 'contact.email' | 'contact.phone';
const KEYS: readonly TextKey[] = ['organizers.declaration', 'portal.privacy', 'contact.email', 'contact.phone'];
const storeKey = () => `ikisai-organizers-texts:${i18n.locale()}`;

const FALLBACK: Record<TextKey, CommonText> = {
  'organizers.declaration': {
    key: 'organizers.declaration', title: 'Declaración', version: 'v1', kind: 'legal',
    body: 'Facilito estos datos con conocimiento de mis asistentes y solo para organizar su estancia en Ikisai. Cada asistente recibirá la información sobre protección de datos al abrir su enlace personal.',
  },
  'portal.privacy': {
    key: 'portal.privacy', title: 'Protección de datos', version: null, kind: 'legal',
    body: 'Ikisai trata estos datos para gestionar la estancia y, cuando la ley lo exige, para el registro de viajeros. Cada persona puede consultarlos, corregirlos o pedir su supresión escribiendo a Ikisai.',
  },
  'contact.email': { key: 'contact.email', title: 'Correo', version: null, kind: 'contact', body: 'organiza@ikisai.com' },
  'contact.phone': { key: 'contact.phone', title: 'Teléfono', version: null, kind: 'contact', body: '614 76 57 96' },
};

/** Reserva en inglés (solo los textos que cambian de idioma; el contacto es el mismo). */
const FALLBACK_EN: Partial<Record<TextKey, CommonText>> = {
  'organizers.declaration': {
    key: 'organizers.declaration', title: 'Declaration', version: 'v1', kind: 'legal', lang: 'en', source_lang: 'en',
    body: 'I provide this information with the knowledge of my attendees and only to organise their stay at Ikisai. Each attendee will receive the data protection information when they open their personal link.',
  },
  'portal.privacy': {
    key: 'portal.privacy', title: 'Data protection', version: null, kind: 'legal', lang: 'en',
    body: 'Ikisai processes this information to manage the stay and, where the law requires it, for the guest register. Each person can access, correct or ask for the deletion of their data by writing to Ikisai.',
  },
};

let loaded: Partial<Record<TextKey, CommonText>> = readStored();
let loadedLang = i18n.locale();
i18n.onChange(() => { loaded = readStored(); loadedLang = i18n.locale(); });

function readStored(): Partial<Record<TextKey, CommonText>> {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) ?? '{}') as Partial<Record<TextKey, CommonText>>;
  } catch {
    return {};
  }
}

/** Idioma de la pantalla (el del navegador o el que se eligió en el selector). */
export const deviceLang = (): 'es' | 'en' => i18n.locale();

/**
 * Pide los textos a Central (con sesión), en el idioma del dispositivo (la proyección trae una fila por clave e idioma, con
 * el español como reserva). Si falla, se quedan la última copia o la reserva.
 */
export async function loadCommonTexts(client: SyncClient): Promise<void> {
  try {
    const out = await client.api<{ rows?: CommonText[]; items?: CommonText[] }>(`/read/central.common_texts_projection?where[lang]=${deviceLang()}&limit=200`);
    const rows = out.rows ?? out.items ?? [];
    const next: Partial<Record<TextKey, CommonText>> = {};
    for (const row of rows) if ((KEYS as readonly string[]).includes(row.key) && typeof row.body === 'string' && row.body.trim()) next[row.key as TextKey] = row;
    if (!Object.keys(next).length) return;
    loaded = { ...loaded, ...next };
    try { localStorage.setItem(storeKey(), JSON.stringify(loaded)); } catch { /* sin almacenamiento: solo en memoria */ }
  } catch {
    /* sin red, sin acceso aún o Central sin publicar: reserva */
  }
}

/**
 * Contacto sin sesión (pantallas de enlace no válido o caducado): `GET /api/v1/public/contact?lang=`, cacheable, solo
 * textos de tipo contacto. Admite lista (`items` o `rows`) u objeto por clave; si la ruta aún no existe, queda la reserva.
 */
export async function loadPublicContact(lang = deviceLang()): Promise<void> {
  try {
    const res = await fetch(`/api/v1/public/contact?lang=${lang}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return;
    const out = (await res.json()) as { items?: CommonText[]; rows?: CommonText[] } & Record<string, unknown>;
    const rows: CommonText[] = out.items ?? out.rows ?? Object.entries(out)
      .filter(([, v]) => typeof v === 'string' || (v && typeof (v as CommonText).body === 'string'))
      .map(([key, v]) => (typeof v === 'string' ? { key, body: v, title: null, version: null, kind: 'contact' } : { ...(v as CommonText), key }));
    const next: Partial<Record<TextKey, CommonText>> = {};
    for (const row of rows) if ((row.key === 'contact.email' || row.key === 'contact.phone') && typeof row.body === 'string' && row.body.trim()) next[row.key] = row;
    if (!Object.keys(next).length) return;
    loaded = { ...loaded, ...next };
    try { localStorage.setItem(storeKey(), JSON.stringify(loaded)); } catch { /* solo en memoria */ }
  } catch {
    /* sin red: copia guardada o reserva */
  }
}

export function commonText(key: TextKey): CommonText {
  void loadedLang;
  return loaded[key] ?? (i18n.locale() === 'en' ? FALLBACK_EN[key] : undefined) ?? FALLBACK[key];
}

/** «Escríbenos a organiza@ikisai.com o llámanos al 614 76 57 96.» */
export function contactLine(): string {
  return t('Escríbenos a {correo} o llámanos al {telefono}.', { correo: commonText('contact.email').body, telefono: commonText('contact.phone').body });
}

/** Versión de la declaración que se acepta, con el idioma del texto que se vio (`v1/es`); se guarda en Booking con la aceptación. */
export function declarationVersion(): string {
  const text = commonText('organizers.declaration');
  return `${text.version ?? 'v1'}/${text.source_lang ?? text.lang ?? 'es'}`;
}

/** Cuerpo de un texto de Central (markdown sencillo: párrafos y **negrita**) como nodos, sin HTML del servidor. */
export function textParagraphs(body: string): HTMLElement[] {
  return body.split(/\n{2,}/).map((block) => {
    const p = document.createElement('p');
    p.className = 'small';
    for (const [i, part] of block.split('**').entries()) {
      if (!part) continue;
      if (i % 2) { const b = document.createElement('strong'); b.textContent = part; p.append(b); }
      else p.append(document.createTextNode(part));
    }
    return p;
  });
}
