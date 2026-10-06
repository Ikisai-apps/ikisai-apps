/** Fase 2: extracción determinista del texto de un PDF (NIF con control, fechas, importes por etiqueta, procedencia). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { amountsIn, datesIn, extractFromPdfText, linesFromItems, softDuplicate, validIban, validSpanishTaxId, type PdfTextItem } from '../../packages/domain-invoices/src/index.ts';

/** Fragmentos de una página a partir de líneas (y desciende 14 puntos por línea; columnas separadas por «|»). */
function page(lines: string[], pageNo = 1): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  lines.forEach((line, i) => line.split('|').forEach((part, col) => {
    if (part.trim()) items.push({ str: part.trim(), page: pageNo, x: 40 + col * 260, y: 800 - i * 14, w: part.trim().length * 5, h: 10 });
  }));
  return items;
}

const INVOICE = page([
  'FRUTAS PEPE S.L.',
  'C/ Mayor 1, Madrid   CIF: B12345674',
  'Cliente: Ikisai Retiros SL | NIF: 12345678Z',
  'Factura nº: A-2026/0457 | Fecha factura: 06/10/2026',
  'Vencimiento: 05/11/2026',
  'Tomate pera 20 kg | 40,00',
  'Aceite de oliva | 100,00',
  'Base imponible | 140,00 €',
  'IVA 10% sobre 40,00 | 4,00',
  'IVA 21 % 100,00 | 21,00',
  'Retención IRPF 15% | 6,00',
  'TOTAL FACTURA | 159,00 €',
  'IBAN: ES91 2100 0418 4502 0005 1332',
]);

test('NIF, NIE y CIF con dígito de control; IBAN con módulo 97', () => {
  assert.equal(validSpanishTaxId('B12345674'), 'B12345674'); assert.equal(validSpanishTaxId('b-1234567-4'), 'B12345674');
  assert.equal(validSpanishTaxId('B12345675'), null);
  assert.equal(validSpanishTaxId('12345678Z'), '12345678Z'); assert.equal(validSpanishTaxId('12345678A'), null);
  assert.equal(validSpanishTaxId('X1234567L'), 'X1234567L'); assert.equal(validSpanishTaxId('ESB12345674'), 'B12345674');
  assert.equal(validIban('ES91 2100 0418 4502 0005 1332'), 'ES9121000418450200051332'); assert.equal(validIban('ES91 2100 0418 4502 0005 1333'), null);
});

test('fechas e importes en formato español', () => {
  assert.deepEqual(datesIn('Fecha: 06/10/2026 · vence 5-11-26'), ['2026-10-06', '2026-11-05']);
  assert.deepEqual(datesIn('Madrid, 6 de octubre de 2026'), ['2026-10-06']);
  assert.deepEqual(amountsIn('IVA 21 % 1.000,00 210,00 €'), [1000, 210]);
  assert.deepEqual(amountsIn('Fecha 06/10/2026 Total 44,00'), [44]);
});

test('factura con texto: proveedor por NIF (el propio se descarta), número, fecha, dos tipos de IVA, IRPF, total e IBAN, con procedencia', () => {
  const r = extractFromPdfText(INVOICE, { ownTaxIds: ['12345678Z'] });
  assert.equal(r.hasText, true); assert.equal(r.ok, true, JSON.stringify(r));
  const d = r.document!;
  assert.equal(d.invoice.supplier_tax_id, 'B12345674'); assert.equal(d.invoice.supplier_name, 'FRUTAS PEPE S.L.');
  assert.equal(d.invoice.invoice_number, 'A-2026/0457'); assert.equal(d.invoice.invoice_date, '2026-10-06');
  assert.deepEqual(d.document_totals, { base: 140, vat: 25, withholding: 6, total: 159 });
  assert.deepEqual(d.lines.map((l) => [l.net_amount, l.vat_rate, l.vat_amount]), [[40, 10, 4], [100, 21, 21]]);
  assert.deepEqual(d.taxes.map((t) => `${t.tax_type}:${t.rate}:${t.amount}`), ['iva:10:4', 'iva:21:21', 'irpf:15:6']);
  assert.equal(r.iban, 'ES9121000418450200051332');
  assert.equal(r.provenance['invoice.invoice_date']!.method, 'pdf_text'); assert.equal(r.provenance['invoice.invoice_date']!.page, 1);
  assert.match(r.provenance['document_totals.total']!.text!, /TOTAL FACTURA/);
  assert.ok(r.provenance['invoice.supplier_name']!.confidence <= 0.5, 'el nombre adivinado no se da por bueno');
  assert.equal(r.provenance['invoice.object']!.confidence, 0);
  assert.ok((d.overall_confidence ?? 1) <= 0.5);
});

test('proveedor conocido por NIF, objeto de la factura pendiente y total calculado si no aparece', () => {
  const items = page(['Algo SL CIF B12345674', 'Fecha: 2026-10-08', 'Base imponible 50,00', 'IVA 21% 10,50']);
  const r = extractFromPdfText(items, { suppliers: [{ name: 'Frutas Pepe S.L.', tax_id: 'B-12345674' }], fallback: { object: 'fruta semanal' } });
  assert.equal(r.ok, true);
  assert.equal(r.document!.invoice.supplier_name, 'Frutas Pepe S.L.'); assert.equal(r.provenance['invoice.supplier_name']!.confidence, 0.9);
  assert.equal(r.document!.invoice.object, 'fruta semanal');
  assert.equal(r.document!.document_totals.total, 60.5); assert.equal(r.provenance['document_totals.total']!.confidence, 0.4);
  assert.ok(r.warnings.some((w) => /total: se ha calculado/.test(w)));
});

test('PDF escaneado (sin texto) y PDF sin importes: sin resultado, con lo que falta', () => {
  const scanned = extractFromPdfText(page(['1']));
  assert.equal(scanned.hasText, false); assert.equal(scanned.ok, false);
  const noAmounts = extractFromPdfText(page(['Proveedor X SL CIF B12345674', 'Fecha 06/10/2026', 'Gracias por su compra, vuelva pronto a nuestra tienda']));
  assert.equal(noAmounts.hasText, true); assert.equal(noAmounts.ok, false); assert.deepEqual(noAmounts.missing, ['importes']);
});

test('líneas: fragmentos de una misma altura se unen y respetan columnas', () => {
  const lines = linesFromItems([{ str: 'Total', page: 1, x: 40, y: 100, w: 25, h: 10 }, { str: '44,00', page: 1, x: 300, y: 101, w: 25, h: 10 }, { str: 'Base', page: 1, x: 40, y: 120, w: 20, h: 10 }]);
  assert.deepEqual(lines.map((l) => l.text), ['Base', 'Total   44,00']);
});

test('duplicado blando: mismo proveedor, fecha y total', () => {
  const invoices = [{ id: 'a', supplier_id: 's', invoice_date: '2026-10-06', calculated_total: 159, source_total: null, status: 'validada', deleted_at: null }];
  assert.equal(softDuplicate(invoices, { supplier_id: 's', invoice_date: '2026-10-06', total: 159.01 })?.id, 'a');
  assert.equal(softDuplicate(invoices, { supplier_id: 'otro', invoice_date: '2026-10-06', total: 159 }), null);
  assert.equal(softDuplicate(invoices, { supplier_id: 's', invoice_date: '2026-10-06', total: 159 }, 'a'), null);
});
