/**
 * Booking · adaptador de calendario. El worker solo conoce esta interfaz: el cliente real de Google
 * (`google.ts`, pendiente) y el adaptador en memoria de las pruebas la cumplen por igual.
 */
import { calendarReservationMarker, type CalendarPayload } from '../../_domain/booking/mod.ts';

export interface CalendarRemoteEvent {
  id: string;
  htmlLink: string | null;
}

/**
 * Error tipado del adaptador. `recoverable` decide entre reintento con espera (red, 5xx, 429, tiempo agotado)
 * y error definitivo (petición rechazada). `code` es un código corto sin datos personales.
 */
export class CalendarError extends Error {
  /**
   * `blocked`: el fallo no es del trabajo sino del acceso (credenciales rechazadas, calendario sin compartir).
   * El trabajo sigue pendiente sin gastar intentos y el tick deja de llamar al calendario hasta la siguiente vuelta.
   */
  constructor(public readonly code: string, public readonly recoverable: boolean, public readonly blocked = false) {
    super(code);
    this.name = 'CalendarError';
  }
}
export const recoverableError = (code: string) => new CalendarError(code, true);
export const fatalError = (code: string) => new CalendarError(code, false);
export const blockedError = (code: string) => new CalendarError(code, true, true);

export interface CalendarAdapter {
  /** Identificador del calendario de destino (se guarda en `calendar_links.calendar_id`). */
  readonly calendarId: string;
  /** Crea el evento con ese id o lo actualiza si ya existe (un 409 al crear se convierte en actualización). */
  upsert(eventId: string, payload: CalendarPayload): Promise<CalendarRemoteEvent>;
  /** Borra el evento. Que ya no exista no es un error. */
  remove(eventId: string): Promise<void>;
  /** Busca un evento con el marcador `[[ID_RESERVA=<code>]]` para adoptarlo en la primera sincronización. */
  findByMarker(reservationCode: string): Promise<CalendarRemoteEvent | null>;
}

export interface FakeCalendarAdapter extends CalendarAdapter {
  events: Map<string, CalendarPayload>;
  calls: { upsert: number; remove: number; findByMarker: number };
  /** Los próximos `times` usos de `upsert` o `remove` fallan con ese error. */
  failNext(error: CalendarError, times?: number): void;
  reset(): void;
}

/** Adaptador en memoria para pruebas: guarda eventos, cuenta llamadas y permite inyectar fallos. */
export function createFakeCalendarAdapter(calendarId = 'fake-calendar'): FakeCalendarAdapter {
  const events = new Map<string, CalendarPayload>();
  const calls = { upsert: 0, remove: 0, findByMarker: 0 };
  let failure: { error: CalendarError; times: number } | null = null;
  const maybeFail = () => {
    if (!failure) return;
    const { error } = failure;
    if (--failure.times <= 0) failure = null;
    throw error;
  };
  const remote = (id: string): CalendarRemoteEvent => ({ id, htmlLink: `https://calendar.invalid/event?eid=${id}` });
  return {
    calendarId, events, calls,
    async upsert(eventId, payload) {
      calls.upsert++;
      maybeFail();
      events.set(eventId, structuredClone(payload));
      return remote(eventId);
    },
    async remove(eventId) {
      calls.remove++;
      maybeFail();
      events.delete(eventId);
    },
    async findByMarker(reservationCode) {
      calls.findByMarker++;
      const marker = calendarReservationMarker(reservationCode);
      for (const [id, payload] of events) if (payload.description.includes(marker)) return remote(id);
      return null;
    },
    failNext(error, times = 1) { failure = { error, times }; },
    reset() { events.clear(); failure = null; calls.upsert = 0; calls.remove = 0; calls.findByMarker = 0; },
  };
}
