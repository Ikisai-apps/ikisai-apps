import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabase } from '../../supabase/functions/_kit/supabase.ts';
import { Fault } from '../../supabase/functions/_kit/errors.ts';

function clientReturning(status: number, body: unknown) {
  return createSupabase({
    url: 'https://x.supabase.co', anonKey: 'a', serviceKey: 's',
    fetch: (async () => Response.json(body, { status })) as unknown as typeof fetch,
  });
}

async function faultOf(promise: Promise<unknown>): Promise<Fault> {
  try { await promise; } catch (e) { if (e instanceof Fault) return e; throw e; }
  assert.fail('esperaba Fault');
}

test('errores PT del núcleo se traducen a su estado y código', async () => {
  const f = await faultOf(clientReturning(400, { code: 'PT409', message: 'VERSION_CONFLICT', details: '{"currentRevision":3}' }).rpc('core_commit', {}));
  assert.equal(f.status, 409); assert.equal(f.code, 'VERSION_CONFLICT'); assert.deepEqual(f.details, { currentRevision: 3 });
});

test('violaciones de restricción SQL son 422 definitivos, nunca 503', async () => {
  const f = await faultOf(clientReturning(400, { code: '23514', message: 'new row violates check constraint "suppliers_name_check"', details: null, hint: null }).rpc('core_commit', {}));
  assert.equal(f.status, 422); assert.equal(f.code, 'CONSTRAINT_VIOLATION'); assert.equal((f.details as any).sqlstate, '23514');
  const g = await faultOf(clientReturning(400, { code: '22P02', message: 'invalid input syntax for type uuid' }).rpc('core_commit', {}));
  assert.equal(g.status, 422); assert.equal(g.code, 'INVALID_VALUE');
  const h = await faultOf(clientReturning(400, { code: 'P0001', message: 'TASK_BLOCKED' }).rpc('core_commit', {}));
  assert.equal(h.status, 422); assert.equal(h.code, 'DOMAIN_ERROR'); assert.equal(h.message, 'TASK_BLOCKED');
  const i = await faultOf(clientReturning(400, { code: '42703', message: 'column "nope" does not exist' }).rpc('core_commit', {}));
  assert.equal(i.status, 422); assert.equal(i.code, 'SQL_ERROR');
});

test('errores de transporte y 5xx sin SQLSTATE siguen siendo 503 reintentables', async () => {
  const f = await faultOf(clientReturning(502, { message: 'bad gateway' }).rpc('core_commit', {}));
  assert.equal(f.status, 503); assert.equal(f.code, 'BACKEND_UNAVAILABLE');
});
