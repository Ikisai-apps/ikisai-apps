/**
 * Booking · proyección de una reserva en Google Calendar (docs/booking/API.md §7.3).
 * Regla pura: de las filas actuales de reserva y evento sale el estado deseado y el payload.
 * Nunca entran huéspedes, restricciones, importes ni notas internas.
 */

export const CALENDAR_TIME_ZONE = 'Europe/Madrid';
export const CALENDAR_SYNC_MARKER = '[[IKISAI_CALENDAR_SYNC]]';
export const CALENDAR_PUBLISHABLE_STATUSES = ['pre_reservada', 'confirmada', 'en_ejecucion'] as const;
/** `colorId` de Google: amarillo, verde y azul, los mismos que usaba el script legacy. */
export const CALENDAR_COLOR_BY_STATUS: Record<string, string> = { pre_reservada: '5', confirmada: '10', en_ejecucion: '9' };

export type CalendarDesired = 'present' | 'absent' | 'keep';

export interface CalendarReservation {
  id: string;
  code?: string | null;
  title: string;
  status: string;
  start_date?: string | null;
  end_date?: string | null;
  expected_guests?: number | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  meal_plan_requested?: string | null;
  menu_style_requested?: string | null;
  customer_notes?: string | null;
  archived_at?: string | null;
  deleted_at?: string | null;
}

export interface CalendarEvent {
  code?: string | null;
  deleted_at?: string | null;
  responsible_name?: string | null;
  arrival_time?: string | null;
  departure_time?: string | null;
  final_guests?: number | null;
  meal_plan_confirmed?: string | null;
  menu_style_confirmed?: string | null;
  setup_style?: string | null;
  rooms_count?: number | null;
  preparation_status?: string | null;
  accommodation_status?: string | null;
  kitchen_status?: string | null;
  cleaning_status?: string | null;
  operational_notes?: string | null;
}

export type CalendarMoment = { date: string } | { dateTime: string; timeZone: string };

export interface CalendarPayload {
  summary: string;
  description: string;
  colorId: string;
  start: CalendarMoment;
  end: CalendarMoment;
  extendedProperties: { private: { ikisaiReservationId: string; ikisaiReservationCode: string } };
}

export interface CalendarProjection {
  desired: CalendarDesired;
  /** Id determinista del evento en Google para esta reserva y generación. */
  eventId: string;
  payload?: CalendarPayload;
  /** SHA-256 del JSON estable del payload; si no cambia, no hace falta llamar a Google. */
  payloadHash?: string;
}

/** Marcador que identifica el evento de una reserva (sirve para adoptar eventos creados por el script legacy). */
export function calendarReservationMarker(code: string): string {
  return `[[ID_RESERVA=${code}]]`;
}

/** `iki` + uuid sin guiones + `g` + generación: solo caracteres válidos de base32hex (a-v, 0-9). */
export function calendarEventId(reservationId: string, generation = 1): string {
  return `iki${reservationId.replace(/-/g, '').toLowerCase()}g${generation}`;
}

