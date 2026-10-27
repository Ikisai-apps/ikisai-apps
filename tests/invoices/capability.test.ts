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
  await db.close();
});

test('0260: primer estimado de utilidad de Finance (core.usage_estimate, vg-39)', async () => {
  const db = await createTestDatabase();
  const rows = (await db.db.query<{ feature_id: string; frequency: string }>(`select feature_id, frequency from core.usage_estimates where app = 'invoices' order by feature_id`)).rows;
  const by = new Map(rows.map((r) => [r.feature_id, r.frequency]));
  assert.equal(by.get('invoices.facturas.nueva'), 'frequent');
  assert.equal(by.get('invoices.gestoria'), 'rare_critical');
  assert.equal(by.get('invoices.guia'), 'do_not_evaluate');
  assert.ok(rows.every((r) => r.feature_id.startsWith('invoices.')));
  await db.close();
});
