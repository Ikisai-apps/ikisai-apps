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
  guestLink(reservationId: string, guestId: string, name: string, email?: string, preview?: boolean): Promise<string>;
  /** Fila del huésped en Booking (para comprobar lo guardado). */
  row(guestId: string): Promise<Record<string, any>>;
  /** Siembra los textos de Central (`central.seed_texts`, migración 0570): legales, contacto e información práctica. */
  seedCentralTexts(): Promise<void>;
  /** Acción de Booking invocada por un organizador de esa reserva (programa, ajustes de habitaciones…). */
  organizerInvoke(reservationId: string, name: string, args: Record<string, unknown>): Promise<any>;
  /** Habitación del retiro: espacio con camas, asignado al evento como grupo (así entra en el inventario del retiro). */
  room(event: string, options: { name: string; enSuite: boolean; beds: string[]; zone?: string }): Promise<{ spaceId: string; bedIds: string[] }>;
  /** Menú de Food validado y compartido, sembrado en la base: `[{date, type, time, dishes: [{name, allergens?, diet?}]}]`. */
  menu(event: string, services: Array<{ date: string; type: string; time: string; dishes: Array<{ name: string; description?: string; allergens?: string[]; diet?: string[] }> }>): Promise<void>;
  /** El lugar en Central: dirección del lugar (sin domicilio fiscal en los portales) y, si se pide, un plano verificado. */
  place(options: { venue: string; plan?: 'image/png' | 'application/pdf' }): Promise<void>;
  /** El personal asigna una cama a un huésped. */
  assign(event: string, spaceId: string, bedId: string, guestId: string): Promise<void>;
  /** Una acción de Guests hecha por otro huésped (su propia cuenta y ámbito). */
  guestInvoke(reservationId: string, guestId: string, name: string, args: Record<string, unknown>): Promise<any>;
  /** Experiencia de Guests configurada por el organizador (`organizers.experiences`, Organizers #333). */
  experience(reservationId: string, fields: Record<string, unknown>): Promise<void>;
  /** Material publicado del organizador; con `file`, un archivo verificado en `organizers-materials`. Devuelve el id del archivo. */
  material(reservationId: string, m: { kind: 'file' | 'link' | 'text'; title: string; description?: string; window?: string; url?: string; body?: string; file?: { name: string; mime: string; size: number } }): Promise<string | null>;
  /** Pregunta publicada del organizador. */
  question(reservationId: string, q: { id?: string; type: string; label: string; help?: string; options?: Array<{ value: string; label: string }>; required?: boolean; closes_at?: string; opens_at?: string }): Promise<string>;
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
  const organizerUsers = new Map<string, string>();

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
    async guestLink(reservationId, guestId, name, email, preview) {
      const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'guests', scope: { reservation_id: reservationId, guest_id: guestId }, person: { name, ...(email ? { email } : {}) }, ...(preview ? { preview: true } : {}) } });
      if (link.status !== 200) throw new Error(`portal-links ${link.status}: ${JSON.stringify(link.data)}`);
      return link.data.url.split('/i/')[1];
    },
    async row(guestId) {
      return (await booking.t.db.query<Record<string, any>>('select * from booking.guests where id = $1', [guestId])).rows[0]!;
    },
    async organizerInvoke(reservationId, name, args) {
      let user = organizerUsers.get(reservationId);
      if (!user) {
        user = await booking.t.createUser();
        organizerUsers.set(reservationId, user);
        await booking.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`,
          [user, JSON.stringify({ grants: [{ reservation_id: reservationId }] })]);
      }
      return booking.t.rpc('core_invoke', { p_app: 'organizers', p_actor: user, p_name: name, p_args: { reservation_id: reservationId, ...args } });
    },
    async room(event, { name, enSuite, beds, zone = 'Posada' }) {
      const spaceId = uuid();
      const bedIds = beds.map(() => uuid());
      await commit([
        { op: 'insert', table: TABLES.spaces, id: spaceId, fields: { name, kind: 'habitacion', zone, en_suite: enSuite } },
        ...beds.map((label, i) => ({ op: 'insert', table: TABLES.beds, id: bedIds[i], fields: { space_id: spaceId, label, kind: 'individual', capacity: 1 } })),
        { op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: spaceId, group_label: 'Grupo del retiro', persons: 1 } },
      ]);
      return { spaceId, bedIds };
    },
    async menu(event, services) {
      const db = booking.t.db;
      const menuId = uuid();
      // En borrador mientras se añaden servicios y platos (con el menú validado, Food los bloquea: MENU_LOCKED); se valida al final.
      await db.query(`insert into food.menus (id, event_id, source_event_revision, source_event_snapshot, status, organizer_shared) values ($1, $2, 1, '{}'::jsonb, 'borrador', true)`, [menuId, event]);
      for (const [i, s] of services.entries()) {
        const serviceId = uuid();
        await db.query(`insert into food.menu_services (id, menu_id, service_date, service_type, service_time, position) values ($1, $2, $3, $4, $5, $6)`, [serviceId, menuId, s.date, s.type, s.time, i]);
        for (const [j, d] of s.dishes.entries()) {
          const recipeId = uuid();
          await db.query(`insert into food.recipes (id, name, public_description, category, base_servings, diet_tags, allergens, allergens_checked) values ($1, $2, $3, 'principal', 10, $4, $5, $6)`,
            [recipeId, d.name, d.description ?? null, d.diet ?? [], d.allergens ?? [], Boolean(d.allergens)]);
          await db.query(`insert into food.menu_items (id, service_id, recipe_id, servings, position) values ($1, $2, $3, 10, $4)`, [uuid(), serviceId, recipeId, j]);
        }
      }
      await db.query(`update food.menus set status = 'validado', validated_at = now() where id = $1`, [menuId]);
    },
    async place({ venue, plan }) {
      const db = booking.t.db;
      let fileId: string | null = null;
      if (plan) {
        fileId = (await db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status) values ('central', 'central-documents', $1, 'plano', $2, 10, $3, 'verified') returning id`,
          [`central/${uuid()}`, plan, 'c'.repeat(64)])).rows[0]!.id;
      }
      await db.query(`insert into central.entity (legal_name, trade_name, tax_id, address_line, postal_code, city, venue_address, site_plan_file_id)
        values ('Ikisai Sintética SL', 'Ikisai', 'B00000000', 'Calle Fiscal 1', '40001', 'Segovia', $1, $2)`, [venue, fileId]);
    },
    async assign(event, spaceId, bedId, guestId) {
      await commit([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: event, space_id: spaceId, bed_id: bedId, guest_id: guestId, persons: 1 } }]);
    },
    async guestInvoke(reservationId, guestId, name, args) {
      const user = await booking.t.createUser();
      await booking.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2::jsonb)`,
        [user, JSON.stringify({ grants: [{ reservation_id: reservationId, guest_id: guestId }] })]);
      return booking.t.rpc('core_invoke', { p_app: 'guests', p_actor: user, p_name: name, p_args: { guest_id: guestId, ...args } });
    },
    async experience(reservationId, fields) {
      const cols = Object.keys(fields);
      await booking.t.db.query(`insert into organizers.experiences (reservation_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})`,
        [reservationId, ...cols.map((c) => (c === 'lodging_options' ? JSON.stringify(fields[c]) : fields[c]))]);
    },
    async material(reservationId, m) {
      let fileId: string | null = null;
      if (m.file) {
        fileId = (await booking.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status) values ('organizers', 'organizers-materials', $1, $2, $3, $4, $5, 'verified') returning id`,
          [`organizers/${uuid()}`, m.file.name, m.file.mime, m.file.size, 'd'.repeat(64)])).rows[0]!.id;
      }
      await booking.t.db.query(`insert into organizers.materials (reservation_id, kind, title, description, file_id, url, body, published, "window") values ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
        [reservationId, m.kind, m.title, m.description ?? null, fileId, m.url ?? null, m.body ?? null, m.window ?? 'always']);
      return fileId;
    },
    async question(reservationId, q) {
      const id = q.id ?? uuid();
      await booking.t.db.query(`insert into organizers.questions (id, reservation_id, type, label, help, options, required, opens_at, closes_at, published) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, true)`,
        [id, reservationId, q.type, q.label, q.help ?? null, JSON.stringify(q.options ?? []), q.required ?? false, q.opens_at ?? null, q.closes_at ?? null]);
      return id;
    },
    async seedCentralTexts() {
      await booking.t.db.query('select central.seed_texts()');
      await booking.t.db.query('select central.seed_contact_audiences()'); // correo por público (Central #341): Guests, ven@
    },
    setOffline(on) { offline = on; },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await booking.close();
    },
  };
}
