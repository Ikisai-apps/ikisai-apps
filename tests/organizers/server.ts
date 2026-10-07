/**
 * Organizers · servidor HTTP para las pruebas de interfaz: la `organizers-api` real sobre PGlite con el Supabase simulado del
 * test-kit, junto a la `booking-api` (el personal crea y confirma reservas y emite el enlace del organizador). Sin API falsa:
 * lo que ve la pantalla es lo que responden las Edge.
 */
import { createServer, type Server } from 'node:http';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

export interface OrganizersTestServer {
  url: string;
  booking: TestApp;
  /** Reserva nueva (`confirm` crea su evento). */
  reservation(options: { title: string; confirm: boolean; start?: string; end?: string; guests?: number; ses?: boolean }): Promise<string>;
  /** Enlace del organizador emitido por el personal de Booking; devuelve el token de `/i/<token>`. */
  organizerLink(reservations: string[], email: string, name?: string): Promise<string>;
  /** El propio huésped escribe datos desde Guests (procedencia «guest»). */
  guestWrites(reservationId: string, guestId: string, fields: Record<string, unknown>, consent?: boolean): Promise<void>;
  /** Simula la caída de la API (sin red para la app). */
  setOffline(on: boolean): void;
  close(): Promise<void>;
}

const uuid = () => crypto.randomUUID();

export async function startOrganizersServer(): Promise<OrganizersTestServer> {
  const origin = ORGANIZERS_ORIGINS[0]!;
  const booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, origins: [origin], release: 'test' });
  // Textos legales y de contacto de Central (#281): en producción los siembra la migración; aquí, a mano.
  await booking.t.db.query('select central.seed_texts()');
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
      const response = await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api${req.url ?? '/'}`, {
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
    async reservation({ title, confirm, start = '2027-03-12', end = '2027-03-15', guests = 12, ses = true }) {
      const id = uuid();
      await commit([{ op: 'insert', table: TABLES.reservations, id, fields: {
        title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: guests, meal_plan_requested: 'pension_completa', menu_style_requested: 'vegetariano',
        ...(ses ? {} : { ses_enabled: false, ses_disabled_reason: 'uso_privado', collect_guest_data: true }),
      } }]);
      if (confirm) await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
      return id;
    },
    async organizerLink(reservations, email, name = 'Marta') {
      let token = '';
      for (const reservation_id of reservations) {
        const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name, email } } });
        if (link.status !== 200) throw new Error(`portal-links ${link.status}: ${JSON.stringify(link.data)}`);
        token = link.data.url.split('/i/')[1];
      }
      return token;
    },
    async guestWrites(reservationId, guestId, fields, consent = false) {
      const user = await booking.t.createUser();
      await booking.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`,
        [user, JSON.stringify({ grants: [{ reservation_id: reservationId, guest_id: guestId }] })]);
      await booking.t.rpc('core_invoke', { p_app: 'guests', p_actor: user, p_name: 'booking.portal_guest_update', p_args: { guest_id: guestId, fields } });
      if (consent) await booking.t.rpc('core_invoke', { p_app: 'guests', p_actor: user, p_name: 'booking.portal_guest_consent', p_args: { guest_id: guestId, allergies_visible_to_organizer: true } });
    },
    setOffline(on) { offline = on; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booking.close();
    },
  };
}
