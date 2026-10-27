/** Auditoría del undo del kit (27-10-2026): `undo-plan` mira el lote como `history` (rol y `visible`) y da 404 si algo no se
 *  ve, porque el plan lleva los valores anteriores; un lote ajeno solo lo deshace el owner; y `undo` pasa por `beforeCommit`
 *  con `ctx.undo = true`. Caso real: Booking, un editor sin `scopes.guests` frente a un huésped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';
import type { AppHooks } from '../../supabase/functions/_kit/sync.ts';
import { fail } from '../../supabase/functions/_kit/errors.ts';

// Datos sintéticos, como en tests/booking/guests.test.ts.
const ADULT = {
  first_name: 'Persona', last_name_1: 'Sintética', last_name_2: 'Prueba', sex: 'M', document_type: 'DNI', document_number: '00000000T', document_support_number: 'AAA000000',
  nationality: 'ESP', birth_date: '1990-01-15', residence_address: 'Calle Inventada 1', residence_postal_code: '00000', residence_city: 'Villa Ejemplo', residence_country: 'ESP', phone: '600000000',
};

const uuid = () => crypto.randomUUID();
let seq = 0;
const rid = () => `undo-${++seq}-${uuid()}`;

async function commit(app: TestApp, operations: unknown[], token = app.tokens.owner) {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: rid(), operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data as { cursor: number };
}
const plan = (app: TestApp, cursor: number, token: string) => app.call(`/api/v1/history/${cursor}/undo-plan`, { token, body: {} });
const undo = (app: TestApp, cursor: number, token: string, planHash = 'x') => app.call(`/api/v1/history/${cursor}/undo`, { token, body: { requestId: rid(), planHash } });
const code = (res: { data: any }) => res.data?.error?.code;

test('undo · Booking: el editor sin scopes.guests no ve ni deshace el lote de un huésped (404); un lote ajeno, solo el owner', async () => {
  const app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  try {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}'::jsonb)`, [user]);
    const designated = app.supabase.tokenFor(user);
    const reservationId = uuid(); const eventId = uuid(); const guestId = uuid();
    await commit(app, [{ op: 'insert', table: TABLES.reservations, id: reservationId, fields: { title: 'Retiro Undo', status: 'pre_reservada', start_date: '2027-04-02', end_date: '2027-04-04', expected_guests: 10, requires_meals: true, meal_plan_requested: 'pension_completa', menu_style_requested: 'vegetariano' } }]);
    await commit(app, [{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: reservationId, event_id: eventId, from_status: 'pre_reservada' } }]);
    await commit(app, [{ op: 'insert', table: TABLES.guests, id: guestId, fields: { event_id: eventId, ...ADULT } }], designated);
    const edit = await commit(app, [{ op: 'update', table: TABLES.guests, id: guestId, expectedRevision: 1, fields: { phone: '600000001' } }], designated);
    const later = await commit(app, [{ op: 'update', table: TABLES.guests, id: guestId, expectedRevision: 2, fields: { phone: '600000002' } }]);

    // Editor sin ámbito: ni el plan (con el teléfono anterior) ni el undo; igual que un cursor que no existe.
    for (const res of [await plan(app, edit.cursor, app.tokens.editor), await undo(app, edit.cursor, app.tokens.editor)]) {
      assert.equal(res.status, 404, JSON.stringify(res.data));
      assert.equal(JSON.stringify(res.data).includes('60000000'), false);
    }
    assert.equal((await plan(app, 999_999, app.tokens.editor)).status, 404);

    // Editor con ámbito: el lote del owner es ajeno (403); el suyo, sí, y vuelve el teléfono anterior.
    assert.equal(code(await plan(app, later.cursor, designated)), 'FORBIDDEN');
    const own = await plan(app, later.cursor, app.tokens.owner);
    assert.equal(own.status, 200, JSON.stringify(own.data));
    const done = await undo(app, later.cursor, app.tokens.owner, own.data.planHash);
    assert.equal(done.status, 200, JSON.stringify(done.data));
    const mine = await plan(app, edit.cursor, designated);
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.equal(mine.data.operations[0].fields.phone, '600000000');
    assert.equal((await undo(app, edit.cursor, designated, mine.data.planHash)).status, 200);
    const phone = (await app.t.db.query<{ phone: string | null }>(`select phone from booking.guests where id = $1`, [guestId])).rows[0]!.phone;
    assert.equal(phone, '600000000');
  } finally {
    await app.close();
  }
});

test('undo · pasa por beforeCommit con ctx.undo = true, y su veto lo para', async () => {
  const seen: Array<{ undo: boolean | undefined; ops: string[] }> = [];
  let veto = false;
  const hooks: AppHooks = {
    beforeCommit: (operations, ctx) => {
      seen.push({ undo: ctx.undo, ops: operations.map((o) => o.op) });
      if (veto && ctx.undo) fail(422, 'INVALID_OPERATION', 'La app no deja deshacer esto.');
    },
  };
  const app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: 'https://tasks.ikisai.com',
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api', hooks }),
  });
  try {
    await app.t.db.query(`create table tasks.undo_notes (id uuid primary key, revision bigint not null default 1, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz, text text not null)`);
    await app.t.db.query(`select core.register_table('tasks', 'tasks', 'undo_notes', array['text'], '{reader,editor,owner}', '{editor,owner}')`);
    const id = uuid();
    const made = await commit(app, [{ op: 'insert', table: 'tasks.undo_notes', id, fields: { text: 'uno' } }], app.tokens.editor);
    assert.deepEqual(seen.at(-1), { undo: undefined, ops: ['insert'] });
    const p = await plan(app, made.cursor, app.tokens.editor);
    assert.equal(p.status, 200, JSON.stringify(p.data));
    veto = true;
    const stopped = await undo(app, made.cursor, app.tokens.editor, p.data.planHash);
    assert.equal(code(stopped), 'INVALID_OPERATION', 'el veto de la app para el undo');
    assert.deepEqual(seen.at(-1), { undo: true, ops: ['delete'] });
    veto = false;
    assert.equal((await undo(app, made.cursor, app.tokens.editor, p.data.planHash)).status, 200);
  } finally {
    await app.close();
  }
});
