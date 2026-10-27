/** 0113: carriles de Flow en las cuentas de servicio y estimado de utilidad por app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0113 · las cuentas de servicio tienen su carril de Flow; sync repasa las ya registradas; Core y Core Ops ven todos', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    const svc = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [svc]);
    const m = (await db.query<{ app: string; role: string; scopes: any }>(`select app, role, scopes from core.memberships where user_id = $1 order by app`, [svc])).rows;
    assert.ok(m.some((x) => x.app === 'tasks'));
    assert.deepEqual(m.find((x) => x.app === 'flow')!.scopes, { lanes: ['booking'] });
    // Un servicio registrado antes de 0113 (sin scopes) se pone al día con sync.
    await db.query(`update core.memberships set scopes = null where user_id = $1 and app = 'flow'`, [svc]);
    const n = (await db.query<{ n: number }>(`select core.sync_service_grants() n`)).rows[0]!.n;
    assert.ok(n >= 2);
    assert.deepEqual((await db.query<{ scopes: any }>(`select scopes from core.memberships where user_id = $1 and app = 'flow'`, [svc])).rows[0]!.scopes, { lanes: ['booking'] });
    const ops = (await db.query<{ r: any }>(`select core.service_grants('core_ops') r`)).rows[0]!.r;
    assert.equal(ops.displayName, 'Core Ops (sistema)');
    assert.equal(ops.memberships[0].scopes.lanes.length, 12);
    for (const name of ['guests', 'tasks', 'central', 'uikit']) assert.ok((await db.query<{ r: any }>(`select core.service_grants($1) r`, [name])).rows[0]!.r, name);
  } finally {
    await app.close();
  }
});

test('0113 · usage_estimate: pone frequency y audience mientras Dirección no decide, y se aplica a funcionalidades que entran después', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    await db.query(`insert into core.usage_features (feature_id, app, label, catalogued, active) values ('booking.recepcion.cobrar', 'booking', 'Cobrar', true, true), ('booking.recepcion.decidida', 'booking', 'Decidida', true, true)`);
    await db.query(`update core.usage_features set decided_at = now(), frequency = 'rare_critical' where feature_id = 'booking.recepcion.decidida'`);
    const n = (await db.query<{ n: number }>(`select core.usage_estimate('booking', '[{"id":"booking.recepcion.cobrar","frequency":"frequent","audience":{"kinds":["staff"]}},{"id":"booking.recepcion.decidida","frequency":"normal"},{"id":"booking.recepcion.futura","frequency":"occasional"}]') n`)).rows[0]!.n;
    assert.equal(n, 1, 'solo la no decidida que existe');
    const rows = (await db.query<{ feature_id: string; frequency: string; audience: any }>(`select feature_id, frequency, audience from core.usage_features where app = 'booking' order by feature_id`)).rows;
    assert.equal(rows.find((r) => r.feature_id === 'booking.recepcion.cobrar')!.frequency, 'frequent');
    assert.deepEqual(rows.find((r) => r.feature_id === 'booking.recepcion.cobrar')!.audience.kinds, ['staff']);
    assert.equal(rows.find((r) => r.feature_id === 'booking.recepcion.decidida')!.frequency, 'rare_critical', 'lo decidido no se toca');
    // La funcionalidad que aún no existía recibe el estimado al entrar por el catálogo.
    await db.query(`insert into core.usage_features (feature_id, app, label, catalogued, active) values ('booking.recepcion.futura', 'booking', 'Futura', true, true)`);
    assert.equal((await db.query<{ f: string }>(`select frequency f from core.usage_features where feature_id = 'booking.recepcion.futura'`)).rows[0]!.f, 'occasional');
    await assert.rejects(db.query(`select core.usage_estimate('booking', '[{"id":"food.x"}]')`), /INVALID_OPERATION/);
  } finally {
    await app.close();
  }
});
