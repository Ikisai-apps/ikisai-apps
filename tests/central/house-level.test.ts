/** Central · fase P1: nivel de casa (dominio, base y lectura para Tasks). Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { HOUSE_LEVELS, TABLES, proposeHouseLevel, relationForLevel, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `level-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('nivel de casa · dominio: propuesta aprobada, relación que se sigue escribiendo y validación', () => {
  assert.deepEqual([...HOUSE_LEVELS], ['direccion', 'staff', 'outsider']);
  assert.equal(proposeHouseLevel({ relation: 'equipo', base_role: 'direccion_general' }), 'direccion');
  assert.equal(proposeHouseLevel({ relation: 'colaborador', base_role: 'direccion_operativa_comercial' }), 'direccion');
  assert.equal(proposeHouseLevel({ relation: 'equipo', base_role: 'cocina' }), 'staff');
  assert.equal(proposeHouseLevel({ relation: 'practicas', base_role: 'otro' }), 'staff');
  assert.equal(proposeHouseLevel({ relation: 'colaborador', base_role: 'otro' }), 'outsider');
  assert.equal(proposeHouseLevel({ relation: 'voluntario', base_role: 'limpieza' }), 'outsider');
  assert.equal(proposeHouseLevel({ relation: 'otro', base_role: 'otro' }), null);
  assert.deepEqual([relationForLevel('direccion'), relationForLevel('staff'), relationForLevel('outsider'), relationForLevel(null)], ['equipo', 'equipo', 'colaborador', 'otro']);
  const op = (house_level: unknown) => [{ op: 'update', table: TABLES.people, id: 'x', fields: { house_level } }];
  assert.equal(validateOperations(op('staff'), { role: 'owner' }), null);
  assert.equal(validateOperations(op(null), { role: 'owner' }), null);
  assert.equal(validateOperations(op('voluntario'), { role: 'owner' })?.details.field, 'house_level');
});

test('nivel de casa · la base solo admite los tres niveles; la relación se conserva; people_options trae el nivel sin cambiar de contenido', async () => {
  const withLevel = crypto.randomUUID(); const without = crypto.randomUUID();
  const ok = await commit([
    { op: 'insert', table: TABLES.people, id: withLevel, fields: { display_name: 'Nivel Ficticio', relation: 'voluntario', house_level: 'outsider' } },
    { op: 'insert', table: TABLES.people, id: without, fields: { display_name: 'Sin Nivel Ficticio', relation: 'otro' } },
  ]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  await assert.rejects(app.t.db.query(`update central.people set house_level = 'otro' where id = $1`, [withLevel]));
  const [row] = (await app.t.db.query<{ r: string; l: string }>(`select relation as r, house_level as l from central.people where id = $1`, [withLevel])).rows;
  assert.deepEqual(row, { r: 'voluntario', l: 'outsider' });

  const tasksUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [tasksUser]);
  const out = await app.t.rpc('core_read', { p_app: 'tasks', p_actor: tasksUser, p_name: 'central.people_options', p_args: {} }) as { rows: any[] };
  const mine = out.rows.filter((r) => String(r.name).endsWith('Ficticio')).map((r) => [r.name, r.house_level]).sort();
  // En P1 siguen las dos, también la que no tiene nivel: Tasks decidirá en P2 (sección 17).
  assert.deepEqual(mine, [['Nivel Ficticio', 'outsider'], ['Sin Nivel Ficticio', null]]);
});
