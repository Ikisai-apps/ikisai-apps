/**
 * Booking · cliente real de Google Calendar con cuenta de servicio (docs/booking/API.md §7.3).
 *
 * Se activa solo si existen los dos secretos: `GOOGLE_SERVICE_ACCOUNT_JSON` (clave JSON de la cuenta de servicio)
 * y `BOOKING_CALENDAR_ID`. Sin ellos devuelve null y la integración queda apagada (`health: 'not_configured'`).
 *
 * Autenticación: JWT RS256 firmado con WebCrypto, cambiado por un token de acceso que se guarda en memoria hasta
 * poco antes de caducar. Nunca se escribe en registros nada de la clave ni del token.
 *
 * Errores, en los tres tipos que entiende el worker:
 * - recuperable (red, tiempo agotado, 5xx, 429): reintento con espera creciente;
 * - bloqueo (credenciales rechazadas, calendario sin compartir o solo de lectura): el trabajo sigue pendiente
 *   y el tick no hace más llamadas; lo arregla una persona, no un reintento;
 * - definitivo (petición rechazada por Google): el trabajo queda en error.
 */
import { calendarReservationMarker, type CalendarPayload } from '../../_domain/booking/mod.ts';
import { blockedError, fatalError, recoverableError, type CalendarAdapter, type CalendarRemoteEvent } from './adapter.ts';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const API = 'https://www.googleapis.com/calendar/v3';
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export interface GoogleCalendarConfig {
  /** Contenido de `GOOGLE_SERVICE_ACCOUNT_JSON`. */
  serviceAccountJson?: string;
  /** Contenido de `BOOKING_CALENDAR_ID`. */
  calendarId?: string;
  /** Inyectables para pruebas. */
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface ApiResponse {
  status: number;
  body: any;
}

const base64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const encodeJson = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** Clave privada PKCS#8 en PEM → CryptoKey para firmar RS256. */
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

function parseServiceAccount(raw: string | undefined): { clientEmail: string; privateKey: string } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string' || !parsed.private_key.includes('PRIVATE KEY')) return null;
    return { clientEmail: parsed.client_email, privateKey: parsed.private_key };
  } catch {
    return null;
  }
}

/** ¿El 403 es un límite de uso (recuperable) y no un problema de permisos? */
function isRateLimit(body: any): boolean {
  const reasons: string[] = Array.isArray(body?.error?.errors) ? body.error.errors.map((e: any) => String(e?.reason ?? '')) : [];
  return reasons.some((reason) => /rateLimitExceeded|quotaExceeded/i.test(reason));
}

