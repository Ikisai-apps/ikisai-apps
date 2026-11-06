/**
 * Central · propuestas del agente sobre su ficha (X1, vg-51; núcleo 0120, migración 1528). Al aprobar, el núcleo aplica el lote
 * en Central con quien decide como actor y el requestId `proposal:<id>`; aquí se simula con `core_commit`. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { AGENTS_TABLE, TABLES, agentProposalChanges, pendingAgentProposals } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `ap-${++seq}`, operations } });
const revision = async (id: string) => Number((await app.t.db.query<{ r: string }>(`select revision as r from central.agents where id = $1`, [id])).rows[0]!.r);
const apply = (actor: string, operations: unknown[], requestId = `proposal:${uuid()}`) =>
  app.t.rpc('core_commit', { p_app: 'central', p_actor: actor, p_request_id: requestId, p_digest: 'ap', p_expected_cursor: null, p_operations: operations });
const forbidden = (error: any) => error.code === 'FORBIDDEN';

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('propuestas · dominio: las de Central pendientes y qué cambia', () => {
  const p = { id: 'p', userId: 'u', effectiveApp: 'central', status: 'pending', createdAt: '2026-11-06T10:00:00Z', uncertain: ['central.agents.notes'],
    operations: [{ op: 'update', table: AGENTS_TABLE, id: 'a', fields: { mission: 'Nueva', notes: 'Algo', work_areas: 'Igual' } }] };
  assert.deepEqual(pendingAgentProposals([p, { ...p, id: 'b', effectiveApp: 'booking' }, { ...p, id: 'c', status: 'rejected' }]).map((x) => x.id), ['p']);
  assert.deepEqual(agentProposalChanges(p, { mission: 'Vieja', work_areas: 'Igual' }).map((c) => [c.label, c.before, c.after, c.uncertain]),
    [['Misión', 'Vieja', 'Nueva', false], ['Notas', '', 'Algo', true]]);
});

test('propuestas · base: decide el owner o la responsable; solo misión, dónde trabaja y notas; fuera de propuesta, solo el owner', async () => {
  const person = uuid();
  assert.equal((await commit([{ op: 'insert', table: TABLES.people, id: person, fields: { display_name: 'Responsable Ficticia', relation: 'equipo' } }])).status, 200);
  const agentUser = await app.t.createUser();
  await app.t.db.query(`insert into core.profiles (user_id, display_name, kind) values ($1, 'Agente Ficticio', 'agent') on conflict (user_id) do update set kind = 'agent'`, [agentUser]);
  const agent = uuid();
  const created = await commit([{ op: 'insert', table: AGENTS_TABLE, id: agent, fields: { display_name: 'Agente Ficticio', user_id: agentUser, mission: 'Revisar textos', responsible_person_id: person, active: true } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const update = async (fields: Record<string, unknown>) => [{ op: 'update', table: AGENTS_TABLE, id: agent, expectedRevision: await revision(agent), fields }];

  // Fuera de una propuesta, el editor no toca fichas de agente (tampoco saltándose la Edge).
  await assert.rejects(apply(app.users.editor, await update({ mission: 'Directo' }), `ap-direct-${uuid()}`), forbidden);
  // En una propuesta, el editor que no responde por el agente, tampoco.
  await assert.rejects(apply(app.users.editor, await update({ mission: 'Sin ser responsable' })), forbidden);
  // La responsable (su ficha enlazada a la cuenta del editor) sí, y solo los campos de la propuesta.
  await app.t.db.query(`update central.people set user_id = $1 where id = $2`, [app.users.editor, person]);
  await apply(app.users.editor, await update({ mission: 'Revisar textos y traducciones', notes: 'Propuesto por el agente' }));
  const [row] = (await app.t.db.query<{ mission: string }>(`select mission from central.agents where id = $1`, [agent])).rows;
  assert.equal(row!.mission, 'Revisar textos y traducciones');
  await assert.rejects(apply(app.users.editor, await update({ active: false })), forbidden);
  await assert.rejects(apply(app.users.owner, [{ op: 'update', table: TABLES.people, id: person, expectedRevision: Number((await app.t.db.query<{ r: string }>(`select revision as r from central.people where id = $1`, [person])).rows[0]!.r), fields: { display_name: 'Otra' } }]), forbidden);
  // El owner decide cualquiera.
  await apply(app.users.owner, await update({ work_areas: 'Central y Tasks' }));
  // El owner sigue cambiando la ficha como siempre.
  assert.equal((await commit(await update({ active: false }))).status, 200);
});
