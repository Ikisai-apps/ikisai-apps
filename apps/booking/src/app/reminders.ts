/**
 * Textos de recordatorio para pedir datos pendientes a huéspedes y organizadores (docs/booking/API.md §16).
 * Funciones puras: la pantalla de Huéspedes las llama y copia el resultado al portapapeles.
 */
/** Igual que `FieldSource` del dominio (se repite aquí para que el módulo no dependa del alias del paquete). */
type FieldSource = 'guest' | 'organizer' | 'staff';

/** Etiquetas legibles de lo que devuelve `guestMissing` (`contact` = teléfono o correo). */
export const MISSING_LABELS: Record<string, string> = {
  first_name: 'nombre', last_name_1: 'primer apellido', last_name_2: 'segundo apellido', birth_date: 'fecha de nacimiento', residence_address: 'dirección',
  residence_postal_code: 'código postal', residence_city: 'municipio', residence_country: 'país', contact: 'teléfono o correo', kinship: 'parentesco',
  document_type: 'tipo de documento', document_number: 'número de documento', document_support_number: 'número de soporte',
  sex: 'sexo', nationality: 'nacionalidad', phone: 'teléfono', email: 'correo', guardian_name: 'persona que le acompaña',
  // Lo que añade el parte de llegada (`GET /ses/:id/pv`): no son campos del huésped.
  document_checked: 'documento comprobado', signature: 'firma',
};

export const SOURCE_LABELS: Record<FieldSource, string> = { guest: 'Huésped', organizer: 'Organizador', staff: 'Personal' };
export const SOURCE_TITLES: Record<FieldSource, string> = {
  guest: 'Lo rellenó el propio huésped desde su portal', organizer: 'Lo rellenó el organizador desde su portal', staff: 'Lo escribió el personal en Booking',
};

export const missingLabels = (keys: readonly string[]): string[] => keys.map((key) => MISSING_LABELS[key] ?? key);

/** «2026-07-12» → «12/07/2026» (sin pasar por Date: no depende de la zona horaria). */
export function esDate(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

/** «del 12/07/2026 al 18/07/2026»; vacío si la reserva no tiene fechas. */
export function datesPhrase(start: string | null | undefined, end: string | null | undefined): string {
  if (start && end) return `del ${esDate(start)} al ${esDate(end)}`;
  if (start) return `desde el ${esDate(start)}`;
  if (end) return `hasta el ${esDate(end)}`;
  return '';
}

export type ReminderGuest = Record<string, unknown>;

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Nombre completo para hablar con el propio huésped. */
export const guestFullName = (g: ReminderGuest): string => [g.first_name, g.last_name_1, g.last_name_2].map(text).filter(Boolean).join(' ');

/** «Ana G.»: nombre e inicial del primer apellido, para no repartir apellidos completos al organizador. */
export function nameAndInitial(g: ReminderGuest): string {
  const initial = text(g.last_name_1).charAt(0).toUpperCase();
  return [text(g.first_name), initial ? `${initial}.` : ''].filter(Boolean).join(' ') || 'Sin nombre';
}

const joinList = (items: string[]): string => (items.length > 1 ? `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}` : items[0] ?? '');

/** Texto para el propio huésped. `missing` son las claves de `guestMissing`; `unsigned` añade la firma del parte. */
export function guestReminder(input: { guest: ReminderGuest; title: string; start?: string | null; end?: string | null; missing: readonly string[]; unsigned: boolean }): string {
  const needs = [...missingLabels(input.missing), ...(input.unsigned ? ['la firma del parte de entrada'] : [])];
  const when = datesPhrase(input.start, input.end);
  const name = text(input.guest.first_name) || guestFullName(input.guest);
  return `Hola${name ? `, ${name}` : ''}: para tu estancia en ${input.title}${when ? ` ${when}` : ''} nos falta: ${joinList(needs)}. Puedes completarlo desde tu enlace personal.`;
}

/** Texto para el organizador con los huéspedes que tienen datos pendientes (nombre e inicial, sin detalle). */
export function organizerReminder(input: { contact: string | null | undefined; title: string; guests: readonly ReminderGuest[] }): string {
  const who = text(input.contact);
  const n = input.guests.length;
  const count = n === 1 ? '1 huésped tiene' : `${n} huéspedes tienen`;
  return `Hola${who ? `, ${who}` : ''}: de ${input.title}, ${count} datos pendientes: ${input.guests.map(nameAndInitial).join(', ')}. Pueden completarlos desde su enlace personal o puedes hacerlo tú desde el portal de organizadores.`;
}