/** Devuelve el adaptador, o null si falta alguno de los dos secretos o la clave no es válida. */
export function createGoogleCalendarAdapter(config: GoogleCalendarConfig): CalendarAdapter | null {
  const account = parseServiceAccount(config.serviceAccountJson);
  const calendarId = config.calendarId?.trim();
  if (!account || !calendarId) return null;

  const transport = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const calendarUrl = `${API}/calendars/${encodeURIComponent(calendarId)}`;
  let key: Promise<CryptoKey> | null = null;
  let token: { value: string; expiresAt: number } | null = null;

  async function send(url: string, init: RequestInit): Promise<ApiResponse> {
    let response: Response;
    try {
      response = await transport(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw recoverableError('GOOGLE_UNREACHABLE');
    }
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, body };
  }

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt - 60_000 > now()) return token.value;
    const iat = Math.floor(now() / 1000);
    const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({ iss: account!.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    let signature: ArrayBuffer;
    try {
      key ??= importPrivateKey(account!.privateKey);
      signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await key, new TextEncoder().encode(unsigned));
    } catch {
      key = null;
      throw blockedError('GOOGLE_AUTH_ERROR');
    }
    const assertion = `${unsigned}.${base64url(new Uint8Array(signature))}`;
    const { status, body } = await send(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (status >= 500 || status === 429) throw recoverableError('GOOGLE_TOKEN_UNAVAILABLE');
    if (status !== 200 || typeof body?.access_token !== 'string') throw blockedError('GOOGLE_AUTH_ERROR');
    token = { value: body.access_token, expiresAt: now() + Number(body.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  /** Llamada a la API de Calendar. Traduce lo que es igual para todas las rutas; 403, 404, 409 y 410 los decide quien llama. */
  async function call(method: string, path: string, payload?: unknown): Promise<ApiResponse> {
    const bearer = await accessToken();
    const result = await send(calendarUrl + path, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    if (result.status === 401) {
      token = null;
      throw blockedError('GOOGLE_AUTH_ERROR');
    }
    if (result.status === 429 || result.status >= 500 || (result.status === 403 && isRateLimit(result.body))) throw recoverableError('GOOGLE_BUSY');
    return result;
  }

  /**
   * Un 403 o un 404 pueden deberse al evento o al calendario. Se pregunta por el calendario: si la cuenta de servicio
   * no lo ve, es que no está compartido con ella; si lo ve pero no puede escribir, está compartido solo para lectura.
   */
  async function explainDenied(status: number): Promise<never> {
    const calendar = await call('GET', '');
    if (calendar.status !== 200) throw blockedError('CALENDAR_NOT_SHARED');
    if (status === 403) throw blockedError('CALENDAR_READ_ONLY');
    throw fatalError('GOOGLE_NOT_FOUND');
  }

  const remote = (body: any, fallbackId: string): CalendarRemoteEvent => ({ id: typeof body?.id === 'string' ? body.id : fallbackId, htmlLink: typeof body?.htmlLink === 'string' ? body.htmlLink : null });

  return {
    calendarId,

    async upsert(eventId, payload: CalendarPayload) {
      // `status: confirmed` reactiva un evento que alguien borró a mano en Google (queda como cancelado, no desaparece).
      const body = { ...payload, status: 'confirmed' };
      const path = `/events/${encodeURIComponent(eventId)}`;
      const updated = await call('PUT', path, body);
      if (updated.status === 200) return remote(updated.body, eventId);
      if (updated.status === 403) return explainDenied(403);
      if (updated.status !== 404 && updated.status !== 410) throw fatalError(`GOOGLE_HTTP_${updated.status}`);

      const created = await call('POST', '/events', { id: eventId, ...body });
      if (created.status === 200) return remote(created.body, eventId);
      // El id existe pero no se deja actualizar ni crear: el worker lo resuelve subiendo la generación.
      if (created.status === 409) throw fatalError('EVENT_ID_TAKEN');
      if (created.status === 403 || created.status === 404) return explainDenied(created.status);
      throw fatalError(`GOOGLE_HTTP_${created.status}`);
    },

    async remove(eventId) {
      const { status } = await call('DELETE', `/events/${encodeURIComponent(eventId)}`);
      if (status === 204 || status === 200 || status === 410) return;
      if (status === 404) {
        // Evento inexistente cuenta como borrado, salvo que lo inexistente (para nosotros) sea el calendario.
        const calendar = await call('GET', '');
        if (calendar.status !== 200) throw blockedError('CALENDAR_NOT_SHARED');
        return;
      }
      if (status === 403) return explainDenied(403);
      throw fatalError(`GOOGLE_HTTP_${status}`);
    },

    async findByMarker(reservationCode) {
      const marker = calendarReservationMarker(reservationCode);
      const query = new URLSearchParams({
        q: reservationCode, singleEvents: 'true', showDeleted: 'false', maxResults: '25',
        timeMin: new Date(now() - YEAR_MS).toISOString(), timeMax: new Date(now() + YEAR_MS).toISOString(),
      });
      const { status, body } = await call('GET', `/events?${query}`);
      if (status === 403 || status === 404) return explainDenied(status);
      if (status !== 200) throw fatalError(`GOOGLE_HTTP_${status}`);
      const items: any[] = Array.isArray(body?.items) ? body.items : [];
      const found = items.find((item) => typeof item?.description === 'string' && item.description.includes(marker) && item.status !== 'cancelled');
      return found ? remote(found, String(found.id)) : null;
    },
  };
}
