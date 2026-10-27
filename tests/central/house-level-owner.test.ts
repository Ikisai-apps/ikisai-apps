/**
 * Central · seguridad (auditoría de rutas del 27-10, C1): un editor de Central no puede subirse de nivel en su propia
 * ficha (ni desactivar, borrar o restaurar una ficha con cuenta), ni por la Edge ni llamando a core.commit directamente.
 * Las fichas sin cuenta las siguen llevando los editores. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { TABLES, accountGuardIssue, accountGuardTargets } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `c1-${++seq}`, operations } });
const revision = async (id: string) => Number((await app.t.db.query<{ r: string }>(`select revision as r from central.people where id = $1`, [id])).rows[0]!.r);
const ownerships = async (user: string) => (await app.t.db.query<{ app: string }>(`select app from core.memberships where user_id = $1 and role = 'owner' order by app`, [user])).rows.map((r) => r.app);

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('C1 · dominio: de quien no es owner, se miran el nivel, la actividad, el borrado y la restauración de fichas', () => {
  const ops = [
    { op: 'update', table: TABLES.people, id: 'a', fields: { house_level: 'direccion' } },
    { op: 'update', table: TABLES.people, id: 'b', fields: { display_name: 'Otro nombre' } },
    { op: 'update', table: TABLES.people, id: 'c', fields: { active: false } },
    { op: 'delete', table: TABLES.people, id: 'd' },
    { op: 'restore', table: TABLES.people, id: 'e' },
  ];
  assert.deepEqual(accountGuardTargets(ops, { role: 'editor' }).map((t) => t.id), ['a', 'c', 'd', 'e']);
  assert.deepEqual(accountGuardTargets(ops, { role: 'owner' }), []);
  assert.equal(accountGuardIssue(accountGuardTargets(ops, { role: 'editor' }), new Set(['c']))?.details.index, 2);
  assert.equal(accountGuardIssue(accountGuardTargets(ops, { role: 'editor' }), new Set(['b'])), null);
});

test('C1 · un editor no se pone «dirección» en su propia ficha: ni por la Edge ni por core.commit; no gana ningún owner', async () => {
  const editor = app.users.editor;
  const mine = uuid(); const other = uuid();
  const setup = await commit([
    { op: 'insert', table: TABLES.people, id: mine, fields: { display_name: 'Editor Ficticio', relation: 'colaborador', house_level: 'outsider', user_id: editor } },
    { op: 'insert', table: TABLES.people, id: other, fields: { display_name: 'Sin Cuenta Ficticia', relation: 'colaborador' } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));
  const before = await ownerships(editor);

  // 1. Por la Edge (lo que hacía la escalada): 403, y tampoco desactivar ni borrar la ficha con cuenta.
  for (const op of [
    { op: 'update', table: TABLES.people, id: mine, expectedRevision: await revision(mine), fields: { house_level: 'direccion' } },
    { op: 'update', table: TABLES.people, id: mine, expectedRevision: await revision(mine), fields: { active: false } },
    { op: 'delete', table: TABLES.people, id: mine, expectedRevision: await revision(mine) },
  ]) {
    const out = await commit([op], app.tokens.editor);
    assert.equal(out.status, 403, JSON.stringify(out.data));
    assert.equal((out.data as { error: { code: string } }).error.code, 'FORBIDDEN');
  }

  // 2. Saltándose la Edge, directo a core.commit con el editor como actor: lo para el hook de la base (1518).
  const operations = [{ op: 'update', table: TABLES.people, id: mine, expectedRevision: await revision(mine), fields: { house_level: 'direccion' } }];
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: editor, p_request_id: `c1-direct-${uuid()}`, p_digest: 'c1', p_expected_cursor: null, p_operations: operations }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  // La misma escalada por la cuenta: una ficha nueva de «dirección» con su propia cuenta. El trigger le daría owner antes
  // que los hooks; la base mira el rol con el que empezó el lote.
  // (Con otro editor que aún no tiene ficha: una cuenta solo puede estar en una.)
  const second = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'editor')`, [second]);
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: second, p_request_id: `c1-link-${uuid()}`, p_digest: 'c1-link', p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: TABLES.people, id: uuid(), fields: { display_name: 'Dirección Ficticia', relation: 'equipo', house_level: 'direccion', user_id: second } }] }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  assert.deepEqual(await ownerships(second), [], 'el segundo editor tampoco gana owner');

  const [row] = (await app.t.db.query<{ l: string; a: boolean; d: string | null }>(`select house_level as l, active as a, deleted_at as d from central.people where id = $1`, [mine])).rows;
  assert.deepEqual([row!.l, row!.a, row!.d], ['outsider', true, null]);
  assert.deepEqual(await ownerships(editor), before, 'el editor no gana owner en ninguna app');

  // 3. Las fichas sin cuenta, igual que antes: el editor les pone nivel.
  const free = await commit([{ op: 'update', table: TABLES.people, id: other, expectedRevision: await revision(other), fields: { house_level: 'staff' } }], app.tokens.editor);
  assert.equal(free.status, 200, JSON.stringify(free.data));

  // 4. El owner sí cambia el nivel de una ficha con cuenta.
  const byOwner = await commit([{ op: 'update', table: TABLES.people, id: mine, expectedRevision: await revision(mine), fields: { house_level: 'staff' } }]);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.data));
});
