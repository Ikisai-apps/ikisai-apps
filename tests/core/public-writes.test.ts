/** Escrituras públicas sin sesión (0094): el lote va con el actor de servicio, solo a las tablas abiertas, solo filas, y los hooks saben que es público. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp, createSupabase, isFault } from '../../supabase/functions/_kit/mod.ts';

const status = (expected: number) => (e: unknown) => isFault(e) && e.status === expected;
import { applyPublicOperations } from '../../supabase/functions/_kit/public-write.ts';

test('público · insert con el actor de servicio, hook que ve el lote público; call, tabla cerrada y borrado se rechazan', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table booking.test_public (id uuid primary key, body text, origin text, revision bigint not null default 1, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
      create table booking.test_closed (id uuid primary key, body text, revision bigint not null default 1, created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
      select core.register_table('booking', 'booking', 'test_public', array['body']);
      select core.register_table('booking', 'booking', 'test_closed', array['body']);
      create function booking.test_public_origin() returns trigger language plpgsql as $$
        begin new.origin := case when core.is_public_batch() then 'public' else coalesce(core.current_role(), 'none') end; return new; end $$;
      create trigger test_public_origin before insert or update on booking.test_public for each row execute function booking.test_public_origin();
      select core.allow_public_write('booking', 'booking.test_public');`);
    const supabase = createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
    const id = crypto.randomUUID();
    const out = await applyPublicOperations(supabase, 'booking', [{ op: 'insert', table: 'booking.test_public', id, fields: { body: 'cesta' } }]);
    assert.ok(out.cursor > 0);
    const row = await db.query<{ origin: string; updated_by: string }>(`select origin, updated_by::text from booking.test_public where id = $1`, [id]);
    assert.deepEqual(row.rows[0], { origin: 'public', updated_by: service }, 'el hook ve el lote público y el autor es el actor de servicio');
    const change = await db.query<{ actor_id: string }>(`select actor_id::text from core.changes where row_id = $1`, [id]);
    assert.equal(change.rows[0]?.actor_id, service);
    // Un editor normal escribe en la misma tabla y el hook ya no lo ve como público.
    const own = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'pub-1', operations: [{ op: 'insert', table: 'booking.test_public', id: crypto.randomUUID(), fields: { body: 'mía' } }] } });
    assert.equal(own.status, 200, JSON.stringify(own.data));
    assert.equal((await db.query<{ n: number }>(`select count(*)::int n from booking.test_public where origin = 'editor'`)).rows[0]?.n, 1);
    // Lo que no entra por la vía pública.
    await assert.rejects(applyPublicOperations(supabase, 'booking', [{ op: 'insert', table: 'booking.test_closed', id: crypto.randomUUID(), fields: { body: 'x' } }]), status(403));
    await assert.rejects(applyPublicOperations(supabase, 'booking', [{ op: 'call', procedure: 'booking.nada', args: {} } as never]), status(422));
    await assert.rejects(applyPublicOperations(supabase, 'booking', [{ op: 'delete', table: 'booking.test_public', id, expectedRevision: 1 } as never]), status(422));
    await assert.rejects(applyPublicOperations(supabase, 'booking', []), status(422));
  } finally {
    await app.close();
  }
});

test('público · una app sin tablas abiertas no escribe por esta vía', async () => {
  const app = await createTestApp({ app: 'food', slug: 'food-api', origin: 'https://food.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'food', slug: 'food-api', origins: ['https://food.ikisai.com'] }) });
  try {
    const supabase = createSupabase({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch });
    await assert.rejects(applyPublicOperations(supabase, 'food', [{ op: 'insert', table: 'food.recipes', id: crypto.randomUUID(), fields: {} }]), status(403));
  } finally {
    await app.close();
  }
});
