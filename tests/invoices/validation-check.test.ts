/** Incidencia del usuario (9-10-2026): «Validar» comprueba antes de enviar lo mismo que el servidor y explica el rechazo. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validationMissing, validationRejectionText } from '../../packages/domain-invoices/src/index.ts';

const base = { invoice_date: '2026-05-20', expense_category: 'servicios', source_total: 121 };
const lines = [{ net_amount: 100 }];
const taxes = [{ tax_type: 'iva' as const, rate: 21, taxable_base: 100, amount: 21 }];

test('lista para validar, y lo que falta en el orden en que se arregla', () => {
  assert.deepEqual(validationMissing({ invoice: base, lines, taxes, hasOriginal: true }), []);
  assert.deepEqual(validationMissing({ invoice: { ...base, expense_category: null }, lines, taxes, hasOriginal: true }), ['expense_category']);
  assert.deepEqual(validationMissing({ invoice: { ...base, invoice_date: null, expense_category: null }, lines: [], taxes: [], hasOriginal: false }), ['invoice_date', 'expense_category', 'original_file', 'lines_or_taxes', 'totals']);
  assert.deepEqual(validationMissing({ invoice: { ...base, source_total: 130 }, lines, taxes, hasOriginal: true }), ['totals']);
  assert.deepEqual(validationMissing({ invoice: { ...base, invoice_kind: 'rectificativa' }, lines, taxes, hasOriginal: true }), ['rectified_invoice', 'rectification_sign']);
});

test('el rechazo del servidor, en español', () => {
  assert.equal(validationRejectionText({ code: 'INVOICE_INCOMPLETE', details: { missing: ['expense_category'] } }), 'falta la categoría de gasto');
  assert.equal(validationRejectionText({ code: 'INVOICE_TOTALS_MISMATCH', details: {} }), 'falta que los importes cuadren con el total del documento');
  assert.equal(validationRejectionText({ code: 'OTRA_COSA' }), null);
});
