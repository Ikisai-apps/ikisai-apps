/** fl-22: la cabecera X-Ikisai-Scope llega a los hooks `visible` como ctx.scope y acota snapshot y changes; nunca amplía. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const TABLE = 'invoices.suppliers';
const ORIGIN = 'https://invoices.ikisai.com';

test('fl-22 · X-Ikisai-Scope: snapshot y changes acotados por el hook de la app; cabecera mala → 422; sin cabecera, todo', async () => {
  const app = await createTestApp({ app: 'invoices', slug: 'invoices-api', origin: ORIGIN, createHandler: (config) =>
    createApp({ ...config, app: 'invoices', slug: 'invoices-api', origins: [ORIGIN], hooks: {
      // La app decide qué significa el ámbito: aquí, nombres de proveedor que el dispositivo quiere ver.
      visible: (table, row, ctx) => {
        if (table !== TABLE || !ctx.scope) return true;
        const names = Array.isArray(ctx.scope.names) ? ctx.scope.names : null;
        return names === null || names.includes(row.name);
      },
    } }) });
  try {
    const a = crypto.randomUUID(); const b = crypto.randomUUID();
    const seed = await app.call('/api/v1/commands', { body: { requestId: 's-1', operations: [
      { op: 'insert', table: TABLE, id: a, fields: { name: 'Alfa', tax_id: null } }, { op: 'insert', table: TABLE, id: b, fields: { name: 'Beta', tax_id: null } }] } });
    assert.equal(seed.status, 200, JSON.stringify(seed.data));

    const all = await app.call(`/api/v1/snapshot?tables=${TABLE}`);
    assert.equal(all.status, 200); assert.equal(all.data.tables[0].rows.length, 2, 'sin cabecera baja todo');

    const scoped = await app.call(`/api/v1/snapshot?tables=${TABLE}`, { headers: { 'X-Ikisai-Scope': JSON.stringify({ names: ['Alfa'] }) } });
    assert.equal(scoped.status, 200, JSON.stringify(scoped.data));
    assert.deepEqual(scoped.data.tables[0].rows.map((r: any) => r.name), ['Alfa'], 'el ámbito acota el snapshot');

    const changes = await app.call('/api/v1/changes?after=0', { headers: { 'X-Ikisai-Scope': JSON.stringify({ names: ['Beta'] }) } });
    assert.equal(changes.status, 200, JSON.stringify(changes.data));
    assert.deepEqual(changes.data.items.filter((c: any) => c.table === TABLE).map((c: any) => c.after.name), ['Beta'], 'el ámbito acota los cambios');

    assert.equal((await app.call(`/api/v1/snapshot?tables=${TABLE}`, { headers: { 'X-Ikisai-Scope': 'no-json' } })).status, 422);
    assert.equal((await app.call(`/api/v1/snapshot?tables=${TABLE}`, { headers: { 'X-Ikisai-Scope': '[1,2]' } })).status, 422);
    assert.equal((await app.call(`/api/v1/snapshot?tables=${TABLE}`, { headers: { 'X-Ikisai-Scope': JSON.stringify({ x: 'y'.repeat(3000) }) } })).status, 422);
  } finally {
    await app.close();
  }
});
