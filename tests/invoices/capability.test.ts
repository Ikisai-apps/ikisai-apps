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
  assert.ok('receipt_kind' in row.input_schema.properties, '0247 la actualiza');
  assert.ok(row.anchors.includes('invoices.facturas.nueva'));
  // 0258: qué lee y qué escribe (entity.prop = esquema.tabla.columna), para la cobertura de campos (núcleo 0111)
  assert.ok(row.writes.includes('invoices.invoices.supplier_id') && row.writes.includes('invoices.allocations.target_id') && row.writes.includes('invoices.invoices.receipt_kind'));
  assert.ok(row.reads.includes('invoices.suppliers.tax_id'));
  // Cada columna declarada existe de verdad
  for (const ref of [...row.reads, ...row.writes] as string[]) {
    const [schema, table, column] = ref.split('.');
    const found = await db.db.query(`select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3`, [schema, table, column]);
    assert.equal(found.rows.length, 1, ref);
  }
  await db.close();
});
