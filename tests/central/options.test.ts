/**
 * Central · lecturas para Tasks de P2 y O1 (1509): iniciales en la ficha y en `people_options`, disponibilidad aparte
 * (`availability_options`) y las tres lecturas de opciones abiertas al outsider sin nada reservado. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { TABLES, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `options-${++seq}`, operations } });
const member = async (appId: string, role: string) => {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, $3)`, [appId, user, role]);
  return user;
};
const read = async (actor: string, name: string) => (await app.t.rpc('core_read', { p_app: 'tasks', p_actor: actor, p_name: name, p_args: {} }) as { rows: any[] }).rows;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('iniciales · opcionales, de 1 a 4 caracteres y sin espacios a los lados (dominio y base)', async () => {
  const op = (initials: unknown) => [{ op: 'insert', table: TABLES.people, id: uuid(), fields: { display_name: 'Iniciales Ficticia', relation: 'equipo', initials } }];
  assert.equal(validateOperations(op('OF'), { role: 'owner' }), null);
  assert.equal(validateOperations(op('Mª J'), { role: 'owner' }), null);
  assert.equal(validateOperations(op(null), { role: 'owner' }), null);
  for (const bad of ['', 'ABCDE', ' OF', 'OF ']) assert.equal(validateOperations(op(bad), { role: 'owner' })?.details.field, 'initials', `«${bad}»`);
  const id = uuid();
  const ok = await commit([{ op: 'insert', table: TABLES.people, id, fields: { display_name: 'Iniciales Ficticia', relation: 'equipo', initials: 'IF' } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  for (const bad of ['', 'ABCDE', ' IF']) await assert.rejects(app.t.db.query(`update central.people set initials = $2 where id = $1`, [id, bad]), `«${bad}»`);
});

test('lecturas para Tasks · iniciales en people_options; disponibilidad aparte con su orden; el outsider lee quién y qué oficio, y nada más', async () => {
  const ana = uuid(); const blas = uuid(); const trade = uuid();
  const ok = await commit([
    { op: 'insert', table: TABLES.people, id: ana, fields: { display_name: 'Ana Opciones', relation: 'equipo', house_level: 'staff', initials: 'AO', availability: 'baja', availability_notes: 'Nota reservada ficticia' } },
    { op: 'insert', table: TABLES.people, id: blas, fields: { display_name: 'Blas Opciones', relation: 'equipo', house_level: 'staff', availability: 'alta' } },
    { op: 'insert', table: 'central.person_private', id: uuid(), fields: { person_id: ana, email: 'reservado@example.invalid', phone: '600000000' } },
    { op: 'insert', table: TABLES.trades, id: trade, fields: { name: 'Carpintería Opciones', notes: 'Nota de oficio ficticia' } },
    { op: 'insert', table: TABLES.personTrades, id: uuid(), fields: { person_id: ana, trade_id: trade, level: 2, note: 'Nota de capacidad ficticia' } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));

  const reader = await member('tasks', 'reader');
  const outsider = await member('tasks', 'outsider');
  // Columnas exactas de cada lectura: lo mismo para el lector y para el outsider.
  const columns = {
    'central.people_options': ['active', 'house_level', 'initials', 'name', 'person_id', 'user_id'],
    'central.trade_options': ['name', 'parent_id', 'path', 'position', 'source_label_id', 'trade_id'],
    'central.capability_options': ['inherited', 'level', 'person_id', 'trade_id'], // 1510: + inherited
  };
  for (const actor of [reader, outsider]) {
    for (const [name, keys] of Object.entries(columns)) {
      const out = await read(actor, name);
      assert.ok(out.length > 0, name);
      for (const r of out) assert.deepEqual(Object.keys(r).sort(), keys, name);
      const all = JSON.stringify(out);
      for (const secret of ['reservado@example.invalid', '600000000', 'Nota reservada ficticia', 'Nota de oficio ficticia', 'Nota de capacidad ficticia', 'baja', 'alta']) {
        assert.equal(all.includes(secret), false, `${name} trae «${secret}»`);
      }
    }
    const people = await read(actor, 'central.people_options');
    assert.deepEqual(people.filter((p) => String(p.name).endsWith('Opciones')).map((p) => [p.name, p.initials]).sort(), [['Ana Opciones', 'AO'], ['Blas Opciones', null]]);
    assert.deepEqual((await read(actor, 'central.capability_options')).filter((c) => c.trade_id === trade).map((c) => [c.person_id, c.level]), [[ana, 2]]);
  }

  // Disponibilidad: el lector de Tasks sí, con el orden para «Quién sabe hacerlo»; el outsider no; nunca las notas.
  const avail = (await read(reader, 'central.availability_options')).filter((a) => a.person_id === ana || a.person_id === blas);
  for (const a of avail) assert.deepEqual(Object.keys(a).sort(), ['availability', 'availability_rank', 'person_id']);
  assert.deepEqual(avail.sort((x, y) => x.availability_rank - y.availability_rank).map((a) => [a.person_id, a.availability, a.availability_rank]),
    [[blas, 'alta', 1], [ana, 'baja', 4]]);
  await assert.rejects(read(outsider, 'central.availability_options'));
  const order = { alta: 1, media: 2, segun_calendario: 3, baja: 4, no_disponible: 5 };
  for (const [value, rank] of Object.entries(order)) {
    await app.t.db.query(`update central.people set availability = $2 where id = $1`, [ana, value]);
    const [r] = (await app.t.db.query<{ rank: number }>(`select availability_rank as rank from central.availability_options where person_id = $1`, [ana])).rows;
    assert.equal(r?.rank, rank, value);
  }

  // Otra app sin permiso registrado sigue sin leerlas.
  const food = await member('food', 'reader');
  for (const name of [...Object.keys(columns), 'central.availability_options']) {
    await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: food, p_name: name, p_args: {} }), name);
  }
});
