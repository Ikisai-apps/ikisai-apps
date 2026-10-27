/** Recursos · EPI y lo que pide cada máquina (migración 0813, R3 de Tasks, FB_2026_071). Datos sintéticos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const uuid = () => crypto.randomUUID();
const LINKS = 'resources.item_links';
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `ppe-${++seq}`, operations } });
const rev = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);

const RADIAL = uuid(), GAFAS = uuid(), OREJERAS = uuid(), TUBO = uuid();

test.before(async () => {
  app = await createTestApp({ app: 'food', slug: 'food-api', origin: 'https://food.ikisai.com',
    createHandler: (config) => createApp({ ...config, app: 'food', slug: 'food-api' }) });
});
test.after(async () => { await app.close(); });

test('EPI · el tipo existe y cada EPI dice qué parte del cuerpo protege', async () => {
  const kind = await app.t.db.query<{ label: string; consumable: boolean }>(`select label, consumable from resources.item_kinds where kind = 'epi' and deleted_at is null`);
  assert.deepEqual(kind.rows[0], { label: 'EPI', consumable: false });
  const ok = await commit([
    { op: 'insert', table: 'resources.items', id: RADIAL, fields: { name: 'Radial de ejemplo', kind: 'maquina', base_unit: 'ud' } },
    { op: 'insert', table: 'resources.items', id: GAFAS, fields: { name: 'Gafas de ejemplo', kind: 'epi', base_unit: 'ud', attributes: { body_parts: ['eyes'] } } },
    { op: 'insert', table: 'resources.items', id: OREJERAS, fields: { name: 'Orejeras de ejemplo', kind: 'epi', base_unit: 'ud', attributes: { body_parts: ['ears', 'head'] } } },
    { op: 'insert', table: 'resources.items', id: TUBO, fields: { name: 'Tubo de ejemplo', kind: 'material', base_unit: 'm' } },
  ], app.tokens.editor);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  for (const body_parts of [['ojos'], [], ['eyes', 'eyes'], 'eyes']) {
    const bad = await commit([{ op: 'insert', table: 'resources.items', id: uuid(), fields: { name: `Mal ${++seq}`, kind: 'epi', base_unit: 'ud', attributes: { body_parts } } }], app.tokens.editor);
    assert.equal(bad.status, 422, JSON.stringify(body_parts));
  }
});

test('vínculos · una máquina pide EPI; uno por pareja; el ligado tiene que ser EPI y el que pide no', async () => {
  const one = uuid(), two = uuid();
  const ok = await commit([
    { op: 'insert', table: LINKS, id: one, fields: { item_id: RADIAL, linked_item_id: GAFAS } },
    { op: 'insert', table: LINKS, id: two, fields: { item_id: RADIAL, linked_item_id: OREJERAS } },
  ], app.tokens.editor);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const linked = (await app.t.db.query<{ linked_item_id: string }>(`select linked_item_id from resources.item_links where item_id = $1 and deleted_at is null order by linked_item_id`, [RADIAL])).rows.map((r) => r.linked_item_id);
  assert.deepEqual(linked, [GAFAS, OREJERAS].sort());

  // La misma pareja dos veces, no.
  assert.notEqual((await commit([{ op: 'insert', table: LINKS, id: uuid(), fields: { item_id: RADIAL, linked_item_id: GAFAS } }], app.tokens.editor)).status, 200);
  // Un material como EPI, un EPI que pide otro, o un artículo a sí mismo, no.
  for (const fields of [{ item_id: RADIAL, linked_item_id: TUBO }, { item_id: GAFAS, linked_item_id: OREJERAS }, { item_id: RADIAL, linked_item_id: RADIAL }]) {
    const bad = await commit([{ op: 'insert', table: LINKS, id: uuid(), fields }], app.tokens.editor);
    assert.notEqual(bad.status, 200, JSON.stringify(fields));
  }
  // Quien solo lee, tampoco.
  assert.equal((await commit([{ op: 'insert', table: LINKS, id: uuid(), fields: { item_id: TUBO, linked_item_id: GAFAS } }], app.tokens.reader)).status, 403);

  // Un EPI que una máquina pide no deja de ser EPI; quitado el vínculo, sí.
  const blocked = await commit([{ op: 'update', table: 'resources.items', id: GAFAS, expectedRevision: await rev('resources.items', GAFAS), fields: { kind: 'material' } }], app.tokens.editor);
  assert.equal(blocked.status, 422, JSON.stringify(blocked.data));
  assert.equal(blocked.data.error.code, 'ITEM_IN_USE');
  assert.equal((await commit([{ op: 'delete', table: LINKS, id: one, expectedRevision: await rev(LINKS, one) }], app.tokens.editor)).status, 200);
  const freed = await commit([{ op: 'update', table: 'resources.items', id: GAFAS, expectedRevision: await rev('resources.items', GAFAS), fields: { kind: 'material' } }], app.tokens.editor);
  assert.equal(freed.status, 200, JSON.stringify(freed.data));
});
