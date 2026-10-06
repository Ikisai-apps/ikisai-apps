/** Food · apoyo de pruebas: eventos sintéticos sembrados en Booking, que Food lee por `booking.food_event_projection`. */
import type { TestApp } from '../../packages/test-kit/src/http.ts';

export const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

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
