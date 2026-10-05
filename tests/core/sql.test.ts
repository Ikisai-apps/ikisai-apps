import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, RpcError } from '../../packages/test-kit/src/pglite.ts';

const APP = 'invoices';
const TABLE = 'invoices.suppliers';

async function setup() {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  const editor = await t.createUser();
  const reader = await t.createUser();
  await t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Owner')`, [owner]);
  await t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'editor'), ($1, $4, 'reader')`, [APP, owner, editor, reader]);
  return { t, owner, editor, reader };
}

async function expectFail(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RpcError, `esperaba RpcError, llegó ${String(error)}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`esperaba ${code}`);
}

test('migraciones aplican y la app invoices queda registrada', async () => {
  const { t } = await setup();
  const boot = (await t.rpc('core_bootstrap', { p_app: APP, p_user: (await t.db.query<{ user_id: string }>('select user_id from core.memberships limit 1')).rows[0]!.user_id })) as any;
  assert.equal(boot.cursor, 0);
  assert.deepEqual(boot.tables.map((x: any) => x.table), [TABLE]);
  await t.close();
});

test('commit: insert idempotente, update con revisión, 409 en revisión antigua', async () => {
  const { t, owner } = await setup();
  const id = crypto.randomUUID();
  const ops = [{ op: 'insert', table: TABLE, id, fields: { name: 'Makro', tax_id: 'A12345678' } }];
  const first = (await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r1', p_digest: 'd1', p_expected_cursor: 0, p_operations: ops })) as any;
  assert.equal(first.cursor, 1);
  assert.equal(first.results[0].revision, 1);
  assert.equal(first.changes[0].after.name, 'Makro');
  assert.equal(first.changes[0].after.updated_by, owner);

  const replay = (await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r1', p_digest: 'd1', p_expected_cursor: null, p_operations: ops })) as any;
  assert.equal(replay.cursor, 1);
  assert.equal(replay.replayed, true);
  assert.equal((await t.db.query<{ n: number }>('select count(*)::int n from invoices.suppliers')).rows[0]!.n, 1);

  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r1', p_digest: 'otro', p_expected_cursor: null, p_operations: ops }), 'IDEMPOTENCY_REUSE');

  const upd = (await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r2', p_digest: 'd2', p_expected_cursor: 1, p_operations: [{ op: 'update', table: TABLE, id, expectedRevision: 1, fields: { notes: 'proveedor habitual' } }] })) as any;
  assert.equal(upd.cursor, 2);
  assert.equal(upd.results[0].revision, 2);
  assert.equal(upd.changes[0].after.notes, 'proveedor habitual');
  assert.equal(upd.changes[0].after.name, 'Makro');

  const conflict = await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r3', p_digest: 'd3', p_expected_cursor: null, p_operations: [{ op: 'update', table: TABLE, id, expectedRevision: 1, fields: { notes: 'pisar' } }] }), 'VERSION_CONFLICT');
  assert.equal((conflict!.details as any).currentRevision, 2);
  assert.equal((conflict!.details as any).current.notes, 'proveedor habitual');
  assert.equal((await t.db.query<{ cursor: number }>('select cursor::int from core.app_state where app=$1', [APP])).rows[0]!.cursor, 2);

  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r4', p_digest: 'd4', p_expected_cursor: 0, p_operations: [] }), 'CURSOR_CONFLICT');
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r5', p_digest: 'd5', p_expected_cursor: null, p_operations: [{ op: 'update', table: TABLE, id, expectedRevision: 2, fields: { revision: 99 } }] }), 'INVALID_FIELDS');
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r6', p_digest: 'd6', p_expected_cursor: null, p_operations: [{ op: 'update', table: 'invoices.nope', id, expectedRevision: 2, fields: {} }] }), 'INVALID_OPERATION');
  await t.close();
});

test('permisos: reader no escribe, sin membresía 403', async () => {
  const { t, reader } = await setup();
  const stranger = await t.createUser();
  const ops = [{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'X' } }];
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: reader, p_request_id: 'a', p_digest: 'a', p_expected_cursor: null, p_operations: ops }), 'FORBIDDEN');
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: stranger, p_request_id: 'a', p_digest: 'a', p_expected_cursor: null, p_operations: ops }), 'NO_MEMBERSHIP');
  await expectFail(t.rpc('core_bootstrap', { p_app: APP, p_user: stranger }), 'NO_MEMBERSHIP');
  await t.close();
});

test('borrado lógico, restore, snapshot y changes', async () => {
  const { t, owner, editor } = await setup();
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'i', p_digest: 'i', p_expected_cursor: null, p_operations: [
    { op: 'insert', table: TABLE, id: a, fields: { name: 'A' } }, { op: 'insert', table: TABLE, id: b, fields: { name: 'B' } }] });
  const del = (await t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'd', p_digest: 'd', p_expected_cursor: null, p_operations: [{ op: 'delete', table: TABLE, id: a, expectedRevision: 1 }] })) as any;
  assert.ok(del.changes[0].after.deleted_at);
  let snap = (await t.rpc('core_snapshot_table', { p_app: APP, p_role: 'reader', p_table: TABLE, p_include_deleted: false, p_limit: 100, p_offset: 0 })) as any;
  assert.deepEqual(snap.rows.map((r: any) => r.name), ['B']);
  snap = (await t.rpc('core_snapshot_table', { p_app: APP, p_role: 'reader', p_table: TABLE, p_include_deleted: true, p_limit: 100, p_offset: 0 })) as any;
  assert.equal(snap.rows.length, 2);
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'd2', p_digest: 'd2', p_expected_cursor: null, p_operations: [{ op: 'delete', table: TABLE, id: a, expectedRevision: 2 }] }), 'ROW_DELETED');
  const res = (await t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'r', p_digest: 'r', p_expected_cursor: null, p_operations: [{ op: 'restore', table: TABLE, id: a, expectedRevision: 2 }] })) as any;
  assert.equal(res.changes[0].after.deleted_at, null);
  assert.equal(res.changes[0].after.revision, 3);

  const changes = (await t.rpc('core_changes_since', { p_app: APP, p_role: 'reader', p_after: 1, p_limit: 100 })) as any;
  assert.deepEqual(changes.items.map((c: any) => c.op), ['delete', 'restore']);
  assert.equal(changes.cursor, 3);
  assert.equal(changes.hasMore, false);
  const all = (await t.rpc('core_changes_since', { p_app: APP, p_role: 'reader', p_after: 0, p_limit: 2 })) as any;
  assert.equal(all.items.length, 2);
  assert.equal(all.hasMore, true);
  await t.close();
});

