/** Catálogo de capacidades (0097): registro, lista por permisos reales, invocación por la API del dueño con el token de la persona y recibos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/mod.ts';

test('capacidades · Flow invoca una capacidad de Invoices con la sesión de la persona; sin pertenencia, NEEDS_ACCESS; recibo de cada llamada', async () => {
  // Dos Edges sobre la misma base: la dueña (invoices) con su ruta, y la que ofrece (flow) con el catálogo.
  let invoices: Awaited<ReturnType<typeof createTestApp>> | null = null;
  const app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: 'https://flow.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'flow', slug: 'flow-api', origins: ['https://flow.ikisai.com'], capabilities: {
      apiBaseOf: () => 'https://invoices.test',
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : (input as Request).url;
        const path = url.replace('https://invoices.test', '');
        return invoices!.handler(new Request('https://x/invoices-api' + path, { method: init?.method, headers: { ...(init?.headers as Record<string, string>), Origin: 'https://invoices.ikisai.com' }, body: init?.body }));
      },
    } }) });
  try {
    const db = app.t.db;
    // La Edge de Invoices, con una ruta propia que hace de capacidad (idempotente por requestId).
    const seen: string[] = [];
    invoices = { handler: createApp({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch, app: 'invoices', slug: 'invoices-api', origins: ['https://invoices.ikisai.com'], routes: [
      { method: 'POST', pattern: 'test/compra', handler: async ({ ctx, json }) => { if (ctx.membership.role === 'reader') throw Object.assign(new Error('x'), { status: 403 }); const b = await json(); seen.push(b.requestId); return { purchaseId: 'c-' + seen.length, replayed: seen.indexOf(b.requestId) !== seen.length - 1, total: b.total }; } },
    ] }) } as never;
    await db.query(`select core.register_capability($1::jsonb)`, [JSON.stringify({ id: 'invoices.test_compra', app: 'invoices', kind: 'execute', title: 'Registrar compra rápida (prueba)', route: 'POST test/compra', roles: ['editor', 'owner'], risk: 'low', idempotent: true, input: { total: 'number' }, since: '0.1.0' })]);
    await assert.rejects(db.query(`select core.register_capability($1::jsonb)`, [JSON.stringify({ id: 'flow.ajena', app: 'invoices', title: 'x', route: 'POST x' })]), /INVALID_OPERATION/);

    // La persona (owner de Flow) aún no es de Invoices: ve el catálogo vacío y no puede invocar.
    const empty = await app.call('/api/v1/capabilities');
    assert.equal(empty.status, 200); assert.deepEqual(empty.data.items, []);
    const denied = await app.call('/api/v1/capabilities/invoices.test_compra/invoke', { body: { requestId: 'r1', total: 12 } });
    assert.equal(denied.status, 403); assert.equal(denied.data.error.code, 'NEEDS_ACCESS');

    // Como editora de Invoices: la ve permitida y la invoca; el dueño recibe su token y contesta.
    await db.query(`insert into core.memberships (app, user_id, role) values ('invoices', $1, 'editor')`, [app.users.owner]);
    const listed = await app.call('/api/v1/capabilities');
    assert.equal(listed.data.items.length, 1);
    assert.equal(listed.data.items[0].id, 'invoices.test_compra'); assert.equal(listed.data.items[0].allowed, true); assert.equal(listed.data.items[0].appName, 'Ikisai Finance');
    const done = await app.call('/api/v1/capabilities/invoices.test_compra/invoke', { body: { requestId: 'r1', total: 12 } });
    assert.equal(done.status, 200, JSON.stringify(done.data));
    assert.deepEqual(done.data, { capability: 'invoices.test_compra', version: 1, result: { purchaseId: 'c-1', replayed: false, total: 12 } });
    const again = await app.call('/api/v1/capabilities/invoices.test_compra/invoke', { body: { requestId: 'r1', total: 12 } });
    assert.equal(again.data.result.replayed, true, 'la idempotencia la da el dueño por requestId');

    // Recibos: dos buenos y uno denegado, sin cuerpos.
    const receipts = await app.call('/api/v1/capabilities/receipts');
    assert.equal(receipts.data.items.length, 3);
    assert.deepEqual(receipts.data.items.map((r: any) => [r.ok, r.status, r.errorCode]), [[true, 200, null], [true, 200, null], [false, 403, 'NEEDS_ACCESS']]);
    assert.deepEqual(receipts.data.items[0].summary, { purchaseId: 'c-2', replayed: true });
    const stored = await db.query<{ n: number }>(`select count(*)::int n from core.capability_receipts where caller_app = 'flow' and capability = 'invoices.test_compra'`);
    assert.equal(stored.rows[0]?.n, 3);

    // Un rol insuficiente en la app dueña: la ve, pero no permitida, y no puede invocar.
    await db.query(`update core.memberships set role = 'reader' where app = 'invoices' and user_id = $1`, [app.users.owner]);
    const asReader = await app.call('/api/v1/capabilities');
    assert.equal(asReader.data.items[0].allowed, false);
    const deniedRole = await app.call('/api/v1/capabilities/invoices.test_compra/invoke', { body: { requestId: 'r2' } });
    assert.equal(deniedRole.status, 403); assert.equal(deniedRole.data.error.code, 'NEEDS_ACCESS');

    // Retirada: deja de listarse y de invocarse.
    await db.query(`select core.deprecate_capability('invoices.test_compra')`);
    assert.deepEqual((await app.call('/api/v1/capabilities')).data.items, []);
    const gone = await app.call('/api/v1/capabilities/invoices.test_compra/invoke', { body: {} });
    assert.equal(gone.status, 410);
    const unknown = await app.call('/api/v1/capabilities/invoices.nada/invoke', { body: {} });
    assert.equal(unknown.status, 404);
  } finally {
    await app.close();
  }
});

test('ámbito de la lectora (0098) · la dueña pregunta al núcleo y el núcleo al resolutor de la app que lee', async () => {
  const app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: 'https://flow.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'flow', slug: 'flow-api', origins: ['https://flow.ikisai.com'] }) });
  try {
    const db = app.t.db;
    // Sin resolutor, nadie está en ámbito.
    assert.equal((await db.query<{ ok: boolean }>(`select core.reader_in_scope('flow', $1, 'booking_event', 'ev-1') ok`, [app.users.owner])).rows[0]?.ok, false);
    await db.exec(`create table flow.test_scope (actor uuid, event text);
      create function flow.test_in_scope(p_actor uuid, p_kind text, p_id text) returns boolean language sql stable as $$
        select p_kind = 'booking_event' and exists (select 1 from flow.test_scope where actor = p_actor and event = p_id) $$;
      select core.allow_scope_resolver('flow', 'flow.test_in_scope');`);
    await db.query(`insert into flow.test_scope values ($1, 'ev-1')`, [app.users.owner]);
    const q = (actor: string, id: string) => db.query<{ ok: boolean }>(`select core.reader_in_scope('flow', $1, 'booking_event', $2) ok`, [actor, id]).then((r) => r.rows[0]?.ok);
    assert.equal(await q(app.users.owner, 'ev-1'), true);
    assert.equal(await q(app.users.owner, 'ev-2'), false);
    assert.equal(await q(app.users.editor, 'ev-1'), false);
    assert.equal((await db.query<{ ok: boolean }>(`select core.reader_in_scope('booking', $1, 'booking_event', 'ev-1') ok`, [app.users.owner])).rows[0]?.ok, false, 'otra app sin resolutor');
  } finally {
    await app.close();
  }
});
