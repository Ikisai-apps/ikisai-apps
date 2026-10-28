/**
 * Recursos · el oficio de un artículo (migración 0819, R2 de Tasks): `trade_id` opcional, validado con central.trade_alive;
 * la categoría de texto se conserva.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const ITEMS = 'resources.items';
const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) =>
  app.call('/api/v1/resources/commands', { token, body: { requestId: `it-${++seq}`, operations } });
const rev = async (id: string) =>
  Number((await app.t.db.query<{ revision: string }>(`select revision from resources.items where id = $1`, [id])).rows[0]!.revision);

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
});
test.after(async () => { await app.close(); });

test('oficio · un artículo lleva un oficio vivo de Central o ninguno; uno retirado o inventado, no; la categoría sigue', async () => {
  const fontaneria = uuid(); const retirado = uuid();
  await app.t.db.query(`insert into central.trades (id, name, active) values ($1, 'Fontanería', true), ($2, 'Oficio retirado', false)`, [fontaneria, retirado]);
  const llave = uuid(); const cinta = uuid();
  const ok = (res: { status: number; data: any }) => assert.equal(res.status, 200, JSON.stringify(res.data));
  const fails = (res: { status: number; data: any }) => { assert.equal(res.status, 422, JSON.stringify(res.data)); assert.equal(res.data?.error?.code, 'INVALID_TRADE'); };

  // Con oficio vivo y con su categoría de siempre.
  ok(await commit([{ op: 'insert', table: ITEMS, id: llave, fields: { name: 'Llave inglesa', kind: 'herramienta', base_unit: 'ud', category: 'Fontanería', trade_id: fontaneria } }], app.tokens.owner));
  // Sin oficio, como hasta ahora.
  ok(await commit([{ op: 'insert', table: ITEMS, id: cinta, fields: { name: 'Cinta de teflón', kind: 'material', base_unit: 'ud', category: 'Fontanería' } }], app.tokens.owner));
  // Un oficio retirado o que no existe, no.
  fails(await commit([{ op: 'update', table: ITEMS, id: cinta, expectedRevision: await rev(cinta), fields: { trade_id: retirado } }], app.tokens.owner));
  fails(await commit([{ op: 'insert', table: ITEMS, id: uuid(), fields: { name: 'Otra', kind: 'material', base_unit: 'ud', trade_id: uuid() } }], app.tokens.owner));
  // Asignar y quitar el oficio a uno que ya existe.
  ok(await commit([{ op: 'update', table: ITEMS, id: cinta, expectedRevision: await rev(cinta), fields: { trade_id: fontaneria } }], app.tokens.owner));
  ok(await commit([{ op: 'update', table: ITEMS, id: cinta, expectedRevision: await rev(cinta), fields: { trade_id: null } }], app.tokens.owner));

  const rows = (await app.t.db.query<{ id: string; trade_id: string | null; category: string | null }>(`select id, trade_id, category from resources.items where id = any($1)`, [[llave, cinta]])).rows;
  const by = new Map(rows.map((r) => [r.id, r]));
  assert.deepEqual([by.get(llave)!.trade_id, by.get(llave)!.category], [fontaneria, 'Fontanería']);
  assert.deepEqual([by.get(cinta)!.trade_id, by.get(cinta)!.category], [null, 'Fontanería']);
});
