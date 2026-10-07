/** Food · apoyo de pruebas: eventos sintéticos sembrados en Booking, que Food lee por `booking.food_event_projection`. */
import { createServer } from 'node:net';
import type { TestApp } from '../../packages/test-kit/src/http.ts';

/** Zona de la casa: el servidor cuenta los días en hora de Madrid, y las pruebas de navegador fijan la misma zona. */
export const TIME_ZONE = 'Europe/Madrid';
const MADRID_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });

/**
 * Fecha AAAA-MM-DD de hoy + `offset` días en hora de Madrid. En UTC, entre las 00:00 y las 02:00 de Madrid saldría el día
 * anterior y las pruebas que comparan con «hoy» del servidor fallarían cada noche.
 */
export const day = (offset: number) => MADRID_DATE.format(new Date(Date.now() + offset * 86400000));

export interface SeedRestriction {
  type: string;
  subject?: string;
  severity?: string;
  servings: number;
}

/** Crea en Booking una reserva confirmada con su evento operativo y sus restricciones. Devuelve el id del evento. */
export async function seedBookingEvent(app: TestApp, options: { title: string; start: string; end: string; restrictions?: SeedRestriction[] }): Promise<string> {
  const reservation = crypto.randomUUID();
  const event = crypto.randomUUID();
  await app.t.db.query(
    `insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
     values ($1, $2, 'confirmada', $3, $4, 20, true, 'pension_completa', 'vegetariano')`,
    [reservation, options.title, options.start, options.end]);
  await app.t.db.query(
    `insert into booking.events (id, reservation_id, final_guests, arrival_time, departure_time) values ($1, $2, 22, '17:00', '12:00')`,
    [event, reservation]);
  for (const r of options.restrictions ?? []) {
    await app.t.db.query(
      `insert into booking.dietary_restrictions (event_id, restriction_type, subject, severity, servings) values ($1, $2, $3, $4, $5)`,
      [event, r.type, r.subject ?? null, r.severity ?? null, r.servings]);
  }
  return event;
}

/** Booking fija el número final de personas: avanza la revisión que ve cocina. */
export async function setFinalGuests(app: TestApp, event: string, guests: number): Promise<void> {
  await app.t.db.query(`update booking.events set final_guests = $2 where id = $1`, [event, guests]);
}

/**
 * Puerto libre pedido al sistema para `vite preview` (receta de Booking). Un puerto al azar puede caer en un rango
 * reservado de Windows (`listen EACCES`) o en uno que Chromium bloquea (`ERR_UNSAFE_PORT`); los efímeros del sistema no.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

