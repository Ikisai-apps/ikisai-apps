/**
 * Proveedores para Food (decisión de VG Q3 d, API.md §7.10, migración 0267): Food lee los proveedores de Finance por la
 * vista publicada y da de alta uno nuevo por la ruta de worker, sin duplicar por NIF ni por nombre. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';

const WORKER_KEY = 'clave-de-worker-sintetica';
let app: TestApp;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, workerKey: WORKER_KEY }),
  });
});

const food = { 'x-ikisai-worker-key': WORKER_KEY, 'x-ikisai-caller': 'food' };
const register = (body: Record<string, unknown>, headers: Record<string, string> = food) =>
  app.call('/api/v1/worker/suppliers', { token: null, method: 'POST', body, headers });
const projection = async () =>
  (await app.t.db.query<{ id: string; name: string; tax_id: string | null; active: boolean }>(`select id, name, tax_id, active from invoices.food_supplier_projection order by name`)).rows;

test('alta desde Food: crea, y el mismo NIF o el mismo nombre devuelven el que ya hay', async () => {
  const first = await register({ name: '  Huerta  Sintética SL ', tax_id: 'b-12345674' });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.deepEqual([first.data.status, first.data.name, first.data.tax_id, first.data.active], ['created', 'Huerta Sintética SL', 'B12345674', true]);
  const row = (await app.t.db.query<Record<string, any>>(`select * from invoices.suppliers where id = $1`, [first.data.id])).rows[0]!;
  assert.equal(row.notes, 'Alta desde Food.');
  assert.ok(row.slug, 'el slug sale del nombre');

  const byTax = await register({ name: 'Otro nombre', tax_id: 'B12345674' });
  assert.deepEqual([byTax.data.status, byTax.data.matched_by, byTax.data.id], ['existing', 'tax_id', first.data.id]);
  const byName = await register({ name: 'huerta sintetica, s.l.' });
  assert.deepEqual([byName.data.status, byName.data.matched_by, byName.data.id], ['existing', 'name', first.data.id], 'sin tildes, mayúsculas ni puntos');

  // Mismo nombre con otro NIF: es otro proveedor
  const other = await register({ name: 'Huerta Sintética SL', tax_id: 'FR12345678901' });
  assert.equal(other.data.status, 'created');
  assert.notEqual(other.data.id, first.data.id);
});

test('la vista publicada lleva id, nombre, NIF y si está activo (los de la papelera, como inactivos)', async () => {
  const made = await register({ name: 'Panadería de Prueba' });
  assert.equal(made.data.status, 'created');
  await app.t.db.query(`update invoices.suppliers set deleted_at = now() where id = $1`, [made.data.id]);
  const rows = await projection();
  const gone = rows.find((r) => r.id === made.data.id)!;
  assert.deepEqual([gone.name, gone.active], ['Panadería de Prueba', false]);
  assert.deepEqual(Object.keys(rows[0]!).sort(), ['active', 'id', 'name', 'tax_id']);
  // En la papelera no cuenta como duplicado
  const again = await register({ name: 'Panadería de Prueba' });
  assert.equal(again.data.status, 'created');
});

test('otra app, sin clave, sin nombre o con un NIF mal: se rechaza', async () => {
  const tasks = await register({ name: 'X' }, { ...food, 'x-ikisai-caller': 'tasks' });
  assert.deepEqual([tasks.status, tasks.data.error.code], [403, 'CALLER_REJECTED']);
  const noKey = await register({ name: 'X' }, { 'x-ikisai-caller': 'food' });
  assert.ok(noKey.status === 401 || noKey.status === 403, String(noKey.status));
  const noName = await register({ name: '  ' });
  assert.deepEqual([noName.status, noName.data.error.code], [422, 'INVALID_ARGS']);
  const badTax = await register({ name: 'Mala Letra SL', tax_id: '12345678A' });
  assert.deepEqual([badTax.status, badTax.data.error.code], [422, 'TAX_ID_INVALID']);
});
