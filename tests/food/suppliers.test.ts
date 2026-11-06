/**
 * Food · alta de proveedores en Finance desde la compra (C2, FB_2026_086; VG Q3 d). La ruta `suppliers` llama a la de
 * worker de Finance (docs/invoices/API.md §7.10) con la clave y `X-Ikisai-Caller: food`, y traduce su respuesta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierInput, supplierRoutes } from '../../supabase/functions/food-api/suppliers.ts';

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function route(reply: { status: number; body: unknown }, sent: Sent[] = []) {
  const invoicesFetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  const [r] = supplierRoutes({ invoicesApiBase: 'https://finance.test', invoicesFetch, workerKey: 'clave' });
  return (role: string, body: unknown) => (r!.handler as any)({ ctx: { membership: { role } }, json: async () => body });
}

test('supplierInput limpia el nombre y rechaza uno vacío o largo', () => {
  assert.deepEqual(supplierInput({ name: '  Frutas   Paco ', tax_id: ' B12345678 ' }), { name: 'Frutas Paco', tax_id: 'B12345678' });
  assert.deepEqual(supplierInput({ name: 'Panadería', tax_id: '' }), { name: 'Panadería', tax_id: null });
  assert.throws(() => supplierInput({ name: '   ' }));
  assert.throws(() => supplierInput({ name: 'x'.repeat(201) }));
});

test('el alta va a la ruta de worker de Finance y devuelve el proveedor (creado o el que ya había)', async () => {
  const sent: Sent[] = [];
  const call = route({ status: 200, body: { id: 'f-1', name: 'Frutas Paco', tax_id: null, active: true, status: 'existing', matched_by: 'name' } }, sent);
  const out = await call('editor', { name: 'frutas paco' });
  assert.deepEqual(out, { supplier: { id: 'f-1', name: 'Frutas Paco', tax_id: null, active: true }, created: false });
  assert.equal(sent[0]!.url, 'https://finance.test/api/v1/worker/suppliers');
  assert.equal(sent[0]!.headers['X-Ikisai-Worker-Key'], 'clave');
  assert.equal(sent[0]!.headers['X-Ikisai-Caller'], 'food');
  assert.deepEqual(sent[0]!.body, { name: 'frutas paco', tax_id: null });
});

test('un NIF que Finance rechaza sale como TAX_ID_INVALID; un lector no puede dar de alta', async () => {
  const call = route({ status: 422, body: { error: { code: 'TAX_ID_INVALID', message: 'NIF' } } });
  await assert.rejects(call('owner', { name: 'Makro', tax_id: 'B00000000' }), (e: any) => e.code === 'TAX_ID_INVALID');
  await assert.rejects(call('reader', { name: 'Makro' }), (e: any) => e.code === 'FORBIDDEN');
});
