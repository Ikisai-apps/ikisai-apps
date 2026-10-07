/** Escrituras de un worker de sistema en su propia app (P22): lote propio con la cuenta de servicio; nunca desde una persona. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('sistema · el worker escribe en su app como «Booking (sistema)» y llega por changes; una persona no puede', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'], workerKey: 'k' }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table booking.test_rows (id uuid primary key, body text, revision bigint not null default 1, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
      select core.register_table('booking', 'booking', 'test_rows', array['body']);
      create function booking.test_anonymize(p_ctx jsonb) returns jsonb language plpgsql as $$
        begin return core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.test_rows', 'id', p_ctx->'args'->>'id', 'fields', jsonb_build_object('body', 'anonimizado')))); end $$;
      select core.allow_read('booking', 'booking.test_anonymize', 'action', '{editor,owner}');`);
    const id = crypto.randomUUID();
    const res = await app.handler(new Request(app.supabase.url + '/functions/v1/booking-api/api/v1/worker/booking.test_anonymize', {
      method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) }));
    assert.equal(res.status, 200, await res.clone().text());
    const change = await db.query<{ actor_id: string; app: string }>(`select actor_id::text, app from core.changes where row_id = $1`, [id]);
    assert.deepEqual(change.rows[0], { actor_id: service, app: 'booking' });
    const person = await app.call('/api/v1/invoke/booking.test_anonymize', { token: app.tokens.editor, body: { id: crypto.randomUUID() } });
    assert.equal(person.status, 403, 'una persona no escribe por la vía de sistema');
  } finally {
    await app.close();
  }
});
