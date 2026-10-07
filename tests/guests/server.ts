/**
 * Guests · servidor HTTP para las pruebas de interfaz: la `guests-api` real sobre PGlite con el Supabase simulado del
 * test-kit, junto a la `booking-api` (el personal crea y confirma reservas, da de alta huéspedes y emite sus enlaces). Sin
 * API falsa: lo que ve la pantalla es lo que responden las Edge.
 */
import { createServer, type Server } from 'node:http';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createGuestsApp, GUESTS_ORIGINS } from '../../supabase/functions/guests-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

export interface GuestsTestServer {
  url: string;
  booking: TestApp;
  /** Reserva confirmada (con su evento); `ses: false` la deja en modo operativo. Devuelve reserva y evento. */
  reservation(options: { title: string; start?: string; end?: string; ses?: boolean; arrival?: string }): Promise<{ id: string; event: string }>;
  /** Huésped dado de alta por el personal (procedencia «staff»). */
  guest(event: string, fields: Record<string, unknown>): Promise<string>;
  /** El organizador escribe datos del huésped desde Organizers (procedencia «organizer»). */
  organizerWrites(reservationId: string, guestId: string, fields: Record<string, unknown>): Promise<void>;
  /** Enlace del huésped emitido por el personal de Booking; devuelve el token de `/i/<token>`. */
  guestLink(reservationId: string, guestId: string, name: string, email?: string): Promise<string>;
  /** Fila del huésped en Booking (para comprobar lo guardado). */
  row(guestId: string): Promise<Record<string, any>>;
  /** Simula la caída de la API (sin red para la app). */
  setOffline(on: boolean): void;
  close(): Promise<void>;
}

const uuid = () => crypto.randomUUID();

export async function startGuestsServer(): Promise<GuestsTestServer> {
  const origin = GUESTS_ORIGINS[0]!;
  const booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const guests = createGuestsApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, origins: [origin], release: 'test' });
  let seq = 0;
  let offline = false;

  async function commit(operations: unknown[]): Promise<void> {
    const res = await booking.call('/api/v1/commands', { body: { requestId: `ui-${++seq}-${uuid()}`, operations } });
    if (res.status !== 200) throw new Error(`commit ${res.status}: ${JSON.stringify(res.data)}`);
  }

  const server: Server = createServer(async (req, res) => {
    try {
      if (offline) { req.destroy(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'content-length') headers.set(key, value);
      // El proxy de `vite preview` conserva el Origin del navegador: la Edge solo admite el de producción.
      headers.set('Origin', origin);
      const response = await guests(new Request(`${booking.supabase.url}/functions/v1/guests-api${req.url ?? '/'}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'TEST_SERVER', message: String(error), details: null } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    booking,
    async reservation({ title, start = '2027-03-12', end = '2027-03-15', ses = true, arrival }) {
      const id = uuid(); const event = uuid();
      await commit([{ op: 'insert', table: TABLES.reservations, id, fields: {
        title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 12,
        ...(ses ? {} : { ses_enabled: false, ses_disabled_reason: 'uso_privado', collect_guest_data: true }),
      } }]);
      await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: event, from_status: 'pre_reservada' } }]);
      if (arrival) await booking.t.db.query('update booking.events set arrival_time = $2 where id = $1', [event, arrival]);
      return { id, event };
    },
    async guest(event, fields) {
      const id = uuid();
      await commit([{ op: 'insert', table: TABLES.guests, id, fields: { event_id: event, ...fields } }]);
      return id;
    },
    async organizerWrites(reservationId, guestId, fields) {
      const user = await booking.t.createUser();
      await booking.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`,
        [user, JSON.stringify({ grants: [{ reservation_id: reservationId }] })]);
      await booking.t.rpc('core_invoke', { p_app: 'organizers', p_actor: user, p_name: 'booking.portal_update_guest', p_args: { guest_id: guestId, fields, declaration: true } });
    },
    async guestLink(reservationId, guestId, name, email) {
      const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'guests', scope: { reservation_id: reservationId, guest_id: guestId }, person: { name, ...(email ? { email } : {}) } } });
      if (link.status !== 200) throw new Error(`portal-links ${link.status}: ${JSON.stringify(link.data)}`);
      return link.data.url.split('/i/')[1];
    },
    async row(guestId) {
      return (await booking.t.db.query<Record<string, any>>('select * from booking.guests where id = $1', [guestId])).rows[0]!;
    },
    setOffline(on) { offline = on; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booking.close();
    },
  };
}
