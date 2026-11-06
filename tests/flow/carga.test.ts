/**
 * Flow · «Carga asistida» (fl-25, núcleo 0120), sobre PGlite: flow-api lee la bandeja de propuestas de la app destino y
 * decide por grupo o una a una, con la sesión de quien entra. La app destino se simula con `appsFetch`. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
let app: TestApp;
const calls: Array<{ url: string; method: string; auth: string | null }> = [];
let reply: (url: string) => Response = () => Response.json({});
const P1 = '11111111-1111-4111-8111-111111111111';

test.before(async () => {
  const appsFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', auth: new Headers(init?.headers).get('Authorization') });
    return reply(u);
  }) as typeof fetch;
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }, { appsFetch }) });
});
test.after(async () => { await app.close(); });

test('carga asistida · la bandeja de la app destino, filtrada por grupo, con la sesión de quien entra', async () => {
  reply = () => Response.json({ items: [
    { id: P1, groupKey: 'g1', fields: ['booking.guests.document_number'], uncertain: [], summary: { text: 'Alta de 2 huéspedes' } },
    { id: '22222222-2222-4222-8222-222222222222', groupKey: 'g2', fields: [], uncertain: [], summary: {} }] });
  const r = await app.call('/api/v1/carga/booking/proposals?grupo=g1');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.items.map((p: any) => p.id), [P1]);
  const last = calls.at(-1)!;
  assert.match(last.url, /\/functions\/v1\/booking-api\/api\/v1\/proposals\?status=pending$/); assert.equal(last.method, 'GET');
  assert.equal(last.auth, 'Bearer ' + app.tokens.owner);
});

test('carga asistida · decidir el grupo o una propuesta va a la app destino; apps y rutas fuera de lista, no', async () => {
  reply = () => Response.json({ approved: 1, items: [] });
  let r = await app.call('/api/v1/carga/finance/group/g1/approve', { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(calls.at(-1)!.url, /\/invoices-api\/api\/v1\/proposals\/group\/g1\/approve$/); assert.equal(calls.at(-1)!.method, 'POST');
  r = await app.call(`/api/v1/carga/booking/proposals/${P1}/reject`, { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.match(calls.at(-1)!.url, new RegExp(`/booking-api/api/v1/proposals/${P1}/reject$`));
  const before = calls.length;
  assert.equal((await app.call('/api/v1/carga/central/proposals')).status, 404);
  assert.equal((await app.call('/api/v1/carga/booking/group/g1/borrar', { body: {} })).status, 404);
  assert.equal(calls.length, before);
  // Sin acceso a la app destino: lo dice.
  reply = () => Response.json({ error: { code: 'NO_MEMBERSHIP', message: 'x', details: null } }, { status: 403 });
  r = await app.call('/api/v1/carga/booking/proposals');
  assert.equal(r.status, 403); assert.equal(r.data.error.code, 'NEEDS_ACCESS');
});
