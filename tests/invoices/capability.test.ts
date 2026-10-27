/**
 * 0246: la ficha de «Registrar compra rápida» está en el catálogo de capacidades del núcleo (0097) con la ruta, los roles,
 * el riesgo, la idempotencia y los esquemas de API.md §18.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

test('invoices.register_purchase_quick en core.capabilities', async () => {
  const db = await createTestDatabase();
  const row = (await db.db.query<Record<string, any>>(`select * from core.capabilities where id = 'invoices.register_purchase_quick'`)).rows[0];
  assert.ok(row, 'registrada');
  assert.equal(row.app, 'invoices');
  assert.equal(row.route, 'POST purchases/quick');
  assert.deepEqual(row.roles, ['editor', 'owner']);
  assert.deepEqual([row.risk, row.idempotent, row.reversible, row.kind], ['low', true, false, 'execute']);
  assert.deepEqual(row.input_schema.required, ['requestId', 'supplier', 'date', 'total', 'description', 'target']);
  assert.ok(row.output_schema.required.includes('summary'));
  assert.ok(row.output_schema.required.includes('nature'));
  assert.ok('invoice_number' in row.input_schema.properties);
  assert.ok(row.anchors.includes('invoices.facturas.nueva'));
  await db.close();
});
