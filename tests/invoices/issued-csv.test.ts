/** Importación de emitidas desde CSV (API.md §13.4, ronda 26): lectura, mapeo, formatos españoles, agrupación y operaciones. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INCOME_CATEGORY_VAT, ISSUED_CSV_TEMPLATE_HEADER, ISSUED_EXTRACTION_PROMPT, guessMapping, issuedDrafts, issuedImportOperations, issuedImportPlan, parseCsv, parseDate, parseMoney,
} from '../../packages/domain-invoices/src/index.ts';

const SHEET = [
  'Nº Factura;Fecha;Cliente;NIF;Concepto;Categoría;Base imponible;% IVA;Cuota IVA;Total;Cobrada',
  'A-2026-0001;06/10/2026;Cliente Uno SL;B11111111;Estancia retiro;Alojamiento;"1.000,00";10;100,00;1.100,00 €;sí',
  'A-2026-0002;7/10/26;;;Comida grupo;restaurante;50;10;;55;',
  'A-2026-0003;2026-10-08;Cliente Dos;B22222222;Taller;actividades;100;;;121;no',
  'A-2026-0004;31/02/2026;Cliente Tres;B33333333;Mal fecha;otros;10;21;2,1;12,1;',
].join('\r\n');

test('CSV: separador, comillas, BOM y filas vacías', () => {
  const rows = parseCsv('﻿a,b,c\n"x, y","con ""comillas""",3\n\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'con "comillas"', '3']]);
  assert.equal(parseCsv(SHEET).length, 5);
  assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

test('importes y fechas en formato español e inglés', () => {
  assert.equal(parseMoney('1.234,56 €'), 1234.56); assert.equal(parseMoney('1234,5'), 1234.5); assert.equal(parseMoney('1,234.56'), 1234.56);
  assert.equal(parseMoney('1.000.000'), 1000000); assert.equal(parseMoney('-12.5'), -12.5); assert.equal(parseMoney(''), null); assert.equal(parseMoney('abc'), null);
  assert.equal(parseDate('06/10/2026'), '2026-10-06'); assert.equal(parseDate('7-10-26'), '2026-10-07'); assert.equal(parseDate('2026/10/08'), '2026-10-08');
  assert.equal(parseDate('31/02/2026'), null); assert.equal(parseDate('ayer'), null);
});

test('mapeo adivinado por la cabecera del Sheet y por la plantilla', () => {
  const [header] = parseCsv(SHEET);
  assert.deepEqual(guessMapping(header!), { number: 0, issue_date: 1, recipient_name: 2, recipient_tax_id: 3, description: 4, income_category: 5, base: 6, vat_rate: 7, vat_amount: 8, total: 9, paid: 10 });
  const t = guessMapping(ISSUED_CSV_TEMPLATE_HEADER);
  assert.equal(Object.keys(t).length, ISSUED_CSV_TEMPLATE_HEADER.length);
  assert.equal(t.vat_rate, 10); assert.equal(t.vat_amount, 11); assert.equal(t.series, 0); assert.equal(t.number, 1); assert.equal(t.invoice_type, 4);
});

test('borradores: tipo por NIF, IVA desde la cuota o la categoría, errores y avisos; agrupación por número y operaciones', () => {
  const [header, ...rows] = parseCsv(SHEET);
  const drafts = issuedDrafts(rows, guessMapping(header!), 'A');
  assert.equal(drafts[0]!.full_number, 'A-2026-0001'); assert.equal(drafts[0]!.invoice_type, 'F1'); assert.equal(drafts[0]!.base, 1000); assert.equal(drafts[0]!.paid, true);
  assert.equal(drafts[0]!.income_category, 'alojamiento'); assert.deepEqual(drafts[0]!.errors, []);
  assert.equal(drafts[1]!.invoice_type, 'F2'); assert.equal(drafts[1]!.income_category, 'restauracion'); assert.equal(drafts[1]!.vat_amount, 5);
  assert.equal(drafts[2]!.vat_rate, INCOME_CATEGORY_VAT.actividades); assert.match(drafts[2]!.warnings[0]!, /se propone el 21 %/);
  assert.match(drafts[3]!.errors[0]!, /Fecha no reconocida/);
  // Dos filas con el mismo número (dos tipos de IVA) son una sola factura
  const multi = issuedDrafts([['B', '7', '2026-10-09', '', 'F1', 'Cliente', 'B1', 'Cena', 'restauracion', '100', '10', '10', '', '131', ''],
    ['B', '7', '2026-10-09', '', 'F1', 'Cliente', 'B1', 'Vino', 'restauracion', '20', '21', '4,2', '', '131', '']], guessMapping(ISSUED_CSV_TEMPLATE_HEADER), 'A');
  const plan = issuedImportPlan(multi);
  assert.equal(plan.length, 1); assert.equal(plan[0]!.full_number, 'B-7'); assert.deepEqual(plan[0]!.totals, { base: 120, quota: 14.2, withholding: 0, total: 134.2 });
  assert.match(plan[0]!.warnings[0]!, /no cuadra/);
  let n = 0;
  const ops = issuedImportOperations(plan[0]!, { id: 'inv', uuid: () => `id-${++n}`, tool: 'google_sheet' });
  assert.deepEqual(ops.map((o) => o.table), ['invoices.issued_invoices', 'invoices.issued_invoice_lines', 'invoices.issued_invoice_lines', 'invoices.issued_tax_lines', 'invoices.issued_tax_lines']);
  assert.equal(ops[0]!.fields.origin, 'importada'); assert.equal(ops[0]!.fields.external_id, 'B|7'); assert.equal(ops[0]!.fields.review_reason, 'REVISAR IMPORTES');
  assert.ok(ISSUED_EXTRACTION_PROMPT.includes(ISSUED_CSV_TEMPLATE_HEADER.join(';')));
});
