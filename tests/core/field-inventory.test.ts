/** Inventario de campos (P15, migración 0100, contrato §3.8): carga por release que conserva `since`, retirada, foto de lo sin instrumentar y `GET usage/inventory` solo para el owner de Central. Datos sintéticos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;

const field = (fieldId: string, over: Record<string, unknown> = {}) => ({
  fieldId, app: 'booking', screen: fieldId.split('.')[1], route: null, anchorId: fieldId, label: 'Campo', type: 'text', entity: 'booking.reservations',
  prop: 'note', required: 'never', permission: null, sensitivity: 'internal', since: null, source: 'attr', file: 'apps/booking/src/ui/ficha.ts', line: 10, ...over,
});
const loose = (line: number, over: Record<string, unknown> = {}) => ({ app: 'booking', screen: null, file: 'apps/booking/src/ui/ficha.ts', line, tag: 'input', type: 'text', anchorId: null, label: 'Sin nombre', ...over });
const ingest = async (release: string, fields: unknown[], uninstrumented: unknown[], appId = 'booking') =>
  (await app.t.db.query<{ r: any }>(`select core.ingest_field_inventory($1, $2, $3::jsonb, $4::jsonb) r`, [appId, release, JSON.stringify(fields), JSON.stringify(uninstrumented)])).rows[0]!.r;

test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [BOOKING] }) });
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner')`, [app.users.owner]);
});
test.after(async () => { await app.close(); });

test('inventario · la carga conserva la primera release, retira lo que ya no se declara y rehace la foto de lo sin instrumentar', async () => {
  const first = await ingest('v1', [field('booking.ficha.nota'), field('booking.ficha.llegada', { type: 'date', required: 'always', sensitivity: 'personal' }), field('tasks.otra.cosa'), { fieldId: 'MAL' }],
    [loose(40), loose(40, { tag: 'select', type: 'select' }), loose(55, { app: 'tasks' })]);
  assert.deepEqual(first, { fields: 2, removed: 0, uninstrumented: 2, skipped: 3 }, 'otra app o un id inválido se saltan; dos campos en la misma línea, los dos');

  const second = await ingest('v2', [field('booking.ficha.nota', { label: 'Nota interna' }), field('booking.ficha.salida')], [loose(70)]);
  assert.deepEqual(second, { fields: 2, removed: 1, uninstrumented: 1, skipped: 0 });
  const rows = (await app.t.db.query<{ field_id: string; since: string; last_seen: string; active: boolean; removed_release: string | null; label: string }>(
    `select field_id, since, last_seen, active, removed_release, label from core.field_inventory order by field_id`)).rows;
  const by = (id: string) => rows.find((r) => r.field_id === id)!;
  assert.deepEqual([by('booking.ficha.nota').since, by('booking.ficha.nota').last_seen, by('booking.ficha.nota').label], ['v1', 'v2', 'Nota interna'], 'since se conserva');
  assert.deepEqual([by('booking.ficha.llegada').active, by('booking.ficha.llegada').removed_release], [false, 'v2']);
  assert.equal(by('booking.ficha.salida').since, 'v2');

  // Vuelve en una release posterior: activo otra vez, con su `since` de siempre.
  await ingest('v3', [field('booking.ficha.nota'), field('booking.ficha.salida'), field('booking.ficha.llegada')], []);
  const back = (await app.t.db.query<{ since: string; active: boolean }>(`select since, active from core.field_inventory where field_id = 'booking.ficha.llegada'`)).rows[0]!;
  assert.deepEqual([back.since, back.active], ['v1', true]);
  assert.equal((await app.t.db.query(`select 1 from core.field_uninstrumented where app = 'booking'`)).rows.length, 0, 'la foto es la de la última release');

  await assert.rejects(app.t.db.query(`select core.ingest_field_inventory('no_existe', 'v1', '[]'::jsonb, '[]'::jsonb)`));
  await assert.rejects(app.t.db.query(`select core.ingest_field_inventory('booking', 'v4', '{}'::jsonb, '[]'::jsonb)`));
});

test('inventario · GET usage/inventory: solo el owner de Central, por app o todo, sin lo retirado', async () => {
  await ingest('v5', [field('booking.ficha.nota', { permission: 'editor', since: '0.59' })], [loose(12, { anchorId: 'booking.ficha.buscar', label: 'Buscar' })]);
  assert.equal((await app.call('/api/v1/usage/inventory?app=all', { token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/usage/inventory?app=Booking!', { token: app.tokens.owner })).status, 422);

  const all = await app.call('/api/v1/usage/inventory?app=all', { token: app.tokens.owner });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  assert.deepEqual(all.data.fields.map((f: any) => f.fieldId), ['booking.ficha.nota'], 'solo lo activo');
  const f = all.data.fields[0];
  assert.deepEqual([f.app, f.screen, f.anchorId, f.type, f.sensitivity, f.permission, f.since, f.lastSeen, f.declaredSince], ['booking', 'ficha', 'booking.ficha.nota', 'text', 'internal', 'editor', 'v1', 'v5', '0.59']);
  assert.deepEqual(all.data.fieldsUninstrumented, [{ app: 'booking', screen: null, file: 'apps/booking/src/ui/ficha.ts', line: 12, tag: 'input', type: 'text', anchorId: 'booking.ficha.buscar', label: 'Buscar', release: 'v5' }]);

  const other = await app.call('/api/v1/usage/inventory?app=food', { token: app.tokens.owner });
  assert.deepEqual([other.status, other.data.fields, other.data.fieldsUninstrumented], [200, [], []]);
  const sql = await app.t.db.query<{ n: number }>(`select count(*)::int n from information_schema.role_table_grants where table_schema = 'core' and table_name in ('field_inventory', 'field_uninstrumented') and grantee in ('anon', 'authenticated')`);
  assert.equal(sql.rows[0]!.n, 0, 'sin permisos para anon ni authenticated');
});
