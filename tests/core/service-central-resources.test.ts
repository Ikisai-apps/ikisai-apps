/** 0126: el servicio «Central (sistema)» es editor de Central y hereda el acceso a Recursos (derivado, 0091), sin concesión directa. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0126 · registrar el servicio central da editor en central y editor derivado en resources', async () => {
  const app = await createTestApp({ app: 'central', slug: 'central-api', origin: 'https://central.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'central', slug: 'central-api', origins: ['https://central.ikisai.com'], workerKey: 'k' }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'central')`, [service]);
    const rows = (await db.query<{ app: string; role: string }>(`select app, role from core.memberships where user_id = $1 order by app`, [service])).rows;
    assert.deepEqual(rows, [{ app: 'central', role: 'editor' }, { app: 'flow', role: 'editor' }, { app: 'resources', role: 'editor' }], JSON.stringify(rows));
    // Repetir la sincronización no falla ni duplica.
    await db.query(`select core.sync_service_grants()`);
    const again = (await db.query<{ n: string }>(`select count(*)::text as n from core.memberships where user_id = $1`, [service])).rows[0]!.n;
    assert.equal(again, '3');
  } finally {
    await app.close();
  }
});
