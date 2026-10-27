/** 0109: lectura por id de campo para editores y owners (sin raw ni sensibles) y llamadas de procedimiento en el lote de sistema. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0109 · field_lookup: editor y owner leen ruta, anclaje y confirmación de un campo; nunca raw ni personales; un lector no', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    await db.query(`insert into core.field_inventory (field_id, app, screen, route, anchor_id, label, type, entity, prop, sensitivity, since, last_seen, raw)
      values ('booking.reserva.notas', 'booking', 'reserva', '#/r/:id', 'booking.reserva.notas', 'Notas', 'text', 'reservation', 'notes', 'internal', 'v1', 'v1', '{"confirm":"save","file":"x.ts"}'),
             ('booking.huesped.dni', 'booking', 'huesped', '#/g/:id', 'booking.huesped.dni', 'DNI', 'text', 'guest', 'document', 'personal', 'v1', 'v1', '{}')`);
    const okRow = await db.query<{ r: any }>(`select core.field_lookup($1, array['booking.reserva.notas','booking.huesped.dni','no.existe']) r`, [app.users.editor]);
    const r = okRow.rows[0]!.r;
    assert.equal(r.length, 1, 'el campo personal no sale');
    assert.deepEqual(Object.keys(r[0]).sort(), ['anchorId', 'app', 'confirm', 'entity', 'fieldId', 'label', 'prop', 'required', 'route', 'screen', 'sensitivity', 'type']);
    assert.equal(r[0].confirm, 'save'); assert.equal(r[0].route, '#/r/:id');
    const owner = await db.query<{ r: any }>(`select core.field_lookup($1, array['booking.reserva.notas']) r`, [app.users.owner]);
    assert.equal(owner.rows[0]!.r.length, 1);
    await assert.rejects(db.query(`select core.field_lookup($1, array['booking.reserva.notas'])`, [app.users.reader]), /FORBIDDEN/);
  } finally {
    await app.close();
  }
});

test('0109 · el lote de sistema llama a un procedimiento de su app registrado con allow_system_procedure; dentro, is_system_call()', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'], workerKey: 'k' }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table public.test_calls (id serial primary key, by_system boolean, role text);
      create function booking.test_confirm(p jsonb) returns jsonb language plpgsql as $$
        begin insert into public.test_calls (by_system, role) values (core.is_system_call(), p->>'role'); return jsonb_build_object('ok', true); end $$;
      select core.allow_procedure('booking', 'booking.test_confirm');
      create function booking.test_webhook(p_ctx jsonb) returns jsonb language plpgsql as $$
        begin return core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'call', 'procedure', 'booking.test_confirm', 'args', jsonb_build_object('k', 1)))); end $$;
      select core.allow_read('booking', 'booking.test_webhook', 'action', '{editor,owner}');`);
    const call = () => app.handler(new Request(app.supabase.url + '/functions/v1/booking-api/api/v1/worker/booking.test_webhook', {
      method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' }));
    // Sin registrar como procedimiento de sistema: no.
    const before = await call();
    assert.equal(before.status, 403, await before.clone().text());
    await db.query(`select core.allow_system_procedure('booking', 'booking.test_confirm')`);
    const after = await call();
    assert.equal(after.status, 200, await after.clone().text());
    const seen = (await db.query<{ by_system: boolean; role: string }>('select by_system, role from public.test_calls')).rows;
    assert.equal(seen.length, 1); assert.equal(seen[0]!.by_system, true);
    // Fuera del lote, is_system_call() es falso.
    assert.equal((await db.query<{ s: boolean }>('select core.is_system_call() s')).rows[0]!.s, false);
  } finally {
    await app.close();
  }
});
