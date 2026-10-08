/** Central · una persona, una ficha, una cuenta: fusionar dos fichas de la misma persona (`central.merge_people`). Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  COMPLIANCE_TABLES, DECISIONS_TABLE, MERGE_PEOPLE_PROCEDURE, RECORD_KINDS, REQUIREMENT_TYPES, TABLES, recordTypesFor, validateOperations,
} from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `merge-${++seq}`, operations } });
const rows = async (sql: string, args: unknown[] = []) => (await app.t.db.query<any>(sql, args)).rows;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('fusión · dominio: solo el procedimiento de fusionar, solo el owner; `merged_into` no se escribe a mano', () => {
  const call = (args: Record<string, unknown>) => [{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args }];
  assert.equal(validateOperations(call({ from: 'a', into: 'b' }), { role: 'owner' }), null);
  assert.equal(validateOperations(call({ from: 'a', into: 'b' }), { role: 'editor', scopes: { people: true } })?.code, 'FORBIDDEN');
  assert.equal(validateOperations(call({ from: 'a', into: 'a' }), { role: 'owner' })?.code, 'INVALID_OPERATION');
  assert.equal(validateOperations([{ op: 'call', procedure: 'central.otra', args: {} }], { role: 'owner' })?.code, 'INVALID_OPERATION');
  assert.equal(validateOperations([{ op: 'update', table: TABLES.people, id: 'x', fields: { merged_into: 'y' } }], { role: 'owner' })?.details.field, 'merged_into');
});

test('fusión · la ficha con cuenta se queda con todo; la otra, a la papelera apuntando a ella', async () => {
  const account = await app.t.createUser();
  const keep = uuid(); const dup = uuid(); const t1 = uuid(); const t2 = uuid(); const req = uuid(); const dec = uuid();
  const kind = RECORD_KINDS[0]!;
  const setup = await commit([
    { op: 'insert', table: TABLES.people, id: keep, fields: { display_name: 'Ana Prueba', relation: 'equipo', user_id: account } },
    { op: 'insert', table: TABLES.people, id: dup, fields: { display_name: 'Ana P.', relation: 'equipo', availability_notes: 'Solo mañanas', committed_post: true } },
    { op: 'insert', table: TABLES.personPrivate, id: uuid(), fields: { person_id: keep, legal_name: 'Ana Prueba Ficticia' } },
    { op: 'insert', table: TABLES.personPrivate, id: uuid(), fields: { person_id: dup, legal_name: 'Otro nombre', email: 'ana@example.invalid', phone: '600000000' } },
    { op: 'insert', table: TABLES.personRecords, id: uuid(), fields: { person_id: dup, kind, record_type: recordTypesFor(kind)[0], title: 'Curso de prueba' } },
    { op: 'insert', table: TABLES.teams, id: t1, fields: { name: 'Equipo uno' } },
    { op: 'insert', table: TABLES.teams, id: t2, fields: { name: 'Equipo dos' } },
    { op: 'insert', table: TABLES.personTeams, id: uuid(), fields: { person_id: keep, team_id: t1 } },
    { op: 'insert', table: TABLES.personTeams, id: uuid(), fields: { person_id: dup, team_id: t1 } },
    { op: 'insert', table: TABLES.personTeams, id: uuid(), fields: { person_id: dup, team_id: t2 } },
    { op: 'insert', table: COMPLIANCE_TABLES.requirements, id: req, fields: { name: 'Obligación de prueba', requirement_type: REQUIREMENT_TYPES[0], responsible_person_id: dup } },
    { op: 'insert', table: DECISIONS_TABLE, id: dec, fields: { decided_on: '2026-10-08', name: 'Decisión de prueba', summary: 'Resumen.', responsible_person_id: dup } },
  ]);
  assert.equal(setup.status, 200, JSON.stringify(setup.data));

  const merge = (token?: string) => commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from: dup, into: keep } }], token);
  assert.equal((await merge(app.tokens.editor)).status, 403);
  const out = await merge();
  assert.equal(out.status, 200, JSON.stringify(out.data));

  const [d] = await rows(`select deleted_at, merged_into, user_id from central.people where id = $1`, [dup]);
  assert.ok(d.deleted_at); assert.equal(d.merged_into, keep); assert.equal(d.user_id, null);
  const [k] = await rows(`select deleted_at, user_id, availability_notes, committed_post from central.people where id = $1`, [keep]);
  assert.deepEqual([k.deleted_at, k.user_id, k.availability_notes, k.committed_post], [null, account, 'Solo mañanas', true]);
  // Datos reservados: se completan los huecos; lo que la que queda ya tenía, se respeta.
  const priv = await rows(`select person_id, legal_name, email, phone from central.person_private where deleted_at is null and person_id in ($1, $2)`, [keep, dup]);
  assert.deepEqual(priv, [{ person_id: keep, legal_name: 'Ana Prueba Ficticia', email: 'ana@example.invalid', phone: '600000000' }]);
  assert.deepEqual(await rows(`select person_id, title from central.person_records where deleted_at is null and person_id in ($1, $2)`, [keep, dup]), [{ person_id: keep, title: 'Curso de prueba' }]);
  assert.deepEqual((await rows(`select team_id from central.person_teams where deleted_at is null and person_id = $1`, [keep])).map((r) => r.team_id).sort(), [t1, t2].sort());
  assert.equal((await rows(`select 1 from central.person_teams where deleted_at is null and person_id = $1`, [dup])).length, 0);
  assert.equal((await rows(`select responsible_person_id as r from ${COMPLIANCE_TABLES.requirements} where id = $1`, [req]))[0].r, keep);
  assert.equal((await rows(`select responsible_person_id as r from ${DECISIONS_TABLE} where id = $1`, [dec]))[0].r, keep);

  // Tasks sabe a qué ficha pasó la fusionada.
  const tasksUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'reader')`, [tasksUser]);
  const merges = await app.t.rpc('core_read', { p_app: 'tasks', p_actor: tasksUser, p_name: 'central.people_merges', p_args: {} }) as { rows: any[] };
  assert.deepEqual(merges.rows.map((r) => [r.person_id, r.merged_into]), [[dup, keep]]);

  // Nunca dos fichas con la misma cuenta, ni fusionar dos fichas con cuentas distintas.
  const other = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: other, fields: { display_name: 'Ana duplicada', relation: 'equipo', user_id: account } }])).data.error.code, 'CONSTRAINT_VIOLATION');
  const second = await app.t.createUser();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: other, fields: { display_name: 'Otra persona', relation: 'equipo', user_id: second } }])).status, 200);
  const bad = await commit([{ op: 'call', procedure: MERGE_PEOPLE_PROCEDURE, args: { from: other, into: keep } }]);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
});
