/**
 * Ikisai Booking · datos de huéspedes para los portales Organizers y Guests (docs/booking/API.md §16).
 * `guestMissing` es la única fuente de qué se pide a cada huésped según el modo de la reserva; `booking.guest_missing`
 * (migración 0433) la replica en SQL para las lecturas de los portales y una prueba compara las dos.
 */
import { missingForSes, type GuestLike } from './guests.ts';

/**
 * Modo de la reserva (API.md §17.1): `ses` pide todo lo del registro de viajeros (y la firma); `operativo` (sin comunicar a
 * SES, pidiendo datos) solo nombre y contacto, además de alergias y dieta; `ninguno`, sin lista de huéspedes.
 */
export type GuestMode = 'ses' | 'operativo' | 'ninguno';

/** Modo según los interruptores de la reserva (igual que `booking.guest_mode`). */
export function guestModeOf(reservation: { ses_enabled?: boolean | null; collect_guest_data?: boolean | null } | null | undefined): GuestMode {
  if (!reservation || reservation.ses_enabled !== false) return 'ses';
  return reservation.collect_guest_data === false ? 'ninguno' : 'operativo';
}

/** Campos que se piden sin SES (minimización: ni documento, ni dirección, ni fecha de nacimiento, ni firma). */
export const OPERATIVE_GUEST_FIELDS = ['first_name', 'last_name_1', 'phone', 'email'] as const;

/** Motivos para no comunicar una reserva a SES. */
export const SES_DISABLED_REASONS = ['uso_privado', 'prueba', 'otro'] as const;

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
  if (mode === 'ninguno') return [];
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

/**
 * Parentesco de un menor con su acompañante: códigos del catálogo de SES (instrucciones §8.3). Guests guarda el código y
 * muestra la etiqueta traducida; el texto libre antiguo se sigue aceptando y se convierte al enviar a SES (`kinshipCode`).
 */
export const KINSHIP_CODES = {
  PM: 'Padre o madre', TU: 'Tutor o tutora legal', AB: 'Abuelo o abuela', HR: 'Hermano o hermana', TI: 'Tío o tía',
  CY: 'Cónyuge', HJ: 'Hijo o hija', NI: 'Nieto o nieta', SB: 'Sobrino o sobrina', CD: 'Cuñado o cuñada', SG: 'Suegro o suegra',
  YN: 'Yerno o nuera', BA: 'Bisabuelo o bisabuela', BN: 'Bisnieto o bisnieta', OT: 'Otro',
} as const;
export type KinshipCode = keyof typeof KINSHIP_CODES;

/** Etiqueta legible de un parentesco guardado como código; el texto libre antiguo se devuelve tal cual. */
export function kinshipLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  return (KINSHIP_CODES as Record<string, string>)[value.trim().toUpperCase()] ?? value;
}
