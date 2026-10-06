/**
 * Ikisai Booking · reglas de huéspedes: acceso por ámbito, qué falta para comunicar a SES.Hospedajes y quién firma.
 * Las condiciones de obligatoriedad salen de la especificación del servicio web `MIR-HOSPE-DSI-WS` v3.1.2
 * (docs/booking/API.md §2.3). Son reglas y no `check` para poder ajustarlas sin migración.
 */
import { dayNumber } from './rules.ts';
import type { Role } from './validate.ts';

/** `core.memberships.scopes` de Booking: `{ "guests": true }` designa a un editor como responsable de huéspedes. */
export function canSeeGuests(membership: { role: Role; scopes?: unknown }): boolean {
  if (membership.role === 'owner') return true;
  if (membership.role !== 'editor') return false;
  const scopes = membership.scopes;
  return typeof scopes === 'object' && scopes !== null && (scopes as Record<string, unknown>).guests === true;
}

export interface GuestLike {
  first_name?: string | null;
  last_name_1?: string | null;
  last_name_2?: string | null;
  document_type?: string | null;
  document_number?: string | null;
  document_support_number?: string | null;
  birth_date?: string | null;
  residence_address?: string | null;
  residence_postal_code?: string | null;
  residence_city?: string | null;
  residence_country?: string | null;
  phone?: string | null;
  email?: string | null;
  is_minor?: boolean | null;
  kinship?: string | null;
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/**
 * Campos que faltan para que SES.Hospedajes acepte al viajero. `contact` representa «teléfono o correo».
 * Nacionalidad y sexo son opcionales en la plataforma y no bloquean.
 */
export function missingForSes(guest: GuestLike): string[] {
  const missing: string[] = [];
  const need = (field: keyof GuestLike) => { if (!filled(guest[field])) missing.push(field); };
  need('first_name');
  need('last_name_1');
  need('birth_date');
  need('residence_address');
  need('residence_postal_code');
  need('residence_city');
  need('residence_country');
  if (!filled(guest.phone) && !filled(guest.email)) missing.push('contact');
  if (guest.is_minor) {
    need('kinship');
  } else {
    need('document_type');
    need('document_number');
  }
  if (guest.document_type === 'DNI') need('last_name_2');
  if (guest.document_type === 'DNI' || guest.document_type === 'NIE') need('document_support_number');
  return missing;
}

/** Edad cumplida en `onDate` (AAAA-MM-DD); null si falta o es inválida alguna fecha. */
export function ageOn(birthDate: string | null | undefined, onDate: string): number | null {
  if (dayNumber(birthDate) === null || dayNumber(onDate) === null) return null;
  const [by, bm, bd] = (birthDate as string).split('-').map(Number) as [number, number, number];
  const [y, m, d] = onDate.split('-').map(Number) as [number, number, number];
  const age = y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
  return age < 0 ? null : age;
}

/** Edad a partir de la cual el huésped firma su propio parte. Criterio por defecto, sin verificar en el BOE. */
export const OWN_SIGNATURE_MIN_AGE = 14;

/** ¿Firma el propio huésped (true) o su acompañante (false)? Sin fecha de nacimiento manda `is_minor`. */
export function signsOwnEntry(guest: Pick<GuestLike, 'birth_date' | 'is_minor'>, onDate: string): boolean {
  const age = ageOn(guest.birth_date, onDate);
  if (age === null) return !guest.is_minor;
  return age >= OWN_SIGNATURE_MIN_AGE;
}
