/** Food · lo que Food ofrece en el catálogo de capacidades del núcleo (1113, con campos en la 1120) y la ejecución «Usar en otro evento». */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const carta = uuid(), recipe = uuid();
let event = '';

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  event = await seedBookingEvent(app, { title: 'Jornadas abiertas', start: day(10), end: day(11) });
  const res = await app.call('/api/v1/commands', { body: { requestId: 'cap-1', operations: [
    insert('food.recipes', recipe, { name: 'Montadito', category: 'entrante', base_servings: 1 }),
    insert('food.menus', carta, { kind: 'carta', name: 'Barra base', prep_split: { mesa: 40, nevera: 20, fresco: 40 } }),
    insert('food.carta_lines', uuid(), { menu_id: carta, recipe_id: recipe, scope: 'clasico', code: 'A', sale_price_cents: 250, expected_units: 80, per_person: 0.4 }),
  ] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
});
test.after(async () => { await app.close(); });

test('catálogo · lecturas y ejecución de Food, con rutas, roles y anclajes', async () => {
  const rows = await q(`select id, kind, route, roles, risk, idempotent, anchors from core.capabilities where app = 'food' order by id`);
  assert.deepEqual(rows.map((r) => [r.id, r.kind, r.route]), [
    ['food.carta_prep', 'read', 'GET read/food.carta_prep_totals_projection'],
    ['food.carta_prep_lines', 'read', 'GET read/food.carta_prep_projection'],
    ['food.event_needs', 'read', 'POST read/food.event_needs'],
    ['food.event_offers', 'read', 'GET read/food.event_offers_projection'],
    ['food.use_carta_in_event', 'execute', 'POST carta/:id/use-in-event'],
  ]);
  assert.ok(rows.every((r) => r.risk === 'low' && r.idempotent && r.anchors.length > 0));
  // Las lecturas a las que apuntan existen para Food.
  const reads = (await q(`select name from core.allowed_reads where app = 'food'`)).map((r) => r.name);
  for (const name of ['food.carta_prep_totals_projection', 'food.carta_prep_projection', 'food.event_needs', 'food.event_offers_projection']) assert.ok(reads.includes(name), name);
});

test('catálogo · cada capacidad dice qué campos lee y escribe (0111): `food.<tabla>.<columna>` que existen', async () => {
  const rows = await q(`select id, kind, reads, writes from core.capabilities where app = 'food' order by id`);
  const columns = new Set((await q(`select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'food'`)).map((r) => `food.${r.c}`));
  for (const r of rows) {
    assert.ok(r.reads.length > 0, `${r.id} sin reads`);
    if (r.kind === 'read') assert.deepEqual(r.writes, [], `${r.id}: una lectura no escribe`);
    for (const f of [...r.reads, ...r.writes]) assert.ok(columns.has(f), `${r.id}: ${f} no es una columna de Food`);
  }
  const copy = rows.find((r) => r.id === 'food.use_carta_in_event')!;
  for (const f of ['food.menus.event_id', 'food.carta_lines.sale_price_cents', 'food.event_offers.payer']) assert.ok(copy.writes.includes(f), f);
});

test('ejecución · «Usar en otro evento» copia la carta y crea su oferta; repetir devuelve la misma copia', async () => {
  const call = () => app.call(`/api/v1/carta/${carta}/use-in-event`, { body: { requestId: 'flow-copia-1', eventId: event, name: 'Barra de las jornadas' } });
  const first = await call();
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([first.data.name, first.data.lines, first.data.eventId, first.data.replayed], ['Barra de las jornadas', 1, event, false]);
  const copy = (await q(`select kind, name, event_id, prep_split from food.menus where id = $1`, [first.data.menuId]))[0];
  assert.deepEqual(copy, { kind: 'carta', name: 'Barra de las jornadas', event_id: event, prep_split: { mesa: 40, nevera: 20, fresco: 40 } });
  const lines = await q(`select code, sale_price_cents, expected_units, per_person::float8 as per_person from food.carta_lines where menu_id = $1`, [first.data.menuId]);
  assert.deepEqual(lines, [{ code: 'A', sale_price_cents: 250, expected_units: 80, per_person: 0.4 }]);
  const offer = (await q(`select event_id, menu_id, payer, charge_when from food.event_offers where id = $1`, [first.data.offerId]))[0];
  assert.deepEqual(offer, { event_id: event, menu_id: first.data.menuId, payer: 'huesped', charge_when: 'barra' });

  const again = await call();
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.deepEqual([again.data.menuId, again.data.replayed], [first.data.menuId, true]);
  assert.equal((await q(`select count(*)::int as n from food.menus where name = 'Barra de las jornadas'`))[0].n, 1, 'sin duplicar');

  const missing = await app.call(`/api/v1/carta/${uuid()}/use-in-event`, { body: { requestId: 'flow-copia-2' } });
  assert.equal(missing.data.error.code, 'CARTA_NOT_FOUND');
});
