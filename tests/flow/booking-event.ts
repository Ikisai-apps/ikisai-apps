/**
 * Flow · evento sintético de Booking para las pruebas que ligan un flujo a un evento: desde FL4 (0925) el evento tiene que
 * existir en Booking y quien lo liga, ser miembro de Booking o del personal del evento.
 */
type Db = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function seedBookingEvent(db: Db, eventId: string, members: string[] = []): Promise<void> {
  const reservation = crypto.randomUUID();
  await db.query(`insert into booking.reservations (id, title, status, start_date, end_date, expected_guests, requires_meals, meal_plan_requested, menu_style_requested)
    values ($1, 'Encuentro de prueba', 'confirmada', '2026-10-30', '2026-11-01', 20, true, 'pension_completa', 'vegetariano')`, [reservation]);
  await db.query(`insert into booking.events (id, reservation_id) values ($1, $2)`, [eventId, reservation]);
  for (const user of members) await db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'reader') on conflict do nothing`, [user]);
}

/** Huéspedes sintéticos de un evento de Booking: desde FL12 (0935) Flow solo numera y marca huéspedes del evento. */
export async function seedBookingGuests(db: Db, eventId: string, guestIds: string[]): Promise<void> {
  for (const id of guestIds) await db.query(`insert into booking.guests (id, event_id, first_name, last_name_1) values ($1, $2, 'Huésped', 'Prueba')`, [id, eventId]);
}
