/**
 * 0120: propuestas hacia otra app (`targetApp`) que se aplican al aprobar, decisor nombrado (`deciderUserId`), campos tocados,
 * marcas «por confirmar» y decisión por grupo. Un agente de booking propone en invoices; decide una editora de invoices nombrada
 * decisora, y el lote se aplica en invoices con ella como actora.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://booking.ikisai.com';
const TABLE = 'invoices.suppliers';
const uuid = () => crypto.randomUUID();

test('0120 · propuesta hacia otra app: solo el decisor o un owner de la app destino decide; aprobar aplica el lote allí', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: ORIGIN, createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [ORIGIN] }) });
  try {
    const db = app.t.db;
    // Personas de invoices: una owner y una editora (la decisora). Ninguna pertenece a booking.
    const invOwner = await app.t.createUser();
    const decider = await app.t.createUser();
    const stranger = await app.t.createUser();
    await db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'owner'), ('invoices', $2, 'editor'), ('invoices', $3, 'editor')`, [invOwner, decider, stranger]);
    const tDecider = app.supabase.tokenFor(decider);

    const issued = await app.call('/api/v1/agents', { body: { name: 'Bot', role: 'editor' } });
    assert.equal(issued.status, 200, JSON.stringify(issued.data));
    const agentKey = issued.data.token as string;

    const rowId = uuid();
    const ops = [{ op: 'insert', table: TABLE, id: rowId, fields: { name: 'Propuesto desde booking', tax_id: null } }];
    // Decisor desconocido en la app destino → 422; app destino desconocida → 422.
    const badDecider = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'x-1', operations: ops, targetApp: 'invoices', deciderUserId: app.users.editor } });
    assert.equal(badDecider.status, 422, JSON.stringify(badDecider.data));
    const badApp = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'x-2', operations: ops, targetApp: 'nadie' } });
    assert.equal(badApp.status, 422, JSON.stringify(badApp.data));

    const prepared = await app.call('/api/v1/proposals', { token: agentKey, body: {
      requestId: 'p-1', operations: ops, targetApp: 'invoices', deciderUserId: decider, groupKey: 'carga-7', fields: ['supplier.name'], uncertain: ['supplier.tax_id'] } });
    assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
    const id = prepared.data.id as string;
    assert.equal(prepared.data.targetApp, 'invoices'); assert.equal(prepared.data.effectiveApp, 'invoices'); assert.equal(prepared.data.deciderUserId, decider);
    assert.deepEqual(prepared.data.fields, ['supplier.name']); assert.deepEqual(prepared.data.uncertain, ['supplier.tax_id']); assert.equal(prepared.data.groupKey, 'carga-7');
    assert.equal(prepared.data.status, 'pending');

    // Ni el owner de booking (no es owner de invoices) ni otra editora de invoices pueden decidir; el agente tampoco.
    assert.equal((await app.call(`/api/v1/proposals/${id}/approve`, { body: {} })).status, 403, 'owner de booking');
    assert.equal((await app.call(`/api/v1/proposals/${id}/approve`, { token: app.supabase.tokenFor(stranger), body: {} })).status, 403, 'otra editora de invoices sin pertenencia a booking');
    assert.equal((await app.call(`/api/v1/proposals/${id}/approve`, { token: agentKey, body: {} })).status, 403, 'el agente');
    // 0122: un lector de la app destino no puede ser decisor; el agente autor no ve el resumen de una propuesta hacia otra app.
    const reader = await app.t.createUser();
    await db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'reader')`, [reader]);
    const badReader = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'x-3', operations: ops, targetApp: 'invoices', deciderUserId: reader } });
    assert.equal(badReader.status, 422, JSON.stringify(badReader.data));
    assert.deepEqual(prepared.data.summary, [], 'el autor no ve el resumen'); assert.equal(prepared.data.summaryHidden, true);
    const asDecider = (await db.query<{ r: any }>(`select core.proposal_get('invoices', $1, $2) as r`, [decider, id])).rows[0]!.r;
    assert.equal(asDecider.summary.length, 1, 'la decisora sí ve el resumen'); assert.equal(asDecider.summaryHidden, undefined);
    // 0122: dentro del lote aplicado, la app destino conoce al agente autor y la propuesta; fuera, null.
    await db.exec(`create table public.test_prop_authors (author uuid, proposal uuid);
      create function invoices.test_prop_author() returns trigger language plpgsql as $$ begin insert into public.test_prop_authors values (core.proposal_author(), core.proposal_id()); return new; end $$;
      create trigger test_prop_author after insert on invoices.suppliers for each row execute function invoices.test_prop_author();`);
    assert.equal((await db.query<{ a: string | null }>(`select core.proposal_author() as a`)).rows[0]!.a, null);
    // La decisora no pertenece a booking: la Edge de booking la rechaza por pertenencia; decide por el núcleo (como haría la Edge de invoices).
    const decided = (await db.query<{ r: any }>(`select core.proposal_decide('invoices', $1, $2, 'approve') as r`, [decider, id])).rows[0]!.r;
    assert.equal(decided.status, 'consumed', JSON.stringify(decided)); assert.equal(decided.applied, true); assert.equal(decided.decidedBy, decider);
    const row = (await db.query<{ name: string }>(`select name from invoices.suppliers where id = $1`, [rowId])).rows[0];
    assert.equal(row?.name, 'Propuesto desde booking', 'el lote se aplicó en invoices');
    const seen = (await db.query<{ author: string | null; proposal: string | null }>(`select author, proposal from public.test_prop_authors`)).rows;
    assert.deepEqual(seen, [{ author: issued.data.userId, proposal: id }], 'el hook de la app destino ve al agente autor y la propuesta');
    const change = (await db.query<{ actor_id: string; request_id: string }>(`select actor_id, request_id from core.changes where app = 'invoices' and row_id = $1`, [rowId])).rows[0]!;
    assert.equal(change.actor_id, decider, 'la actora del lote es la decisora'); assert.equal(change.request_id, 'proposal:' + id);
    const events = (await db.query<{ event: string; app: string }>(`select event, app from core.access_events where meta->>'proposalId' = $1 order by id`, [id])).rows;
    assert.deepEqual(events.map((e) => e.event), ['proposal_prepared', 'proposal_prepared', 'proposal_approved', 'proposal_consumed']);
    assert.deepEqual(events.map((e) => e.app), ['booking', 'invoices', 'invoices', 'invoices']);

    // Listados: el owner de invoices y la decisora ven la propuesta en invoices; el owner de booking la ve en booking (es su app de origen).
    const forOwner = (await db.query<{ r: any[] }>(`select core.proposal_list('invoices', $1, null, 50) as r`, [invOwner])).rows[0]!.r;
    assert.equal(forOwner.length, 1); assert.equal(forOwner[0].id, id);
    const forDecider = (await db.query<{ r: any[] }>(`select core.proposal_list('invoices', $1, null, 50) as r`, [decider])).rows[0]!.r;
    assert.equal(forDecider.length, 1);
    await assert.rejects(db.query(`select core.proposal_list('invoices', $1, null, 50)`, [stranger]), /FORBIDDEN/);
    const fromOrigin = (await app.call('/api/v1/proposals')).data.items;
    assert.equal(fromOrigin.length, 1, 'el owner de booking la ve en su app');
    assert.deepEqual(fromOrigin[0].summary, []); assert.equal(fromOrigin[0].summaryHidden, true, '0123: pero sin el resumen, que son datos de invoices');
    const forInvOwner = (await db.query<{ r: any[] }>(`select core.proposal_list('invoices', $1, null, 50) as r`, [invOwner])).rows[0]!.r;
    assert.equal(forInvOwner[0].summaryHidden, undefined, 'el owner de invoices sí lo ve');
    assert.equal(tDecider.length > 0, true);
  } finally {
    await app.close();
  }
});

test('0120 · decisión por grupo: un owner de la app aprueba de golpe las pendientes del grupo; las demás no se tocan', async () => {
  const app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: 'https://invoices.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'invoices', slug: 'invoices-api', origins: ['https://invoices.ikisai.com'] }) });
  try {
    const issued = await app.call('/api/v1/agents', { body: { name: 'Bot', role: 'editor' } });
    const agentKey = issued.data.token as string;
    const a = uuid(); const b = uuid(); const c = uuid();
    const seed = await app.call('/api/v1/commands', { body: { requestId: 's-1', operations: [
      { op: 'insert', table: TABLE, id: a, fields: { name: 'A', tax_id: null } }, { op: 'insert', table: TABLE, id: b, fields: { name: 'B', tax_id: null } }, { op: 'insert', table: TABLE, id: c, fields: { name: 'C', tax_id: null } }] } });
    assert.equal(seed.status, 200, JSON.stringify(seed.data));
    // Tres propuestas destructivas (borrar): dos del grupo g1 y una fuera.
    for (const [rid, id, group] of [['g-a', a, 'g1'], ['g-b', b, 'g1'], ['g-c', c, 'otro']] as const) {
      const r = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: rid, operations: [{ op: 'delete', table: TABLE, id, expectedRevision: 1 }], groupKey: group } });
      assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.groupKey, group);
    }
    assert.equal((await app.call('/api/v1/proposals/group/g1/approve', { token: app.tokens.editor, body: {} })).status, 403, 'una editora no decide');
    // 0122: en la propia app no hay decisor nombrado: decide solo el owner.
    const sameApp = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'g-d', operations: [{ op: 'delete', table: TABLE, id: a, expectedRevision: 1 }], deciderUserId: app.users.editor } });
    assert.equal(sameApp.status, 422, JSON.stringify(sameApp.data));
    const res = await app.call('/api/v1/proposals/group/g1/approve', { body: {} });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    assert.equal(res.data.decided, 2); assert.equal(res.data.autoRejected, 0); assert.equal(res.data.skipped, 0);
    const pending = (await app.call('/api/v1/proposals?status=pending')).data.items;
    assert.equal(pending.length, 1); assert.equal(pending[0].groupKey, 'otro');
    const approved = (await app.call('/api/v1/proposals?status=approved')).data.items;
    assert.equal(approved.length, 2);
  } finally {
    await app.close();
  }
});
