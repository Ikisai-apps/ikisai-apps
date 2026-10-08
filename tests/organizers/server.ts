/**
 * Organizers · servidor HTTP para las pruebas de interfaz: la `organizers-api` real sobre PGlite con el Supabase simulado del
 * test-kit, junto a la `booking-api` (el personal crea y confirma reservas y emite el enlace del organizador). Sin API falsa:
 * lo que ve la pantalla es lo que responden las Edge.
 */
import { createServer, type Server } from 'node:http';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

export interface OrganizersTestServer {
  url: string;
  booking: TestApp;
  /** Reserva nueva (`confirm` crea su evento). */
  reservation(options: { title: string; confirm: boolean; start?: string; end?: string; guests?: number; ses?: boolean }): Promise<string>;
  /** Enlace del organizador emitido por el personal de Booking; devuelve el token de `/i/<token>`. */
  organizerLink(reservations: string[], email: string, name?: string): Promise<string>;
  /** El propio huésped escribe datos desde Guests (procedencia «guest»). */
  guestWrites(reservationId: string, guestId: string, fields: Record<string, unknown>, consent?: boolean): Promise<void>;
  /** Reserva en diseño (fase 2) con los campos que se indiquen (estado `en_estudio` por defecto, sin fechas). */
  draftReservation(fields: Record<string, unknown>): Promise<string>;
  /** Fechas posibles que propone el personal de Ikisai (`proposed_by: ikisai`). */
  ikisaiOptions(reservationId: string, ranges: Array<[string, string]>): Promise<void>;
  /** Bloqueo manual del personal (el portal solo ve «ocupado»). */
  block(start: string, end: string): Promise<void>;
  /** Viernes a `weeks` semanas de hoy (hora de Madrid), `AAAA-MM-DD`. */
  friday(weeks: number): Promise<string>;
  /**
   * Tarifario visible en el portal (una vez por servidor): condiciones por defecto (IVA 10 % incluido, señal 30 % con mínimo
   * de 300 €, mínimo por retiro de 2500 €), estancia por persona y noche, sala por día y un extra de sonido. Devuelve el id del extra.
   */
  seedRates(): Promise<{ extraId: string }>;
  /** Propuesta enviada por el personal para una reserva, con una línea. Devuelve su id. */
  sendProposal(reservationId: string, persons: number): Promise<string>;
  /**
   * Factura registrada en Finance (de otra herramienta, sin copia congelada) con su ingreso asignado a la reserva, como la
   * prueba de Finance (tests/invoices/sql.test.ts). `collected` la marca cobrada.
   */
  registeredInvoice(reservationId: string, number: string, amount: number, collected: boolean): Promise<string>;
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
  await booking.t.db.query('select central.seed_texts_payment()');
  let seq = 0;
  let offline = false;
  let seeded: { extraId: string } | null = null;

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
    async draftReservation(fields) {
      const id = uuid();
      await commit([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro en diseño', status: 'en_estudio', ...fields } }]);
      return id;
    },
    async ikisaiOptions(reservationId, ranges) {
      await commit(ranges.map(([start_date, end_date], i) => ({ op: 'insert', table: TABLES.dateOptions, id: uuid(),
        fields: { reservation_id: reservationId, start_date, end_date, proposed_by: 'ikisai', position: i + 1 } })));
    },
    async block(start_date, end_date) {
      await commit([{ op: 'insert', table: TABLES.dateBlocks, id: uuid(), fields: { start_date, end_date, reason: 'Mantenimiento interno' } }]);
    },
    async friday(weeks) {
      return (await booking.t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date + ((5 - extract(isodow from (now() at time zone 'Europe/Madrid')::date)::int + 7) % 7) + $1 * 7)::text d`, [weeks])).rows[0]!.d;
    },
    async seedRates() {
      if (seeded) return seeded;
      const conditions = uuid();
      await commit([
        { op: 'insert', table: TABLES.conditions, id: conditions, fields: { name: 'Condiciones de prueba', deposit_percent: 30, deposit_minimum: 300, minimum_total: 2500, is_default: true } },
        { op: 'insert', table: TABLES.cancellationTiers, id: uuid(), fields: { conditions_id: conditions, min_days_before: 60, deposit_refund_pct: 100 } },
        { op: 'insert', table: TABLES.cancellationTiers, id: uuid(), fields: { conditions_id: conditions, min_days_before: 30, deposit_refund_pct: 50 } },
      ]);
      const extraId = uuid();
      await commit([
        { op: 'insert', table: TABLES.rates, id: uuid(), fields: { name: 'Grupo con pernocta', public_name: 'Estancia con pensión completa', layer: 'por_persona', unit: 'persona_noche', amount: 60, service: 'alojamiento', portal_visible: true } },
        { op: 'insert', table: TABLES.rates, id: uuid(), fields: { name: 'Sala grande', layer: 'recinto', unit: 'dia', amount: 200, portal_visible: true } },
        { op: 'insert', table: TABLES.rates, id: extraId, fields: { name: 'Sonido', public_name: 'Equipo de sonido', public_description: 'Altavoces y micrófono', layer: 'extra', unit: 'estancia', amount: 150, portal_visible: true } },
      ]);
      seeded = { extraId };
      return seeded;
    },
    async sendProposal(reservationId, persons) {
      const id = uuid();
      await commit([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: reservationId, proposal_id: id } }]);
      await commit([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: id, description: 'Estancia con pensión completa', unit: 'persona_noche', quantity: persons * 2, unit_amount: 60, position: 1 } }]);
      const revision = Number((await booking.t.db.query<{ revision: string }>('select revision from booking.proposals where id = $1', [id])).rows[0]!.revision);
      await commit([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: id, expectedRevision: revision } }]);
      return id;
    },
    async registeredInvoice(reservationId, number, amount, collected) {
      const actor = booking.users.owner;
      await booking.t.db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'owner') on conflict (app, user_id) do nothing`, [actor]);
      const financeCommit = async (operations: unknown[]) => {
        await booking.t.db.query(`select core.commit('invoices', $1, $2, $3, null, $4::jsonb, null::jsonb)`, [actor, `inv-${uuid()}`, uuid(), JSON.stringify(operations)]);
      };
      const today = (await booking.t.db.query<{ d: string }>(`select to_char((now() at time zone 'Europe/Madrid')::date, 'YYYY-MM-DD') d`)).rows[0]!.d;
      const id = uuid();
      await financeCommit([
        { op: 'insert', table: 'invoices.issued_invoices', id, fields: { series_code: 'PA', number, issue_date: today, invoice_type: 'F2', description: 'Señal del retiro' } },
        { op: 'insert', table: 'invoices.issued_invoice_lines', id: uuid(), fields: { issued_invoice_id: id, description: 'Señal', net_amount: amount, vat_rate: 0 } },
      ]);
      await booking.t.db.query(`insert into invoices.issued_allocations (issued_invoice_id, target_app, target_kind, target_id, target_label, allocated_amount)
        values ($1, 'booking', 'reservation', $2, 'Reservas › Retiro', $3)`, [id, reservationId, amount]);
      if (collected) {
        const revision = Number((await booking.t.db.query<{ revision: string }>('select revision from invoices.issued_invoices where id = $1', [id])).rows[0]!.revision);
        await financeCommit([{ op: 'update', table: 'invoices.issued_invoices', id, expectedRevision: revision, fields: { payment_status: 'cobrada', paid_at: today } }]);
      }
      return id;
    },
    setOffline(on) { offline = on; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booking.close();
    },
  };
}
