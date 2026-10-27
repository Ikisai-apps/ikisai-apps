/**
 * Flow · frenos de la carta pública (FL5, migración 0923), sobre PGlite: tope de pedidos abiertos por cliente, de pedidos
 * por minuto por cliente, de altas de clientes por minuto en un flujo, y freno por IP en la Edge. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, createIpLimiter, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
const AGUA = '0f10a000-0000-4000-8000-000000000301';
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const pub = (path: string, init: { body?: unknown; token?: string; ip?: string } = {}) =>
  app.call(`/api/v1/public/${path}`, { token: null, body: init.body ?? {},
    headers: { ...(init.token ? { 'X-Flow-Customer': init.token } : {}), ...(init.ip ? { 'X-Ikisai-Client-Ip': init.ip } : {}) } });
const order = (token: string) => pub('orders', { token, body: { lines: [{ productId: AGUA, quantity: 1 }] } });
async function rows(table: string): Promise<any[]> { return (await app.call(`/api/v1/snapshot?tables=${table}`)).data.tables[0].rows; }

test('carta pública · 5 pedidos abiertos por cliente; al cobrar uno, puede pedir otro', async () => {
  const c = await pub('customer');
  assert.equal(c.status, 200, JSON.stringify(c.data));
  for (let i = 0; i < 5; i += 1) assert.equal((await order(c.data.token)).status, 200);
  const sixth = await order(c.data.token);
  assert.equal(sixth.status, 429); assert.equal(sixth.data.error.code, 'TOO_MANY_OPEN_ORDERS');
  assert.match(sixth.data.error.message, /sin cobrar/);
  // La caja cobra dos: vuelve a poder pedir (3 abiertos → 4); con 6 creados en este minuto, el siguiente lo frena el tope
  // por minuto aunque siga por debajo de 5 abiertos.
  const customerId = (await rows(TABLES.customers)).find((x) => x.number === c.data.number).id;
  const open = (await rows(TABLES.orders)).filter((x) => x.origin === 'public' && x.status === 'open' && x.customer_id === customerId);
  for (const o of open.slice(0, 2)) {
    const r = await app.call('/api/v1/commands', { body: { requestId: `pl-${++seq}`, operations: [{ op: 'call', procedure: PROCEDURES.confirmPayment, args: { order_id: o.id, method: 'cash', expected_revision: o.revision } }] } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  assert.equal((await order(c.data.token)).status, 200);
  const burst = await order(c.data.token);
  assert.equal(burst.status, 429); assert.equal(burst.data.error.code, 'RATE_LIMITED');
});

test('carta pública · 60 altas de clientes por minuto en un flujo; la 61 se frena', async () => {
  const before = (await rows(TABLES.customers)).filter((c) => Date.parse(c.created_at) > Date.now() - 60_000).length;
  for (let i = before; i < 60; i += 1) assert.equal((await pub('customer')).status, 200);
  const over = await pub('customer');
  assert.equal(over.status, 429); assert.equal(over.data.error.code, 'RATE_LIMITED');
});

test('carta pública · freno por IP en la Edge (ventana deslizante)', async () => {
  let t = 0;
  const allow = createIpLimiter(() => t);
  for (let i = 0; i < 10; i += 1) assert.equal(allow('customer', '198.51.100.7'), true);
  assert.equal(allow('customer', '198.51.100.7'), false);
  assert.equal(allow('customer', '198.51.100.8'), true); // otra IP
  assert.equal(allow('customer', null), true); // sin IP, deciden los topes de la base
  t += 10 * 60_000 + 1;
  assert.equal(allow('customer', '198.51.100.7'), true);
  for (let i = 0; i < 30; i += 1) allow('orders', '203.0.113.9');
  assert.equal(allow('orders', '203.0.113.9'), false);
});
