/**
 * Asistentes por lo que les falta (pasada única, zona 3): la etapa de cada asistente, su estado escrito y el de su enlace.
 * Todo se **deriva** de lo leído (asistentes de Booking y enlaces del núcleo) y nunca se guarda.
 * - Puro y sin navegador, para las pruebas de Node (`tests/organizers/guests-state.test.ts`): los textos se traducen con el
 *   `t` que se pase (la clave es el español entero) y las fechas y los datos que faltan, con `day` y `missing`.
 */
import type { GuestMode } from '../../../../supabase/functions/_domain/booking/mod.ts';
import type { PortalGuest, PortalLink } from './api.ts';

type Tr = (spanish: string, vars?: Record<string, string | number>) => string;
const plain: Tr = (s, vars) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
/** Marca un texto de tabla que se traduce al pintarlo (como `L` de `i18n.ts`, sin depender del kit). */
const L = (spanish: string): string => spanish;

/** Cómo se traducen los textos: `t` del portal, el día de una fecha con hora y la lista de lo que falta. */
export interface GuestTexts {
  t: Tr;
  day: (iso: string) => string;
  missing: (keys: readonly string[]) => string;
}
const PLAIN: GuestTexts = { t: plain, day: (iso) => iso.slice(0, 10), missing: (keys) => keys.join(', ') };

export type Stage = 'sinenlace' | 'sinabrir' | 'faltan' | 'sinfirma' | 'completo';
export type StageTone = 'alert' | 'warn' | 'ok';

/** Grupos fijos de la lista, en este orden: título, resumen y tono (los textos se traducen al pintarlos). */
export const STAGE_GROUPS: ReadonlyArray<{ key: Stage; title: string; summary: string; tone: StageTone }> = [
  { key: 'sinenlace', title: L('Sin enlace'), summary: L('Aún no les has enviado su enlace'), tone: 'alert' },
  { key: 'sinabrir', title: L('No han abierto su enlace'), summary: L('Tienen el enlace, pero no lo han abierto'), tone: 'warn' },
  { key: 'faltan', title: L('Les faltan datos'), summary: L('Puedes rellenarlos tú o recordárselo'), tone: 'warn' },
  { key: 'sinfirma', title: L('Les falta firmar'), summary: L('Firmarán en su enlace o al llegar'), tone: 'warn' },
  { key: 'completo', title: L('Completos'), summary: L('Todo listo'), tone: 'ok' },
];

/** Anillo de cada plaza (porcentaje del recorrido): sin enlace 5, sin abrir 25, faltan datos 55, sin firma 80, completo 100. */
export const STAGE_RING: Record<Stage, number> = { sinenlace: 5, sinabrir: 25, faltan: 55, sinfirma: 80, completo: 100 };

/** Completo: sin datos que falten y, con registro de viajeros, firmado. */
export const guestComplete = (g: { missing: readonly string[]; signed: boolean }, mode: string) => g.missing.length === 0 && (mode !== 'ses' || g.signed);

/**
 * Grupo de cada asistente. Sin datos de los enlaces (`linksKnown` falso) no se afirma «Sin enlace» ni «No han abierto».
 * `link` es el enlace vivo más reciente (`linksByGuest(...).get(id)`).
 */
export function stageOf(g: { missing: readonly string[]; signed: boolean }, link: PortalLink | undefined, mode: GuestMode | string, linksKnown: boolean): Stage {
  if (guestComplete(g, mode)) return 'completo';
  if (!linksKnown) return g.missing.length ? 'faltan' : 'sinfirma';
  if (!link) return 'sinenlace';
  if (!link.lastUsedAt) return 'sinabrir';
  return g.missing.length ? 'faltan' : 'sinfirma';
}

/** Último enlace vivo de cada asistente (los revocados no cuentan). */
export function linksByGuest(links: readonly PortalLink[] | undefined | null): Map<string, PortalLink> {
  const out = new Map<string, PortalLink>();
  for (const link of links ?? []) {
    const guest = link.scope.guest_id;
    if (!guest || link.revokedAt) continue;
    const prev = out.get(guest);
    if (!prev || prev.createdAt < link.createdAt) out.set(guest, link);
  }
  return out;
}

/** Estado de un asistente: etiqueta, tono del chip y detalle. */
export function guestState(g: Pick<PortalGuest, 'missing' | 'signed' | 'display_name'>, mode: string, texts: GuestTexts = PLAIN): { label: string; tone: 'ok' | 'warn' | 'pending'; detail: string } {
  const { t } = texts;
  if (g.missing.length) return { label: t('Faltan datos'), tone: 'warn', detail: t('Falta: {datos}', { datos: texts.missing(g.missing) }) };
  if (mode === 'ses' && !g.signed) return { label: t('Falta la firma'), tone: 'pending', detail: t('La hará {nombre} al abrir su enlace o al llegar', { nombre: g.display_name }) };
  return { label: t('Completo'), tone: 'ok', detail: t('Todo listo') };
}

export function linkText(link: PortalLink | undefined, texts: GuestTexts = PLAIN): string {
  const { t } = texts;
  if (!link) return t('Enlace sin enviar');
  if (link.lastUsedAt) return t('Lo abrió el {fecha}', { fecha: texts.day(link.lastUsedAt) });
  return t('Enlace enviado el {fecha}', { fecha: texts.day(link.createdAt) });
}

/** El porqué de cada fila: lo que le falta a esa persona, dicho para quien organiza. */
export function reasonOf(stage: Stage, g: Pick<PortalGuest, 'missing' | 'signed' | 'display_name'>, link: PortalLink | undefined, mode: string, texts: GuestTexts = PLAIN): string {
  const { t } = texts;
  switch (stage) {
    case 'sinenlace': return t('Aún no le has enviado su enlace');
    case 'sinabrir': return link ? t('Enlace enviado el {fecha}, sin abrir', { fecha: texts.day(link.createdAt) }) : guestState(g, mode, texts).detail;
    case 'completo': return t('Todo listo');
    default: return guestState(g, mode, texts).detail;
  }
}
