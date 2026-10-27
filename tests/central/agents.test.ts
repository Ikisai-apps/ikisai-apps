/**
 * Central · fichas de agente (1520; decisión de VG del 27-10: tabla propia y responsable persona o entidad de servicio).
 * Solo el owner las cambia; sin responsable no se activan; la cuenta enlazada es de agente; la persona responsable es una
 * ficha activa y no se borra mientras responda; revocar las claves no toca la ficha. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { AGENTS_TABLE, TABLES, hasResponsible, successorChain, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `ag-${++seq}`, operations } });
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ r: string }>(`select revision as r from ${table} where id = $1`, [id])).rows[0]!.r);
const code = (out: { data: unknown }) => (out.data as { error?: { code: string } }).error?.code;

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('agentes · dominio: solo el owner; responsable coherente; sin responsable no se activa; no se sucede a sí mismo', () => {
  const owner = { role: 'owner' };
  const ins = (fields: Record<string, unknown>, id = 'a1') => [{ op: 'insert', table: AGENTS_TABLE, id, fields: { display_name: 'Agente Ficticio', ...fields } }];
  assert.equal(validateOperations(ins({}), owner), null);
  assert.equal(validateOperations(ins({}), { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations(ins({ active: true }), owner)?.details.field, 'active');
  assert.equal(validateOperations(ins({ active: true, responsible_person_id: uuid() }), owner), null);
  assert.equal(validateOperations(ins({ active: true, responsible_kind: 'service', responsible_service: 'Servicio de guardia' }), owner), null);
  assert.equal(validateOperations(ins({ responsible_kind: 'service', responsible_person_id: uuid() }), owner)?.details.field, 'responsible_person_id');
  assert.equal(validateOperations(ins({ responsible_service: 'Servicio' }), owner)?.details.field, 'responsible_service');
  assert.equal(validateOperations(ins({ successor_id: 'a1' }), owner)?.details.field, 'successor_id');
  assert.equal(hasResponsible({ responsible_kind: 'service', responsible_service: '  ' }), false);
  const chain = successorChain([{ id: 'a', display_name: 'A', successor_id: 'b' }, { id: 'b', display_name: 'B', successor_id: 'c' }, { id: 'c', display_name: 'C', successor_id: 'a' }], 'a');
  assert.deepEqual(chain.map((r) => r.id), ['b', 'c'], 'la cadena se corta al volver al primero');
});

test('agentes · base: alta por el owner con persona responsable; cuenta de agente; persona en uso; claves revocadas', async () => {
  const person = uuid();
  const created = await commit([{ op: 'insert', table: TABLES.people, id: person, fields: { display_name: 'Responsable Ficticia', relation: 'equipo' } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));

  // Cuenta del núcleo: una de agente y una humana.
  const agentUser = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name, kind) values ($1, 'Agente Ficticio', 'agent') on conflict (user_id) do update set kind = 'agent'`, [agentUser]);
  const human = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Humano Ficticio') on conflict (user_id) do nothing`, [human]);

  const agent = uuid();
  const out = await commit([{ op: 'insert', table: AGENTS_TABLE, id: agent, fields: { display_name: 'Agente Ficticio', user_id: agentUser, mission: 'Revisar textos', responsible_person_id: person, active: true } }]);
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const [row] = (await app.t.db.query<{ code: string }>(`select code from central.agents where id = $1`, [agent])).rows;
  assert.match(row!.code, /^AGT_\d{4}_\d{3}$/);

  // El editor no la cambia (dominio y núcleo).
  const byEditor = await commit([{ op: 'update', table: AGENTS_TABLE, id: agent, expectedRevision: await revision(AGENTS_TABLE, agent), fields: { mission: 'Otra' } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.data));

  // La cuenta enlazada tiene que ser de agente (lo comprueba la base).
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.owner, p_request_id: `ag-human-${uuid()}`, p_digest: 'ag', p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: AGENTS_TABLE, id: uuid(), fields: { display_name: 'Falso Agente', user_id: human } }] }),
    (error: any) => error.code === 'INVALID_FIELDS',
  );
  // Sin responsable no se activa (check de la base).
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.owner, p_request_id: `ag-noresp-${uuid()}`, p_digest: 'ag', p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: AGENTS_TABLE, id: uuid(), fields: { display_name: 'Sin Responsable', active: true } }] }),
  );
  // Responsable de servicio, sin persona detrás.
  const service = await commit([{ op: 'insert', table: AGENTS_TABLE, id: uuid(), fields: { display_name: 'Agente de Guardia', responsible_kind: 'service', responsible_service: 'Servicio de guardia', active: true } }]);
  assert.equal(service.status, 200, JSON.stringify(service.data));

  // La persona responsable no se borra mientras responda por un agente vivo.
  const del = await commit([{ op: 'delete', table: TABLES.people, id: person, expectedRevision: await revision(TABLES.people, person) }]);
  assert.equal(del.status, 422, JSON.stringify(del.data));
  assert.equal(code(del), 'PERSON_IN_USE');

  // Revocar las claves del agente no toca su ficha.
  await app.t.db.query(`insert into core.agent_keys (user_id, name, digest, hint, created_by, revoked_at) values ($1, 'clave', $2, 'abcd', $3, now())`, [agentUser, 'a'.repeat(64), app.users.owner]);
  const [still] = (await app.t.db.query<{ n: string }>(`select count(*) as n from central.agents where id = $1 and deleted_at is null`, [agent])).rows;
  assert.equal(Number(still!.n), 1);
});
