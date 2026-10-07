/** Booking · datos de huéspedes para los portales (API.md §16): procedencia por campo, qué ve cada uno, consentimiento, firma y baja. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { guestCompleteness, guestMissing, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
let organizer: string;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizer = await app.t.createUser();
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[], token = app.tokens.owner) {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: `pg-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
async function reservation(confirm: boolean): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro portal', status: 'pre_reservada', start_date: '2027-09-10', end_date: '2027-09-12', expected_guests: 10 } }]);
  if (confirm) await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}
async function grant(appId: 'organizers' | 'guests', user: string, grants: unknown[]) {
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)
    on conflict (app, user_id) do update set scopes = excluded.scopes`, [appId, user, JSON.stringify({ grants })]);
}
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const fails = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (e: any) => e.code === code || String(e.message).includes(code));
const guestRow = async (id: string) => (await app.t.db.query<Record<string, any>>(`select * from booking.guests where id = $1`, [id])).rows[0]!;

test('portales · qué se pide: el dominio y SQL coinciden en los dos modos', async () => {
  const samples = [
    { first_name: 'Ana' },
    { first_name: 'Ana', last_name_1: 'Pérez', birth_date: '1990-01-01', residence_address: 'C/ Falsa 1', residence_postal_code: '00000', residence_city: 'Villa', residence_country: 'ESP', email: 'a@example.invalid', document_type: 'DNI', document_number: '00000000T' },
    { first_name: '', phone: '600000000', is_minor: true },
    { first_name: 'Leo', document_type: 'NIE', document_number: 'X0000000T', last_name_1: 'Gil' },
  ];
  for (const g of samples) {
    for (const mode of ['ses', 'operativo'] as const) {
      const row: Record<string, unknown> = { last_name_1: null, last_name_2: null, birth_date: null, residence_address: null, residence_postal_code: null,
        residence_city: null, residence_country: null, phone: null, email: null, is_minor: false, kinship: null, document_type: null, document_number: null,
        document_support_number: null, ...(g as Record<string, unknown>) }; if (!('first_name' in g)) row.first_name = null;
      const sql = (await app.t.db.query<{ m: string[] }>(`select booking.guest_missing(jsonb_populate_record(null::booking.guests, $1::jsonb), $2) m`, [JSON.stringify(row), mode])).rows[0]!.m;
      assert.deepEqual(sql, guestMissing(row as any, mode), `${mode} ${JSON.stringify(g)}`);
    }
  }
  assert.deepEqual(guestCompleteness({ first_name: 'A', phone: '1' } as any, 'operativo'), { complete: true, missing: [], signed: false, needsSignature: false });
});

test('portales · el organizador: solo con la reserva confirmada, con declaración; ve lo suyo y «rellenado» de lo demás; llega a Booking por changes', async () => {
  const pending = await reservation(false);
  const res = await reservation(true);
  await grant('organizers', organizer, [{ reservation_id: pending }, { reservation_id: res }]);

  assert.equal((await read('organizers', organizer, 'booking.portal_guests', { reservation_id: pending })).confirmed, false);
  await fails(invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: pending, guest_id: uuid(), fields: { first_name: 'Ana' }, declaration: true }), 'RESERVATION_NOT_CONFIRMED');
  await fails(read('organizers', organizer, 'booking.portal_guests', { reservation_id: uuid() }), 'OUT_OF_SCOPE');

  const guestId = uuid();
  await fails(invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, fields: { first_name: 'Ana' } }), 'DECLARATION_REQUIRED');
  const before = (await app.call('/api/v1/bootstrap')).data.cursor;
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, declaration: true,
    fields: { first_name: 'Ana', last_name_1: 'Sintética', email: 'ana@example.invalid', notes: 'no se cuela', data_status: 'datos_revisados' } });
  const stored = await guestRow(guestId);
  assert.equal(stored.updated_by, organizer);
  assert.equal(stored.notes, null); assert.equal(stored.data_status, 'pendiente_datos');
  assert.equal(stored.field_sources.first_name.by, 'organizer');
  assert.equal((await app.t.db.query(`select 1 from booking.portal_declarations where reservation_id = $1 and user_id = $2`, [res, organizer])).rows.length, 1);
  const changes = await app.call(`/api/v1/changes?after=${before}`, { token: app.tokens.owner });
  assert.ok(changes.data.items.some((c: any) => c.table === TABLES.guests && c.id === guestId), 'el alta del portal llega a Booking por changes');

  // El huésped completa y corrige: esos campos pasan a ser suyos.
  const guestUser = await app.t.createUser();
  await grant('guests', guestUser, [{ reservation_id: res, guest_id: guestId }]);
  await invoke('guests', guestUser, 'booking.portal_guest_update', { guest_id: guestId, fields: { last_name_1: 'Sintética-Real', birth_date: '1991-02-03' } });
  const view = (await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items[0];
  assert.equal(view.display_name, 'Ana S.');
  assert.equal(view.fields.first_name, 'Ana');
  assert.equal(view.fields.email, 'ana@example.invalid');
  assert.equal(view.fields.last_name_1, true, 'lo escribió el huésped: solo «rellenado»');
  assert.equal(view.fields.birth_date, true);
  assert.equal(view.fields.document_number, null);
  assert.ok(view.missing.includes('document_number'));
  await fails(invoke('organizers', organizer, 'booking.portal_update_guest', { guest_id: guestId, fields: { birth_date: '2000-01-01' } }), 'FIELD_OWNED_BY_GUEST');
  await invoke('organizers', organizer, 'booking.portal_update_guest', { guest_id: guestId, fields: { phone: '600000000' } });
  const mine = await read('guests', guestUser, 'booking.portal_my_guest', { guest_id: guestId });
  assert.equal(mine.fields.phone, '600000000', 'el huésped ve lo que rellenó el organizador');
  assert.equal(mine.fields.birth_date, '1991-02-03');
  await fails(read('guests', guestUser, 'booking.portal_my_guest', { guest_id: uuid() }), 'OUT_OF_SCOPE');
  // reservas del organizador con sus totales
  const list = await read('organizers', organizer, 'booking.portal_reservations', {});
  assert.deepEqual(list.items.map((r: any) => [r.id === res, r.confirmed, Number(r.guests)]).filter((x: any) => x[0]), [[true, true, 1]]);
});

test('portales · alergias con consentimiento, firma solo del huésped y baja por el organizador', async () => {
  const res = await reservation(true);
  await grant('organizers', organizer, [{ reservation_id: res }]);
  const guestId = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: guestId, fields: { first_name: 'Leo', last_name_1: 'Prueba' }, declaration: true });
  const guestUser = await app.t.createUser();
  await grant('guests', guestUser, [{ reservation_id: res, guest_id: guestId }]);

  await invoke('organizers', organizer, 'booking.portal_set_restrictions', { guest_id: guestId, items: [{ restriction_type: 'vegetariano' }] });
  await invoke('guests', guestUser, 'booking.portal_set_restrictions', { guest_id: guestId, items: [{ restriction_type: 'alergia', subject: 'frutos secos', severity: 'grave' }] });
  let view = (await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items[0];
  assert.deepEqual(view.restrictions.map((r: any) => r.restriction_type), [], 'el huésped sustituyó todas las de su ficha y no ha dado consentimiento');
  const kitchen = await read('organizers', organizer, 'booking.portal_kitchen_summary', { reservation_id: res });
  assert.deepEqual(kitchen.totals, [{ restriction_type: 'alergia', subject: 'frutos secos', servings: 1 }]);
  assert.deepEqual(kitchen.named, []);
  await invoke('guests', guestUser, 'booking.portal_guest_consent', { guest_id: guestId, allergies_visible_to_organizer: true, privacy_ack_version: 'v1' });
  view = (await read('organizers', organizer, 'booking.portal_guests', { reservation_id: res })).items[0];
  assert.deepEqual(view.restrictions.map((r: any) => r.subject), ['frutos secos']);
  assert.ok((await guestRow(guestId)).privacy_ack_at);

  // el personal no marca el consentimiento por el huésped
  const rev = Number((await guestRow(guestId)).revision);
  const staff = await app.call('/api/v1/commands', { body: { requestId: `pg-${++seq}`, operations: [{ op: 'update', table: TABLES.guests, id: guestId, expectedRevision: rev, fields: { allergies_visible_to_organizer: false } }] } });
  assert.equal(staff.status, 422);

  // firma: archivo subido por el propio huésped en Guests
  const other = await app.t.createUser();
  const fileOf = async (owner: string) => (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, status, created_by)
    values ('guests', 'guests-documents', $1, 'firma.png', 'image/png', 10, $2, 'verified', $3) returning id`, [`guests/${uuid()}.png`, 'b'.repeat(64), owner])).rows[0]!.id;
  await fails(invoke('guests', guestUser, 'booking.portal_guest_sign', { guest_id: guestId, file_id: await fileOf(other), signed_by_name: 'Leo Prueba' }), 'INVALID_OPERATION');
  await invoke('guests', guestUser, 'booking.portal_guest_sign', { guest_id: guestId, file_id: await fileOf(guestUser), signed_by_name: 'Leo Prueba' });
  assert.ok((await guestRow(guestId)).signed_at);
  const sig = await app.call(`/api/v1/guest-signature/${guestId}`, { token: app.tokens.owner });
  assert.equal(sig.status, 200, JSON.stringify(sig.data));
  assert.match(sig.data.url, /\/object\/sign\/guests-documents\/guests\//);
  assert.equal((await app.call(`/api/v1/guest-signature/${guestId}`, { token: app.tokens.reader })).status, 403);

  // baja por el organizador: a la papelera con sus restricciones, y su enlace de Guests revocado
  const link = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body: { app: 'guests', scope: { reservation_id: res, guest_id: guestId }, person: { name: 'Leo' } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  await invoke('organizers', organizer, 'booking.portal_remove_guest', { guest_id: guestId });
  const gone = await guestRow(guestId);
  assert.ok(gone.deleted_at); assert.equal(gone.updated_by, organizer);
  assert.equal((await app.t.db.query(`select 1 from booking.dietary_restrictions where guest_id = $1 and deleted_at is null`, [guestId])).rows.length, 0);
  assert.ok((await app.t.db.query<{ r: string | null }>(`select revoked_at::text r from core.portal_links where id = $1`, [link.data.linkId])).rows[0]!.r);

  // ya comunicado a SES: lo corrige el personal
  const sent = uuid();
  await invoke('organizers', organizer, 'booking.portal_add_guest', { reservation_id: res, guest_id: sent, fields: { first_name: 'Eva' } });
  await app.t.db.query(`update booking.guests set ses_status = 'enviado_SES', ses_sent_at = now() where id = $1`, [sent]);
  await fails(invoke('organizers', organizer, 'booking.portal_remove_guest', { guest_id: sent }), 'GUEST_CHECKED_IN');
});