/** Tabla de estado deseado de §7.3. Una reserva publicable sin fechas no se puede pintar: ausente. */
export function calendarDesired(reservation: CalendarReservation): CalendarDesired {
  if (reservation.deleted_at || reservation.archived_at) return 'absent';
  if (reservation.status === 'cerrada') return 'keep';
  if (!(CALENDAR_PUBLISHABLE_STATUSES as readonly string[]).includes(reservation.status)) return 'absent';
  return reservation.start_date && reservation.end_date ? 'present' : 'absent';
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** `17:00` o `17:00:00` → `17:00:00`; cualquier otra cosa, null. */
function clock(value: string | null | undefined): string | null {
  const m = typeof value === 'string' ? value.match(/^(\d{2}):(\d{2})(?::(\d{2}))?/) : null;
  return m ? `${m[1]}:${m[2]}:${m[3] ?? '00'}` : null;
}

function calendarDates(reservation: CalendarReservation, event: CalendarEvent | null): { start: CalendarMoment; end: CalendarMoment } {
  const startDate = reservation.start_date!;
  const endDate = reservation.end_date!;
  const arrival = clock(event?.arrival_time);
  const departure = clock(event?.departure_time);
  if (arrival && departure) {
    const start = `${startDate}T${arrival}`;
    let end = `${endDate}T${departure}`;
    if (end <= start) end = `${addDays(endDate, 1)}T${departure}`; // regla legacy
    return { start: { dateTime: start, timeZone: CALENDAR_TIME_ZONE }, end: { dateTime: end, timeZone: CALENDAR_TIME_ZONE } };
  }
  // Día completo: el fin es exclusivo en Google, así que +1 incluye el día de salida (decisión del usuario).
  return { start: { date: startDate }, end: { date: addDays(endDate, 1) } };
}

function line(label: string, value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  return `${label}: ${String(value)}`;
}

/** Valores de catálogo (`pension_completa`, `en_proceso`) en texto legible. Los códigos y el contacto no pasan por aquí. */
function pretty(value: string | null | undefined): string | null {
  return value ? value.replace(/_/g, ' ') : null;
}

function calendarDescription(reservation: CalendarReservation, event: CalendarEvent | null): string {
  const code = reservation.code ?? '';
  const blocks: (string | null)[][] = [
    [CALENDAR_SYNC_MARKER, calendarReservationMarker(code)],
    ['RESERVA', line('Código', code), line('Estado', pretty(reservation.status)),
      line('Contacto', [reservation.contact_name, reservation.contact_phone, reservation.contact_email].filter(Boolean).join(' · ')),
      line('Personas previstas', reservation.expected_guests), line('Personas finales', event?.final_guests)],
  ];
  if (event) {
    blocks.push(['OPERACIÓN', line('Código', event.code), line('Responsable', event.responsible_name),
      line('Llegada', clock(event.arrival_time)?.slice(0, 5)), line('Salida', clock(event.departure_time)?.slice(0, 5)),
      line('Montaje', pretty(event.setup_style)), line('Habitaciones', event.rooms_count),
      line('Preparación', pretty(event.preparation_status)), line('Alojamiento', pretty(event.accommodation_status)),
      line('Cocina', pretty(event.kitchen_status)), line('Limpieza', pretty(event.cleaning_status))]);
  }
  blocks.push(['ALIMENTACIÓN', line('Régimen solicitado', pretty(reservation.meal_plan_requested)), line('Régimen confirmado', pretty(event?.meal_plan_confirmed)),
    line('Tipo de menú', pretty(event?.menu_style_confirmed ?? reservation.menu_style_requested))]);
  const notes = [reservation.customer_notes, event?.operational_notes].filter((n): n is string => !!n && n.trim() !== '');
  if (notes.length) blocks.push(['NOTAS', ...notes]);
  return blocks
    .map((block) => block.filter((l): l is string => l !== null))
    .filter((block, index) => index === 0 || block.length > 1)
    .map((block) => block.join('\n'))
    .join('\n\n');
}

export function buildCalendarPayload(reservation: CalendarReservation, event: CalendarEvent | null): CalendarPayload {
  return {
    summary: reservation.status === 'pre_reservada' ? `[PRE] ${reservation.title}` : reservation.title,
    description: calendarDescription(reservation, event),
    colorId: CALENDAR_COLOR_BY_STATUS[reservation.status] ?? CALENDAR_COLOR_BY_STATUS.confirmada!,
    ...calendarDates(reservation, event),
    extendedProperties: { private: { ikisaiReservationId: reservation.id, ikisaiReservationCode: reservation.code ?? '' } },
  };
}

/** JSON con las claves ordenadas: el mismo payload da siempre el mismo texto. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 en hexadecimal con WebCrypto (Deno, navegador y Node 20). */
export async function calendarPayloadHash(payload: CalendarPayload): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(payload)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Estado deseado y payload de una reserva. Un evento en la papelera cuenta como que no hay evento.
 * Es asíncrona solo por el hash (WebCrypto).
 */
export async function calendarProjection(reservation: CalendarReservation, event: CalendarEvent | null | undefined, generation = 1): Promise<CalendarProjection> {
  const desired = calendarDesired(reservation);
  const eventId = calendarEventId(reservation.id, generation);
  if (desired !== 'present') return { desired, eventId };
  const payload = buildCalendarPayload(reservation, event && !event.deleted_at ? event : null);
  return { desired, eventId, payload, payloadHash: await calendarPayloadHash(payload) };
}
