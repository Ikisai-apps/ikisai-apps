/**
 * Textos para compartir y copiar (API.md §9.4 a §9.6), en el idioma de quien organiza. Sin datos de otras personas en lo
 * que se pega en grupos.
 */
import type { GuestMode } from '../../../../supabase/functions/_domain/booking/mod.ts';
import { t } from './i18n.ts';
import { dateRange, missingText } from './labels.ts';

export interface RetreatRef { title: string; start_date: string | null; end_date: string | null }

/** Mensaje con el enlace personal de un asistente. */
export function linkMessage(name: string, retreat: RetreatRef, url: string, mode: GuestMode): string {
  const legal = mode === 'ses' ? ` ${t('Son los datos que exige el registro de viajeros.')}` : '';
  return `${t('Hola, {nombre}: este es tu enlace personal para el retiro «{retiro}» en Ikisai ({fechas}). Ábrelo para completar tus datos antes de llegar.', { nombre: name, retiro: retreat.title, fechas: dateRange(retreat.start_date, retreat.end_date) })}${legal} ${url}`;
}

/** Recordatorio para una persona: lo que le falta y, si se acaba de generar, su enlace. */
export function personReminder(name: string, retreat: RetreatRef, missing: readonly string[], needsSignature: boolean, url?: string | null): string {
  const vars = { nombre: name, retiro: retreat.title, fechas: dateRange(retreat.start_date, retreat.end_date), datos: missingText(missing) };
  if (!missing.length && !needsSignature) return t('Hola, {nombre}: para el retiro «{retiro}» ({fechas}) ya lo tienes todo listo, ¡gracias!', vars);
  const what = missing.length && needsSignature
    ? t('Hola, {nombre}: para el retiro «{retiro}» ({fechas}) te falta completar {datos} y firmar el registro de viajeros.', vars)
    : missing.length
      ? t('Hola, {nombre}: para el retiro «{retiro}» ({fechas}) te falta completar {datos}.', vars)
      : t('Hola, {nombre}: para el retiro «{retiro}» ({fechas}) te falta firmar el registro de viajeros.', vars);
  const link = url ? t('Tu enlace: {url}', { url }) : t('Usa el enlace personal que te envié; si no lo encuentras, dímelo y te lo reenvío.');
  return `${what} ${link}`;
}

/** Recordatorio para el grupo: sin nombres, se pega en grupos de WhatsApp. */
export function groupReminder(retreat: RetreatRef, incomplete: number): string {
  const vars = { retiro: retreat.title, fechas: dateRange(retreat.start_date, retreat.end_date), n: incomplete };
  return incomplete === 1
    ? t('Hola a todos: para el retiro «{retiro}» ({fechas}) aún hay una persona con datos por completar. Abrid el enlace personal que os mandé; si no lo encontráis, decídmelo y os lo reenvío.', vars)
    : t('Hola a todos: para el retiro «{retiro}» ({fechas}) aún hay {n} personas con datos por completar. Abrid el enlace personal que os mandé; si no lo encontráis, decídmelo y os lo reenvío.', vars);
}

/** «Organizas este retiro», «Organizáis tú y Pablo», «Organizáis tú, Pablo y Lucía» (coorganizadores, §13.1). */
export function organizersLine(items: ReadonlyArray<{ display_name: string; me: boolean }>): string | null {
  if (!items.length) return null;
  const others = items.filter((o) => !o.me).map((o) => o.display_name);
  if (!others.length) return t('Organizas este retiro');
  const me = items.some((o) => o.me);
  const names = [...(me ? [t('tú')] : []), ...others];
  const list = names.length === 1 ? names[0]! : t('{lista} y {ultimo}', { lista: names.slice(0, -1).join(', '), ultimo: names[names.length - 1] });
  return me ? t('Organizáis {lista}', { lista: list }) : t('Organizan {lista}', { lista: list });
}

/** WhatsApp: al número si lo escribió el organizador (solo cifras; sin prefijo se asume España), si no a elegir contacto. */
export function whatsappUrl(text: string, phone?: string | null): string {
  let digits = (phone ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.length === 9) digits = `34${digits}`;
  return `https://wa.me/${digits.length >= 8 ? digits : ''}?text=${encodeURIComponent(text)}`;
}
