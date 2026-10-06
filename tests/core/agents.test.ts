/**
 * Agentes en el núcleo (contrato §3, docs/tasks/AGENTES.md): claves `ika_`, riesgo, propuestas con aprobación humana,
 * consumo único, caducidad, revocación y registro de accesos. Se ejecuta sobre la app invoices sin hooks de dominio.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const TABLE = 'invoices.suppliers';
const ORIGIN = 'https://invoices.ikisai.com';
const uuid = () => crypto.randomUUID();
const insert = (id: string, name: string) => ({ op: 'insert', table: TABLE, id, fields: { name, tax_id: null } });

let app: TestApp;
let agentKey: string;
let agentKeyId: string;
let agentUserId: string;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: ORIGIN,
    createHandler: (config) => createApp({ ...config, app: 'invoices', slug: 'invoices-api', origins: [ORIGIN] }),
  });
});
test.after(async () => { await app.close(); });

test('agentes · alta por el owner: clave una sola vez, listado sin clave, editor y agente no administran', async () => {
  const forbidden = await app.call('/api/v1/agents', { token: app.tokens.editor, body: { name: 'Bot', role: 'editor' } });
  assert.equal(forbidden.status, 403);
  const issued = await app.call('/api/v1/agents', { body: { name: 'Bot de pruebas', role: 'editor' } });
  assert.equal(issued.status, 200, JSON.stringify(issued.data));
  assert.match(issued.data.token, /^ika_[A-Za-z0-9_-]{43}$/);
  assert.equal(issued.data.shownOnce, true); assert.equal(issued.data.role, 'editor'); assert.equal(issued.data.hint, issued.data.token.slice(-4));
  agentKey = issued.data.token; agentKeyId = issued.data.keyId; agentUserId = issued.data.userId;
  const listed = await app.call('/api/v1/agents');
  assert.equal(listed.status, 200); assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].keyId, agentKeyId); assert.equal(listed.data.items[0].name, 'Bot de pruebas'); assert.equal('token' in listed.data.items[0], false);
  const byAgent = await app.call('/api/v1/agents', { token: agentKey, body: { name: 'Otro', role: 'editor' } });
  assert.equal(byAgent.status, 403);
  const owner = await app.call('/api/v1/agents', { body: { name: 'Jefe', role: 'owner' } });
  assert.equal(owner.status, 422); assert.equal(owner.data.error.code, 'INVALID_ROLE');
  const promote = await app.call('/api/v1/members', { body: { userId: agentUserId, role: 'owner' } });
  assert.equal(promote.status, 422); assert.equal(promote.data.error.code, 'INVALID_ROLE');
});

test('agentes · identidad por clave: bootstrap y me como agent; sin sesión que cerrar ni contraseña; clave falsa 401', async () => {
  const boot = await app.call('/api/v1/bootstrap', { token: agentKey });
  assert.equal(boot.status, 200); assert.equal(boot.data.profile.kind, 'agent'); assert.equal(boot.data.membership.role, 'editor');
  assert.equal(boot.data.agentPolicy.bulkThreshold, 10);
  const me = await app.call('/api/v1/me', { token: agentKey });
  assert.equal(me.data.kind, 'agent'); assert.equal(me.data.name, 'Bot de pruebas'); assert.equal(me.data.userId, agentUserId);
  assert.equal((await app.call('/api/v1/auth/logout', { token: agentKey, body: {} })).status, 403);
  assert.equal((await app.call('/api/v1/auth/password', { token: agentKey, body: { currentPassword: 'x', newPassword: 'y'.repeat(12) } })).status, 403);
  const fake = await app.call('/api/v1/bootstrap', { token: 'ika_' + 'A'.repeat(43) });
  assert.equal(fake.status, 401); assert.equal(fake.data.error.code, 'UNAUTHORIZED');
  const members = await app.call('/api/v1/members', { token: agentKey });
  assert.equal(members.status, 200); assert.ok(members.data.some((m: any) => m.userId === agentUserId && m.kind === 'agent'));
});

const rowA = uuid();
const rowB = uuid();

test('agentes · lote normal pasa; borrado o lote masivo sin aprobación → 428 CONFIRMATION_REQUIRED con el riesgo', async () => {
  const ok = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-ins', operations: [insert(rowA, 'Makro'), insert(rowB, 'Metro')] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.changes.length, 2);
  const del = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del', operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 1 }] } });
  assert.equal(del.status, 428); assert.equal(del.data.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(del.data.error.details.risk.destructive, true); assert.deepEqual(del.data.error.details.risk.reasons, ['delete:1']);
  assert.equal((await app.t.db.query<{ deleted_at: string | null }>(`select deleted_at from invoices.suppliers where id = $1`, [rowA])).rows[0]!.deleted_at, null);
  const bulk = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-bulk', operations: Array.from({ length: 10 }, (_, i) => insert(uuid(), `Prov ${i}`)) } });
  assert.equal(bulk.status, 428); assert.equal(bulk.data.error.details.risk.bulk, true); assert.equal(bulk.data.error.details.risk.affected, 10);
  // Una persona no pasa por propuestas: el mismo borrado se aplica directamente.
  const human = await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'h-del', operations: [{ op: 'delete', table: TABLE, id: rowB, expectedRevision: 1 }] } });
  assert.equal(human.status, 200);
});

let proposalId: string;

test('agentes · propuesta: no necesaria 422; destructiva queda pendiente 24 h con resumen antes/después; idempotente por requestId', async () => {
  const notNeeded = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'p-ins', operations: [insert(uuid(), 'Uno')] } });
  assert.equal(notNeeded.status, 422); assert.equal(notNeeded.data.error.code, 'CONFIRMATION_NOT_NEEDED');
  const human = await app.call('/api/v1/proposals', { token: app.tokens.editor, body: { requestId: 'p-h', operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 1 }] } });
  assert.equal(human.status, 403);
  const ops = [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 1 }];
  const prepared = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del', operations: ops } });
  assert.equal(prepared.status, 200, JSON.stringify(prepared.data));
  proposalId = prepared.data.id;
  assert.equal(prepared.data.status, 'pending'); assert.equal(prepared.data.requestId, 'a-del'); assert.equal(prepared.data.keyId, agentKeyId);
  assert.equal(prepared.data.summary.length, 1); assert.equal(prepared.data.summary[0].op, 'delete'); assert.equal(prepared.data.summary[0].before.deleted_at, null); assert.ok(prepared.data.summary[0].after.deleted_at);
  const hours = (new Date(prepared.data.expiresAt).getTime() - Date.now()) / 3_600_000;
  assert.ok(hours > 23.9 && hours <= 24.01, `caducidad ${hours} h`);
  assert.equal((await app.t.db.query<{ deleted_at: string | null }>(`select deleted_at from invoices.suppliers where id = $1`, [rowA])).rows[0]!.deleted_at, null, 'el ensayo no escribe');
  const again = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del', operations: ops } });
  assert.equal(again.status, 200); assert.equal(again.data.id, proposalId);
  const reuse = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del', operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 2 }] } });
  assert.equal(reuse.status, 409); assert.equal(reuse.data.error.code, 'IDEMPOTENCY_REUSE');
  // Listados: el owner ve todas, el agente las suyas, un lector humano no.
  assert.equal((await app.call('/api/v1/proposals')).data.items.length, 1);
  assert.equal((await app.call('/api/v1/proposals', { token: agentKey })).data.items[0].id, proposalId);
  assert.equal((await app.call(`/api/v1/proposals/${proposalId}`, { token: agentKey })).data.status, 'pending');
  assert.equal((await app.call('/api/v1/proposals', { token: app.tokens.reader })).status, 403);
  assert.equal((await app.call('/api/v1/proposals?status=consumed')).data.items.length, 0);
});

test('agentes · aprobación solo por owner humano; el lote aprobado se aplica tal cual una sola vez; reintento idempotente', async () => {
  assert.equal((await app.call(`/api/v1/proposals/${proposalId}/approve`, { token: app.tokens.editor, body: {} })).status, 403);
  assert.equal((await app.call(`/api/v1/proposals/${proposalId}/approve`, { token: agentKey, body: {} })).status, 403);
  // Con otro lote bajo el mismo id de confirmación no vale: el digest no coincide.
  const approved = await app.call(`/api/v1/proposals/${proposalId}/approve`, { body: {} });
  assert.equal(approved.status, 200, JSON.stringify(approved.data)); assert.equal(approved.data.status, 'approved'); assert.equal(approved.data.decidedBy, app.users.owner);
  assert.equal((await app.t.db.query<{ deleted_at: string | null }>(`select deleted_at from invoices.suppliers where id = $1`, [rowA])).rows[0]!.deleted_at, null, 'aprobar no ejecuta');
  const wrongDigest = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del', confirmationId: proposalId, operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 2 }] } });
  assert.equal(wrongDigest.status, 428); assert.equal(wrongDigest.data.error.details.mismatch.digest, true);
  const applied = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del', confirmationId: proposalId, operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 1 }] } });
  assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.proposalId, proposalId);
  assert.ok((await app.t.db.query<{ deleted_at: string | null }>(`select deleted_at from invoices.suppliers where id = $1`, [rowA])).rows[0]!.deleted_at);
  const consumed = await app.call(`/api/v1/proposals/${proposalId}`);
  assert.equal(consumed.data.status, 'consumed'); assert.equal(consumed.data.consumedCursor, applied.data.cursor);
  const replay = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del', confirmationId: proposalId, operations: [{ op: 'delete', table: TABLE, id: rowA, expectedRevision: 1 }] } });
  assert.equal(replay.status, 200); assert.equal(replay.data.replayed, true);
  const reuse = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del-2', confirmationId: proposalId, operations: [{ op: 'delete', table: TABLE, id: rowB, expectedRevision: 1 }] } });
  assert.equal(reuse.status, 428); assert.equal(reuse.data.error.details.proposalStatus, 'consumed');
});

test('agentes · aprobar un lote que ya no encaja lo rechaza (409 PROPOSAL_UNAVAILABLE); rechazar; caducidad', async () => {
  const rowC = uuid();
  await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-ins-c', operations: [insert(rowC, 'Caduca SL')] } });
  const stale = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del-c', operations: [{ op: 'delete', table: TABLE, id: rowC, expectedRevision: 1 }] } });
  assert.equal(stale.status, 200);
  // Alguien cambia la fila entre tanto.
  await app.call('/api/v1/commands', { token: app.tokens.editor, body: { requestId: 'h-upd-c', operations: [{ op: 'update', table: TABLE, id: rowC, expectedRevision: 1, fields: { name: 'Caduca y Cía' } }] } });
  const approve = await app.call(`/api/v1/proposals/${stale.data.id}/approve`, { body: {} });
  assert.equal(approve.status, 409); assert.equal(approve.data.error.code, 'PROPOSAL_UNAVAILABLE'); assert.equal(approve.data.error.details.proposal.status, 'rejected');
  assert.equal((await app.call(`/api/v1/proposals/${stale.data.id}`)).data.status, 'rejected');
  const again = await app.call(`/api/v1/proposals/${stale.data.id}/approve`, { body: {} });
  assert.equal(again.status, 409);
  // Rechazo explícito.
  const toReject = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del-c2', operations: [{ op: 'delete', table: TABLE, id: rowC, expectedRevision: 2 }] } });
  const rejected = await app.call(`/api/v1/proposals/${toReject.data.id}/reject`, { body: {} });
  assert.equal(rejected.status, 200); assert.equal(rejected.data.status, 'rejected');
  // Caducada: una propuesta aprobada cuya fecha pasó no sirve para confirmar.
  const expiring = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del-c3', operations: [{ op: 'delete', table: TABLE, id: rowC, expectedRevision: 2 }] } });
  await app.call(`/api/v1/proposals/${expiring.data.id}/approve`, { body: {} });
  await app.t.db.query(`update core.proposals set expires_at = now() - interval '1 minute' where id = $1`, [expiring.data.id]);
  assert.equal((await app.call(`/api/v1/proposals/${expiring.data.id}`)).data.status, 'expired');
  const late = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-del-c3', confirmationId: expiring.data.id, operations: [{ op: 'delete', table: TABLE, id: rowC, expectedRevision: 2 }] } });
  assert.equal(late.status, 428); assert.equal(late.data.error.details.proposalStatus, 'expired');
});

test('agentes · deshacer también pasa por el riesgo; acciones no seguras → 428', async () => {
  const rowD = uuid();
  const ins = await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-ins-d', operations: [insert(rowD, 'Deshacer SL')] } });
  const plan = await app.call(`/api/v1/history/${ins.data.cursor}/undo-plan`, { token: agentKey, body: {} });
  assert.equal(plan.status, 200);
  const undo = await app.call(`/api/v1/history/${ins.data.cursor}/undo`, { token: agentKey, body: { requestId: 'a-undo-d', planHash: plan.data.planHash } });
  assert.equal(undo.status, 428); assert.equal(undo.data.error.code, 'CONFIRMATION_REQUIRED');
});

test('agentes · registro de accesos para el owner; revocación: 401 inmediato y propuestas abiertas revocadas', async () => {
  assert.equal((await app.call('/api/v1/access-log', { token: app.tokens.editor })).status, 403);
  const log = await app.call('/api/v1/access-log?limit=3');
  assert.equal(log.status, 200); assert.equal(log.data.items.length, 3); assert.equal(log.data.hasMore, true); assert.ok(log.data.nextBefore);
  const events = new Set<string>(log.data.items.map((e: any) => String(e.event)));
  for (const e of events) assert.ok(['key_issued', 'member_invited', 'member_changed', 'proposal_prepared', 'proposal_approved', 'proposal_rejected', 'proposal_consumed'].includes(e), e);
  const page2 = await app.call(`/api/v1/access-log?limit=3&before=${log.data.nextBefore}`);
  assert.ok(page2.data.items.every((e: any) => e.id < log.data.nextBefore));
  // Propuesta pendiente que la revocación debe cerrar.
  const rowE = uuid();
  await app.call('/api/v1/commands', { token: agentKey, body: { requestId: 'a-ins-e', operations: [insert(rowE, 'Revocar SL')] } });
  const open = await app.call('/api/v1/proposals', { token: agentKey, body: { requestId: 'a-del-e', operations: [{ op: 'delete', table: TABLE, id: rowE, expectedRevision: 1 }] } });
  assert.equal(open.data.status, 'pending');
  assert.equal((await app.call(`/api/v1/agents/${agentKeyId}`, { token: app.tokens.editor, method: 'DELETE' })).status, 403);
  const revoked = await app.call(`/api/v1/agents/${agentKeyId}`, { method: 'DELETE' });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data)); assert.equal(revoked.data.revoked, true);
  // La pendiente de este escenario y la aprobada-caducada del anterior (sigue `approved` en la tabla; `expired` se calcula).
  assert.equal(revoked.data.proposalsRevoked, 2);
  const after = await app.call('/api/v1/bootstrap', { token: agentKey });
  assert.equal(after.status, 401); assert.equal(after.data.error.details.reason, 'revoked');
  assert.equal((await app.call(`/api/v1/proposals/${open.data.id}`)).data.status, 'revoked');
  assert.equal((await app.call('/api/v1/agents')).data.items[0].revokedAt !== null, true);
  // Clave caducada.
  const second = await app.call('/api/v1/agents', { body: { name: 'Temporal', role: 'reader', expiresAt: new Date(Date.now() + 60_000).toISOString() } });
  assert.equal(second.status, 200);
  await app.t.db.query(`update core.agent_keys set expires_at = now() - interval '1 minute' where id = $1`, [second.data.keyId]);
  const expired = await app.call('/api/v1/bootstrap', { token: second.data.token });
  assert.equal(expired.status, 401); assert.equal(expired.data.error.details.reason, 'expired');
});
