/** Textos para compartir y copiar (API.md §9.4 a §9.6). Sin datos de otras personas en lo que se pega en grupos. */
import type { GuestMode } from '@ikisai/domain-booking';
import { dateRange, missingText } from './labels.ts';

export interface RetreatRef { title: string; start_date: string | null; end_date: string | null }

/** Mensaje con el enlace personal de un asistente. */
export function linkMessage(name: string, retreat: RetreatRef, url: string, mode: GuestMode): string {
  const legal = mode === 'ses' ? ' Son los datos que exige el registro de viajeros.' : '';
  return `Hola, ${name}: este es tu enlace personal para el retiro «${retreat.title}» en Ikisai (${dateRange(retreat.start_date, retreat.end_date)}). Ábrelo para completar tus datos antes de llegar.${legal} ${url}`;
}

/** Recordatorio para una persona: lo que le falta y, si se acaba de generar, su enlace. */
export function personReminder(name: string, retreat: RetreatRef, missing: readonly string[], needsSignature: boolean, url?: string | null): string {
  const pending: string[] = [];
  if (missing.length) pending.push(`completar ${missingText(missing)}`);
  if (needsSignature) pending.push('firmar el registro de viajeros');
  const what = pending.length ? `te falta ${pending.join(' y ')}` : 'ya lo tienes todo listo, ¡gracias!';
  const link = url ? ` Tu enlace: ${url}` : ' Usa el enlace personal que te envié; si no lo encuentras, dímelo y te lo reenvío.';
  return `Hola, ${name}: para el retiro «${retreat.title}» (${dateRange(retreat.start_date, retreat.end_date)}) ${what}.${pending.length ? link : ''}`;
}

/** Recordatorio para el grupo: sin nombres, se pega en grupos de WhatsApp. */
export function groupReminder(retreat: RetreatRef, incomplete: number): string {
  const who = incomplete === 1 ? 'hay una persona' : `hay ${incomplete} personas`;
  return `Hola a todos: para el retiro «${retreat.title}» (${dateRange(retreat.start_date, retreat.end_date)}) aún ${who} con datos por completar. Abrid el enlace personal que os mandé; si no lo encontráis, decídmelo y os lo reenvío.`;
}

/** «Organizas este retiro», «Organizáis tú y Pablo», «Organizáis tú, Pablo y Lucía» (coorganizadores, §13.1). */
export function organizersLine(items: ReadonlyArray<{ display_name: string; me: boolean }>): string | null {
  if (!items.length) return null;
  const others = items.filter((o) => !o.me).map((o) => o.display_name);
  if (!others.length) return 'Organizas este retiro';
  const names = [...(items.some((o) => o.me) ? ['tú'] : []), ...others];
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return items.some((o) => o.me) ? `Organizáis ${list}` : `Organizan ${list}`;
}

/** WhatsApp: al número si lo escribió el organizador (solo cifras; sin prefijo se asume España), si no a elegir contacto. */
export function whatsappUrl(text: string, phone?: string | null): string {
  let digits = (phone ?? '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  else if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.length === 9) digits = `34${digits}`;
  return `https://wa.me/${digits.length >= 8 ? digits : ''}?text=${encodeURIComponent(text)}`;
}
