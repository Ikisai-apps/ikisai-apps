/**
 * Ikisai Booking · datos de huéspedes para los portales Organizers y Guests (docs/booking/API.md §16).
 * `guestMissing` es la única fuente de qué se pide a cada huésped según el modo de la reserva; `booking.guest_missing`
 * (migración 0433) la replica en SQL para las lecturas de los portales y una prueba compara las dos.
 */
import { missingForSes, type GuestLike } from './guests.ts';

/**
 * Modo de la reserva: `ses` pide todo lo del registro de viajeros (y la firma); `operativo` (sin comunicar a SES) solo
 * nombre y contacto, además de alergias y dieta. Hoy todas van en `ses`; el interruptor llega con la propuesta de SES.
 */
export type GuestMode = 'ses' | 'operativo';

/** Campos de datos que se pueden rellenar desde los portales (igual que `booking.portal_guest_fields()`). */
export const PORTAL_GUEST_FIELDS = [
  'first_name', 'last_name_1', 'last_name_2', 'sex', 'document_type', 'document_number', 'document_support_number',
  'nationality', 'birth_date', 'residence_address', 'residence_postal_code', 'residence_city', 'residence_country', 'phone', 'email',
  'is_minor', 'guardian_name', 'kinship',
] as const;

/** Campos que solo puede cambiar el propio huésped desde Guests. */
export const GUEST_ONLY_FIELDS = ['allergies_visible_to_organizer', 'privacy_ack_at', 'privacy_ack_version'] as const;

export type FieldSource = 'guest' | 'organizer' | 'staff';

const filled = (value: unknown): boolean => value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');

/** Lo que falta para dar al huésped por completo en ese modo (`contact` = teléfono o correo). */
export function guestMissing(guest: GuestLike, mode: GuestMode = 'ses'): string[] {
  if (mode === 'operativo') {
    const missing: string[] = [];
    if (!filled(guest.first_name)) missing.push('first_name');
    if (!filled(guest.phone) && !filled(guest.email)) missing.push('contact');
    return missing;
  }
  return missingForSes(guest);
}

export interface Completeness { complete: boolean; missing: string[]; signed: boolean; needsSignature: boolean }

/** Completitud de un huésped: datos y, en modo `ses`, la firma del parte. */
export function guestCompleteness(guest: GuestLike & { signed_at?: string | null }, mode: GuestMode = 'ses'): Completeness {
  const missing = guestMissing(guest, mode);
  const needsSignature = mode === 'ses';
  const signed = filled(guest.signed_at);
  return { complete: missing.length === 0 && (!needsSignature || signed), missing, signed, needsSignature };
}

/** Totales de una reserva para el personal. */
export function reservationCompleteness(guests: ReadonlyArray<GuestLike & { signed_at?: string | null; deleted_at?: string | null }>, mode: GuestMode = 'ses') {
  const live = guests.filter((g) => !g.deleted_at);
  const each = live.map((g) => guestCompleteness(g, mode));
  return {
    total: live.length,
    complete: each.filter((c) => c.complete).length,
    missingData: each.filter((c) => c.missing.length > 0).length,
    unsigned: each.filter((c) => c.needsSignature && !c.signed).length,
  };
}

/** Quién escribió un campo (de `field_sources`); null si nadie lo ha rellenado. */
export function fieldSource(guest: { field_sources?: Record<string, { by?: string }> | null }, field: string): FieldSource | null {
  const by = guest.field_sources?.[field]?.by;
  return by === 'guest' || by === 'organizer' || by === 'staff' ? by : null;
}
