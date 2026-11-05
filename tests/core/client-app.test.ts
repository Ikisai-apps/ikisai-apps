/** 0119: core.client_app() dice desde qué app se confirmó el lote (la Edge que lo sirve), o null en lotes de sistema. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0119 · client_app: la app de la Edge en un lote de /commands, null en un lote de sistema, y una app desconocida se rechaza', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'], workerKey: 'k' }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table public.test_client_apps (id serial primary key, client_app text, request_id text);
      create function booking.test_client_app(p jsonb) returns jsonb language plpgsql as $$
        begin insert into public.test_client_apps (client_app, request_id) values (core.client_app(), core.current_request_id()); return jsonb_build_object('ok', true); end $$;
      select core.allow_procedure('booking', 'booking.test_client_app');
      select core.allow_system_procedure('booking', 'booking.test_client_app');
      create function booking.test_client_app_worker(p_ctx jsonb) returns jsonb language plpgsql as $$
        begin return core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'call', 'procedure', 'booking.test_client_app', 'args', '{}'::jsonb))); end $$;
      select core.allow_read('booking', 'booking.test_client_app_worker', 'action', '{editor,owner}');`);
    const call = { op: 'call', procedure: 'booking.test_client_app', args: {} };
    const r1 = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'c-1', operations: [call] } });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    const r2 = await app.handler(new Request(app.supabase.url + '/functions/v1/booking-api/api/v1/worker/booking.test_client_app_worker', {
      method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' }));
    assert.equal(r2.status, 200, await r2.clone().text());
    const rows = (await db.query<{ client_app: string | null; request_id: string }>(`select client_app, request_id from public.test_client_apps order by id`)).rows;
    assert.deepEqual(rows.map((r) => r.client_app), ['booking', null], JSON.stringify(rows));
    assert.equal(rows[0]!.request_id, 'c-1');

    // Fuera del lote no hay app cliente; una app desconocida se rechaza en la sobrecarga de core_commit.
    assert.equal((await db.query<{ a: string | null }>(`select core.client_app() as a`)).rows[0]!.a, null);
    const someone = await app.t.createUser();
    await assert.rejects(db.query(`select public.core_commit('booking', $1, 'c-9', 'x', null, '[]'::jsonb, null, 'browser', 'nadie')`, [someone]), /INVALID_OPERATION/);
  } finally {
    await app.close();
  }
});
