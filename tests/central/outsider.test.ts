/**
 * Central · O4, caracterización (PR 0): qué hace hoy el nivel de casa con los accesos y con la fusión, antes de que llegue el
 * rol `outsider` del núcleo (O1, migración 0092). Datos ficticios.
 *
 * Al programar O4 cambia a propósito solo esto: poner `outsider` a una ficha con cuenta pasa sus accesos de Tasks y Guests a
 * `outsider`, y quitarlo los devuelve. Lo demás (dirección y staff sin accesos derivados, la fusión) debe seguir igual.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { MERGE_PEOPLE_PROCEDURE, TABLES } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `outsider-${++seq}`, operations } });
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;
const revision = async (id: string) => Number((await rows(`select revision from central.people where id = $1`, [id]))[0].revision);
const update = async (id: string, fields: Record<string, unknown>) => {
  const out = await commit([{ op: 'update', table: TABLES.people, id, expectedRevision: await revision(id), fields }]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
};

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('caracterización O4 · el nivel de casa no toca los accesos: ni al ponerlo, cambiarlo o quitarlo, ni al desenlazar, desactivar o borrar', async () => {
  const user = await app.t.createUser();
  // Huésped con su membresía de portal (lector con `scopes`) y lector de Tasks puesto a mano.
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'reader', null), ('guests', $1, 'reader', $2::jsonb)`,
    [user, JSON.stringify({ grants: [{ reservation_id: uuid(), guest_id: uuid() }] })]);
  const memberships = async () => rows(`select app, role, scopes from core.memberships where user_id = $1 order by app`, [user]);
  const before = await memberships();
  // Recursos sale sola: es la membresía derivada del núcleo (quien está en Tasks lo está en Recursos).
  assert.deepEqual(before.map((m) => [m.app, m.role]), [['guests', 'reader'], ['resources', 'reader'], ['tasks', 'reader']]);

  const id = uuid();
  const created = await commit([{ op: 'insert', table: TABLES.people, id, fields: { display_name: 'Olga Ficticia', relation: 'otro', user_id: user } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  // Dirección y staff: seguirá así después de O4 (decisión del usuario: de momento solo el outsider deriva roles).
  for (const level of ['staff', 'direccion', null]) {
    await update(id, { house_level: level });
    assert.deepEqual(await memberships(), before, `nivel ${level}`);
  }
  // Outsider: HOY no da nada. Con O4 esta aserción cambia a propósito (tasks y guests pasan a `outsider`).
  await update(id, { house_level: 'outsider' });
  assert.deepEqual(await memberships(), before, 'outsider (hoy)');
  await update(id, { user_id: null });
  await update(id, { user_id: user });
  await update(id, { active: false });
  assert.deepEqual(await memberships(), before, 'desenlazar, enlazar y desactivar (hoy)');
  const del = await commit([{ op: 'delete', table: TABLES.people, id, expectedRevision: await revision(id) }]);
  assert.equal(del.status, 200, JSON.stringify(del.data));
  assert.deepEqual(await memberships(), before, 'papelera (hoy)');
  assert.equal((await rows(`select house_level from central.people where id = $1`, [id]))[0].house_level, 'outsider'); // la papelera conserva el nivel
});

test('caracterización O4 · fusión: se queda el nivel de la ficha de destino; las capacidades pasan y se leen según ese nivel', async () => {
  const trade = uuid();
  const [outsider, noLevel, staff, outsider2] = [uuid(), uuid(), uuid(), uuid()];
  const person = (id: string, name: string, house_level: string | null) => ({ op: 'insert', table: TABLES.people, id, fields: { display_name: name, relation: 'otro', house_level } });
  const setup = await commit([
    { op: 'insert', table: TABLES.trades, id: trade, fields: { name: 'Jardinería Caracterización' } },
    person(outsider, 'Pablo Ficticio', 'outsider'), person(noLevel, 'Pablo F.', null),
    person(staff, 'Rita Ficticia', 'staff'), person(outsider2, 'Rita F.', 'outsider'),
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: outsider, trade_id: trade, level: 2 } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: staff, trade_id: trade, level: 1 } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const merge = async (from: string, into: string) => {
    const out = await commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from, into } }]);
    assert.equal(out.status, 200, JSON.stringify(out.data));
  };
  const level = async (id: string) => (await rows(`select house_level from central.people where id = $1`, [id]))[0].house_level;
  const capable = async () => (await rows(`select person_id, level from central.capability_options where trade_id = $1 order by person_id`, [trade])).map((r) => [r.person_id, r.level]);
  assert.deepEqual(await capable(), [[outsider, 2], [staff, 1]].sort());

  // El outsider se fusiona en una ficha sin nivel: la que queda sigue sin nivel, y su capacidad deja de leerse (hoy).
  await merge(outsider, noLevel);
  assert.equal(await level(noLevel), null);
  assert.equal((await rows(`select 1 from central.person_trades where deleted_at is null and person_id = $1 and trade_id = $2`, [noLevel, trade])).length, 1);
  // Una ficha outsider se fusiona en una de staff: queda staff.
  await merge(outsider2, staff);
  assert.equal(await level(staff), 'staff');
  assert.deepEqual(await capable(), [[staff, 1]]);
});
