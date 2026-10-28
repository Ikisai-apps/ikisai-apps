/**
 * Tasks · la entrada en Recursos de lo recibido la escribe el servidor (`POST purchases/:id/receipt`, Recursos 0820, FO4),
 * contra el núcleo y Recursos reales: con `source_app: 'tasks'` (Finance busca así las entradas de Tasks), el mismo id estable
 * de siempre, y recibir dos veces no suma dos veces. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const TAB = uuid(), ITEM = uuid(), ALMACEN = uuid(), REQUEST = uuid();
let app: TestApp;

const receipt = (id: string, body: Record<string, unknown>) => app.call(`/api/v1/purchases/${id}/receipt`, { body });
const movements = async () => (await app.t.db.query(`select id, quantity, source_app, source_ref from resources.movements where item_id = $1 and deleted_at is null`, [ITEM])).rows as Array<{ id: string; quantity: string; source_app: string | null; source_ref: string | null }>;

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  assert.equal((await app.call('/api/v1/commands', { body: { requestId: 'tab', operations: createTabOps({ id: TAB, name: 'Casa', position: 1024 }) } })).status, 200);
  const alt = ((await app.t.db.query(`select id from resources.spaces where name = 'Altura 3'`)).rows[0] as { id: string }).id;
  await app.t.db.query(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $2, 'edificio', 'Almacén Prueba', 1)`, [ALMACEN, alt]);
  await app.t.db.query(`insert into resources.items (id, name, kind, base_unit) values ($1, 'Lejía Prueba', 'limpieza', 'l')`, [ITEM]);
  const out = await app.call('/api/v1/commands', { body: { requestId: 'pedir', operations: [
    { op: 'insert', table: 'tasks.purchase_requests', id: REQUEST, fields: { tab_id: TAB, title: 'Lejía', item_id: ITEM, quantity: 5, unit: 'l', position: 1024 } },
  ] } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
});
test.after(async () => { await app.close(); });

test('recibir: el servidor apunta la entrada con source_app tasks; repetir no suma dos veces', async () => {
  const first = await receipt(REQUEST, { spaceId: ALMACEN });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.recorded, true);
  let rows = await movements();
  assert.equal(rows.length, 1);
  assert.deepEqual([Number(rows[0]!.quantity), rows[0]!.source_app, rows[0]!.id], [5, 'tasks', first.data.movementId]);
  const again = await receipt(REQUEST, { spaceId: ALMACEN });
  assert.deepEqual([again.status, again.data.recorded], [200, false]);
  rows = await movements();
  assert.equal(rows.length, 1, 'una sola entrada');
});

test('lo que no vale: solicitud que no existe, sin sitio y quien solo lee', async () => {
  assert.equal((await receipt(uuid(), { spaceId: ALMACEN })).status, 404);
  assert.equal((await receipt(REQUEST, {})).status, 422);
  assert.equal((await app.call(`/api/v1/purchases/${REQUEST}/receipt`, { token: app.tokens.reader, body: { spaceId: ALMACEN } })).status, 403);
});
