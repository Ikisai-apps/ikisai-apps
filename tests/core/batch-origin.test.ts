/** 0118: core.batch_origin() distingue un lote del navegador de uno del servidor (identidad de servicio, sistema, migración). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0118 · batch_origin: browser en un lote de persona, server con clave de worker y caller, en un lote de sistema y en una migración', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'], workerKey: 'k' }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table public.test_origins (id serial primary key, origin text, request_id text);
      create function booking.test_origin(p jsonb) returns jsonb language plpgsql as $$
        begin insert into public.test_origins (origin, request_id) values (core.batch_origin(), core.current_request_id()); return jsonb_build_object('ok', true); end $$;
      select core.allow_procedure('booking', 'booking.test_origin');
      select core.allow_system_procedure('booking', 'booking.test_origin');
      create function booking.test_origin_worker(p_ctx jsonb) returns jsonb language plpgsql as $$
        begin return core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'call', 'procedure', 'booking.test_origin', 'args', '{}'::jsonb))); end $$;
      select core.allow_read('booking', 'booking.test_origin_worker', 'action', '{editor,owner}');`);
    const call = { op: 'call', procedure: 'booking.test_origin', args: {} };
    // Persona desde el navegador.
    const r1 = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'o-1', operations: [call] } });
    assert.equal(r1.status, 200, JSON.stringify(r1.data));
    // Persona con identidad de servicio (otra Edge): clave de worker + caller.
    const r2 = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'o-2', operations: [call] }, headers: { 'X-Ikisai-Worker-Key': 'k', 'X-Ikisai-Caller': 'flow' } });
    assert.equal(r2.status, 200, JSON.stringify(r2.data));
    // Clave de worker mala: sigue siendo navegador (no se confía).
    const r3 = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'o-3', operations: [call] }, headers: { 'X-Ikisai-Worker-Key': 'mala', 'X-Ikisai-Caller': 'flow' } });
    assert.equal(r3.status, 200, JSON.stringify(r3.data));
    // Lote de sistema por el worker.
    const r4 = await app.handler(new Request(app.supabase.url + '/functions/v1/booking-api/api/v1/worker/booking.test_origin_worker', {
      method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'k', 'Content-Type': 'application/json' }, body: '{}' }));
    assert.equal(r4.status, 200, await r4.clone().text());
    const rows = (await db.query<{ origin: string; request_id: string }>('select origin, request_id from public.test_origins order by id')).rows;
    assert.deepEqual(rows.map((r) => r.origin), ['browser', 'server', 'browser', 'server']);
    // Sin marca (una Edge que llama a core_commit directamente, una migración): server. Solo /commands marca browser.
    assert.equal((await db.query<{ o: string }>('select core.batch_origin() o')).rows[0]!.o, 'server', 'sin marca, server');
    const r5 = await db.query<{ r: any }>(`select public.core_commit('booking', $1, 'o-5', 'x', null, $2::jsonb, null) r`, [app.users.editor, JSON.stringify([call])]).catch((e: any) => ({ rows: [{ r: { error: String(e?.message ?? e) } }] }));
    void r5;
    const last = (await db.query<{ origin: string }>('select origin from public.test_origins order by id desc limit 1')).rows[0];
    assert.equal(last?.origin, 'server', 'core_commit de 7 argumentos (una Edge) es server');
  } finally {
    await app.close();
  }
});