test('historial y deshacer con guardas de revisión', async () => {
  const { t, owner } = await setup();
  const id = crypto.randomUUID();
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: '1', p_digest: '1', p_expected_cursor: null, p_operations: [{ op: 'insert', table: TABLE, id, fields: { name: 'Antes', notes: 'n' } }] });
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: '2', p_digest: '2', p_expected_cursor: null, p_operations: [{ op: 'update', table: TABLE, id, expectedRevision: 1, fields: { name: 'Después' } }] });
  const history = (await t.rpc('core_history', { p_app: APP, p_role: 'owner', p_before: null, p_limit: 10 })) as any;
  assert.deepEqual(history.items.map((h: any) => h.cursor), [2, 1]);
  assert.equal(history.items[0].changes[0].before.name, 'Antes');
  const plan = (await t.rpc('core_undo_plan', { p_app: APP, p_cursor: 2 })) as any;
  assert.deepEqual(plan.operations, [{ op: 'update', table: TABLE, id, expectedRevision: 2, fields: { name: 'Antes' } }]);
  const undone = (await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'u', p_digest: 'u', p_expected_cursor: null, p_operations: plan.operations })) as any;
  assert.equal(undone.changes[0].after.name, 'Antes');
  // el plan antiguo ya no vale: la fila está en revisión 3
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'u2', p_digest: 'u2', p_expected_cursor: null, p_operations: plan.operations }), 'VERSION_CONFLICT');
  const planInsert = (await t.rpc('core_undo_plan', { p_app: APP, p_cursor: 1 })) as any;
  assert.equal(planInsert.operations[0].op, 'delete');
  await t.close();
});

test('códigos humanos y purga de papelera', async () => {
  const { t, owner, editor } = await setup();
  assert.equal(await t.rpc('core_next_code', { p_prefix: 'FVR', p_year: 2026 }), 'FVR_2026_001');
  assert.equal(await t.rpc('core_next_code', { p_prefix: 'FVR', p_year: 2026 }), 'FVR_2026_002');
  assert.equal(await t.rpc('core_next_code', { p_prefix: 'RSV', p_year: 2026 }), 'RSV_2026_001');
  const id = crypto.randomUUID();
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: '1', p_digest: '1', p_expected_cursor: null, p_operations: [{ op: 'insert', table: TABLE, id, fields: { name: 'Temporal' } }] });
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: '2', p_digest: '2', p_expected_cursor: null, p_operations: [{ op: 'delete', table: TABLE, id, expectedRevision: 1 }] });
  await expectFail(t.rpc('core_purge_deleted', { p_app: APP, p_actor: editor, p_request_id: 'p', p_tables: [TABLE] }), 'FORBIDDEN');
  const purged = (await t.rpc('core_purge_deleted', { p_app: APP, p_actor: owner, p_request_id: 'p', p_tables: [TABLE] })) as any;
  assert.equal(purged.purged, 1);
  assert.equal(purged.cursor, 3);
  assert.equal((await t.db.query<{ n: number }>('select count(*)::int n from invoices.suppliers')).rows[0]!.n, 0);
  const hist = (await t.rpc('core_history', { p_app: APP, p_role: 'owner', p_before: null, p_limit: 10 })) as any;
  assert.equal(hist.items[0].changes[0].op, 'purge');
  await expectFail(t.rpc('core_undo_plan', { p_app: APP, p_cursor: 3 }), 'UNDO_UNAVAILABLE');
  await t.close();
});

test('membresías: solo owner administra; sesión revocada deja de estar activa', async () => {
  const { t, owner, editor } = await setup();
  const newcomer = await t.createUser();
  await expectFail(t.rpc('core_set_membership', { p_app: APP, p_actor: editor, p_user: newcomer, p_role: 'reader', p_scopes: null, p_display_name: 'N' }), 'FORBIDDEN');
  const m = (await t.rpc('core_set_membership', { p_app: APP, p_actor: owner, p_user: newcomer, p_role: 'reader', p_scopes: null, p_display_name: 'Nuevo' })) as any;
  assert.equal(m.role, 'reader');
  const list = (await t.rpc('core_list_memberships', { p_app: APP, p_actor: editor })) as any;
  assert.equal(list.length, 4);
  assert.equal(await t.rpc('core_session_active', { p_user: newcomer, p_session: newcomer }), true);
  await t.revokeSessions(newcomer);
  assert.equal(await t.rpc('core_session_active', { p_user: newcomer, p_session: newcomer }), false);
  await t.close();
});
