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
  assert.ok(boot.tables.some((x: any) => x.table === TABLE)); // Invoices registra más tablas desde la migración 0200
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
  const res = (await t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'r', p_digest: 'r', p_expected_cursor: null, p_operations: [{ op: 'restore', table: TABLE, id: a, expectedRevision: 2, fields: { notes: 'restaurada con corrección' } }] })) as any;
  assert.equal(res.changes[0].after.deleted_at, null);
  assert.equal(res.changes[0].after.revision, 3);
  assert.equal(res.changes[0].after.notes, 'restaurada con corrección');
  await expectFail(t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'r2', p_digest: 'r2', p_expected_cursor: null, p_operations: [{ op: 'delete', table: TABLE, id: a, expectedRevision: 3, fields: { notes: 'no' } }] }), 'INVALID_FIELDS');

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

test('lecturas registradas: función propia y vista de proyección con filtros; no registrada → 422', async () => {
  const { t, owner, reader } = await setup();
  await t.db.exec(`
    create view invoices.suppliers_projection as select id, name, default_category, revision from invoices.suppliers where deleted_at is null;
    create function invoices.count_suppliers(p_ctx jsonb) returns jsonb language sql stable as $$ select jsonb_build_object('count', count(*), 'actor', p_ctx->>'actor') from invoices.suppliers $$;
    select core.allow_read('invoices', 'invoices.suppliers_projection', 'view');
    select core.allow_read('invoices', 'invoices.count_suppliers', 'function', '{editor,owner}');
  `);
  const a = crypto.randomUUID(), b = crypto.randomUUID();
  await t.rpc('core_commit', { p_app: APP, p_actor: owner, p_request_id: 'r', p_digest: 'r', p_expected_cursor: null, p_operations: [
    { op: 'insert', table: TABLE, id: a, fields: { name: 'A', default_category: 'compras' } }, { op: 'insert', table: TABLE, id: b, fields: { name: 'B', default_category: 'seguros' } }] });
  const all = (await t.rpc('core_read', { p_app: APP, p_actor: reader, p_name: 'invoices.suppliers_projection', p_args: {} })) as any;
  assert.equal(all.total, 2); assert.deepEqual(Object.keys(all.rows[0]).sort(), ['default_category', 'id', 'name', 'revision']);
  const filtered = (await t.rpc('core_read', { p_app: APP, p_actor: reader, p_name: 'invoices.suppliers_projection', p_args: { where: { default_category: 'seguros' }, limit: 10 } })) as any;
  assert.deepEqual(filtered.rows.map((r: any) => r.name), ['B']);
  await expectFail(t.rpc('core_read', { p_app: APP, p_actor: reader, p_name: 'invoices.suppliers_projection', p_args: { where: { tax_id: 'x' } } }), 'INVALID_OPERATION');
  const fn = (await t.rpc('core_read', { p_app: APP, p_actor: owner, p_name: 'invoices.count_suppliers', p_args: {} })) as any;
  assert.equal(fn.count, 2); assert.equal(fn.actor, owner);
  await expectFail(t.rpc('core_read', { p_app: APP, p_actor: reader, p_name: 'invoices.count_suppliers', p_args: {} }), 'FORBIDDEN');
  await expectFail(t.rpc('core_read', { p_app: APP, p_actor: owner, p_name: 'invoices.suppliers', p_args: {} }), 'INVALID_OPERATION');
  await t.close();
});

test('acciones invocables: editor sí, reader no, sistema sí; baja de tabla y de lectura', async () => {
  const { t, owner, editor, reader } = await setup();
  await t.db.exec(`
    create table invoices.jobs (id serial primary key, note text, claimed_by uuid, claimed_at timestamptz);
    insert into invoices.jobs (note) values ('uno'), ('dos');
    create function invoices.claim_job(p_ctx jsonb) returns jsonb language plpgsql as $$
      declare v_id int; begin
        update invoices.jobs set claimed_by = nullif(p_ctx->>'actor','')::uuid, claimed_at = now() where id = (select id from invoices.jobs where claimed_at is null order by id limit 1) returning id into v_id;
        return jsonb_build_object('job', v_id, 'role', p_ctx->>'role'); end $$;
    select core.allow_read('invoices', 'invoices.claim_job', 'action', '{editor,owner}');
  `);
  const a = (await t.rpc('core_invoke', { p_app: APP, p_actor: editor, p_name: 'invoices.claim_job', p_args: {} })) as any;
  assert.equal(a.job, 1); assert.equal(a.role, 'editor');
  await expectFail(t.rpc('core_invoke', { p_app: APP, p_actor: reader, p_name: 'invoices.claim_job', p_args: {} }), 'FORBIDDEN');
  const sys = (await t.rpc('core_invoke', { p_app: APP, p_actor: null, p_name: 'invoices.claim_job', p_args: {} })) as any;
  assert.equal(sys.job, 2); assert.equal(sys.role, 'system');
  await expectFail(t.rpc('core_read', { p_app: APP, p_actor: owner, p_name: 'invoices.claim_job', p_args: {} }), 'INVALID_OPERATION');
  await t.db.exec(`select core.disallow_read('invoices', 'invoices.claim_job'); select core.unregister_table('invoices', 'invoices', 'suppliers');`);
  await expectFail(t.rpc('core_invoke', { p_app: APP, p_actor: owner, p_name: 'invoices.claim_job', p_args: {} }), 'INVALID_OPERATION');
  const boot = (await t.rpc('core_bootstrap', { p_app: APP, p_user: owner })) as any;
  assert.equal(boot.tables.some((x: any) => x.table === TABLE), false, 'la tabla dada de baja desaparece del bootstrap');
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
