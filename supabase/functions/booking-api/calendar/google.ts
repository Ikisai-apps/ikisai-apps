/**
 * Booking · cliente real de Google Calendar. ESQUELETO: todavía no hay cuenta de servicio.
 *
 * Mientras `createGoogleCalendarAdapter` devuelva null, la integración queda apagada: el tick responde
 * `health: 'not_configured'` y los trabajos esperan en `pending` (docs/booking/API.md §7.3).
 *
 * TODO (cuando exista la clave de la cuenta de servicio):
 * 1. Leer el secreto `GOOGLE_SERVICE_ACCOUNT_JSON` (client_email y private_key) y `BOOKING_CALENDAR_ID`.
 * 2. Firmar un JWT RS256 con WebCrypto (iss = client_email, scope = https://www.googleapis.com/auth/calendar.events,
 *    aud = https://oauth2.googleapis.com/token, exp = iat + 3600).
 * 3. Cambiarlo por un token de acceso en `POST https://oauth2.googleapis.com/token` y guardarlo en memoria hasta poco antes de caducar.
 * 4. Llamadas a la API v3 con tiempo máximo:
 *    - upsert: `POST /calendars/{calendarId}/events` con `id` elegido; si responde 409, `PUT /events/{id}`.
 *      Si el evento fue borrado a mano (status cancelled), intentar reactivarlo; si no se puede, generation + 1.
 *    - remove: `DELETE /events/{id}`; 404 y 410 cuentan como borrado.
 *    - findByMarker: `GET /events?q=[[ID_RESERVA=<code>]]&timeMin=&timeMax=` (±1 año) y comprobar el marcador en la descripción.
 * 5. Traducir errores: red, 5xx, 429 y tiempo agotado → `recoverableError(...)`; 401, 403 y 404 del calendario → `fatalError(...)`.
 * 6. Prueba real sobre el calendario «Agram Camp - Reservas» (API.md §11.2).
 */
import type { CalendarAdapter } from './adapter.ts';

export interface GoogleCalendarConfig {
  /** Contenido de `GOOGLE_SERVICE_ACCOUNT_JSON`. */
  serviceAccountJson?: string;
  /** Contenido de `BOOKING_CALENDAR_ID`. */
  calendarId?: string;
}

/** Devuelve null mientras el cliente no esté implementado, también si llegan credenciales: nada se marca como sincronizado. */
export function createGoogleCalendarAdapter(_config: GoogleCalendarConfig): CalendarAdapter | null {
  return null;
}
