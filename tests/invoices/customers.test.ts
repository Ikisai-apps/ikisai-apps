/** Directorio de clientes por NIF (ronda 46): búsqueda, NIF normalizado y qué ofrecer al emitir. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { customerOffer, customerTaxId, findCustomerByTaxId, searchCustomers, type CustomerRow } from '../../packages/domain-invoices/src/index.ts';

const base = { revision: 1, created_at: '', updated_at: '', updated_by: null, deleted_at: null };
const C: CustomerRow[] = [
  { ...base, id: '1', name: 'Asociación Yoga Norte', tax_id: 'G12345678', id_type: 'NIF', country: 'ES', kind: 'empresa', address: { line: 'Calle del Norte 5', postal_code: '48001', city: 'Bilbao' } },
  { ...base, id: '2', name: 'Cliente Emisión SL', tax_id: 'B55555555', id_type: 'NIF', country: 'ES', kind: 'empresa', address: { line: 'Calle Cliente 2', postal_code: '28002', city: 'Madrid' } },
  { ...base, id: '3', name: 'Borrado SL', tax_id: 'B99999999', id_type: 'NIF', country: 'ES', kind: 'empresa', address: null, deleted_at: '2026-10-01' },
];

test('buscar por nombre (sin acentos) o NIF; los borrados no salen', () => {
  assert.deepEqual(searchCustomers(C, 'asociacion').map((c) => c.id), ['1']);
  assert.deepEqual(searchCustomers(C, 'cliente emi').map((c) => c.id), ['2']);
  assert.deepEqual(searchCustomers(C, 'b55 555 555').map((c) => c.id), ['2']);
  assert.deepEqual(searchCustomers(C, 'borrado'), []);
  assert.deepEqual(searchCustomers(C, 'a'), []);
  assert.equal(customerTaxId(' b-12.345/674 '), 'B-12345674');
  assert.equal(findCustomerByTaxId(C, 'g12345678')?.id, '1');
});

test('al emitir: guardar un NIF nuevo, actualizar si cambió el domicilio, nada si coincide', () => {
  const inv = { recipient_name: 'Nuevo Cliente SL', recipient_tax_id: 'b11111111', recipient_country: 'ES', recipient_kind: 'empresa', recipient_id_type: 'NIF', recipient_address: { line: 'Calle 1', postal_code: '28001', city: 'Madrid' } };
  const create = customerOffer(C, inv);
  assert.equal(create?.action, 'create'); assert.equal((create as { fields: Record<string, unknown> }).fields.tax_id, 'B11111111');
  const same = { ...inv, recipient_name: 'Cliente Emisión SL', recipient_tax_id: 'B55555555', recipient_address: { line: 'Calle Cliente 2', postal_code: '28002', city: 'Madrid' } };
  assert.equal(customerOffer(C, same), null);
  const moved = customerOffer(C, { ...same, recipient_address: { line: 'Calle Nueva 9', postal_code: '28003', city: 'Madrid' } });
  assert.equal(moved?.action, 'update');
  assert.equal(customerOffer(C, { ...inv, recipient_tax_id: null }), null);
});
