/** Fase 0 de REVISION_LECTOR (9-10-2026): un PDF con texto nunca termina sin información; la lectura parcial no pisa lo humano. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFromPdfText, invoiceContractText, knownFieldsText, keepHumanFields, partialFillOperations, readingMessage, readingSummary, readingText, type PdfTextItem } from '../../packages/domain-invoices/src/index.ts';

function page(lines: string[], pageNo = 1): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  lines.forEach((line, i) => line.split('|').forEach((part, col) => {
    if (part.trim()) items.push({ str: part.trim(), page: pageNo, x: 40 + col * 260, y: 800 - i * 14, w: part.trim().length * 5, h: 10 });
  }));
  return items;
}

test('A · texto sin fecha: conserva proveedor, NIF, número e importes', () => {
  const r = extractFromPdfText(page(['TALLERES SIN FECHA S.L.|CIF: B12345674', 'Factura nº: SF-1', 'Base imponible|100,00', 'IVA 21%|100,00|21,00', 'TOTAL|121,00']));
  assert.equal(r.read, 'partial');
  assert.equal(r.ok, false);
  assert.deepEqual([r.found.supplier_name, r.found.supplier_tax_id, r.found.invoice_number, r.found.base, r.found.total], ['TALLERES SIN FECHA S.L.', 'B12345674', 'SF-1', 100, 121]);
  assert.deepEqual(r.found.vat, [{ rate: 21, base: 100, quota: 21 }]);
  assert.match(readingMessage(r), /encontrado proveedor, número, base, IVA y total, pero no he identificado la fecha\.$/);
});

test('B · texto sin importes: conserva proveedor, fecha y número', () => {
  const r = extractFromPdfText(page(['ASESORES SIN IMPORTES S.L.|CIF: B12345674', 'Factura nº: SI-2', 'Fecha factura: 05/10/2026', 'Servicios de asesoría del mes de septiembre']));
  assert.equal(r.read, 'partial');
  assert.deepEqual([r.found.supplier_tax_id, r.found.invoice_number, r.found.invoice_date, r.found.base, r.found.total], ['B12345674', 'SI-2', '2026-10-05', null, null]);
  assert.match(readingMessage(r), /no he identificado la base, el IVA y el total\.$/);
});

test('C · texto incomprensible: «texto leído, sin datos», nunca «sin texto»', () => {
  const r = extractFromPdfText(page(['Lorem ipsum dolor sit amet consectetur adipiscing elit', 'sed do eiusmod tempor incididunt ut labore et dolore']));
  assert.equal(r.hasText, true);
  assert.equal(r.read, 'partial');
  const msg = readingMessage(r);
  assert.match(msg, /^He leído el texto del PDF \(1 pág\., \d+ caracteres\), pero no he identificado ningún dato/);
  assert.doesNotMatch(msg, /no contiene texto/);
});

test('D · escaneado: «no contiene texto legible»', () => {
  const r = extractFromPdfText([]);
  assert.equal(r.read, 'no_text');
  assert.match(readingMessage(r), /^Este PDF no contiene texto legible/);
});

test('texto leído legible, por líneas y con marca de página si hay varias', () => {
  const text = readingText([...page(['Primera|línea'], 1), ...page(['Segunda'], 2)]);
  assert.match(text, /^— Página 1 —\nPrimera\s+línea\n\n— Página 2 —\nSegunda$/);
});

test('relleno parcial: solo lo vacío; el proveedor provisional se sustituye por NIF; el resumen guarda lo rellenado', () => {
  const r = extractFromPdfText(page(['NUEVO PROVEEDOR S.L.|CIF: B12345674', 'Factura nº: NP-9', 'TOTAL|50,00']));
  const reading = readingSummary(r, 2, '2026-10-09T10:00:00Z');
  let n = 0;
  const fill = partialFillOperations({
    invoice: { id: 'inv', supplier_id: 'placeholder', invoice_number: 'MANO-1', invoice_date: null, source_total: null, revision: 3, import_meta: { origin: 'x' } },
    placeholderSupplierId: 'placeholder', suppliers: [], hasContent: false, found: r.found, reading, newId: () => `id${++n}`,
  });
  assert.deepEqual(fill.filled, { supplier_id: { value: 'id1', level: 'regla' }, source_total: { value: 50, level: 'regla' } });
  const update = fill.ops.find((o) => o.op === 'update') as any;
  assert.equal(update.expectedRevision, 3);
  assert.equal(update.fields.invoice_number, undefined, 'el número escrito a mano no se toca');
  assert.equal(update.fields.import_meta.origin, 'x');
  assert.equal(update.fields.import_meta.reading.read, 'partial');
  assert.ok(fill.ops.some((o) => o.op === 'insert' && o.table === 'invoices.suppliers'));
  assert.equal(fill.ops.some((o) => o.table === 'invoices.invoice_lines'), false, 'sin base, no se inventan importes');
});

test('lo humano manda: una lectura completa no pisa el número ni la fecha escritos a mano', () => {
  const r = extractFromPdfText(page(['TALLERES S.L.|CIF: B12345674', 'Factura nº: LEIDO-1', 'Fecha factura: 05/10/2026', 'Base imponible|100,00', 'IVA 21%|100,00|21,00', 'TOTAL|121,00']));
  assert.equal(r.read, 'sufficient');
  const kept = keepHumanFields(r.document!, { invoice_number: 'MANO-1', invoice_date: '2026-10-01', import_meta: { reading: { filled: { invoice_date: '2026-10-01' } } } });
  assert.equal(kept.invoice.invoice_number, 'MANO-1');
  assert.equal(kept.invoice.invoice_date, '2026-10-05', 'la fecha la puso la lectura automática: se mejora');
});

test('precedencia por nivel (fase 1): una plantilla mejora lo que rellenó una regla; nada pisa lo que cambió una persona', () => {
  const r = extractFromPdfText(page(['TALLER S.L.|CIF: B12345674', 'Factura nº: TPL-2', 'TOTAL|50,00']));
  const base = { placeholderSupplierId: null, suppliers: [], hasContent: true, found: r.found, reading: readingSummary(r, 4, '2026-10-09T10:00:00Z'), newId: () => 'x' };
  const tpl = { 'invoice.invoice_number': { method: 'supplier_template' as const, text: null, page: 1, x: 0, y: 0, confidence: 0.9 } };
  const meta = (filled: Record<string, unknown>) => ({ reading: { filled } });
  const fieldsOf = (fill: ReturnType<typeof partialFillOperations>) => (fill.ops.find((o) => o.op === 'update') as any).fields;
  // Lo rellenó una regla y nadie lo tocó: la plantilla lo mejora
  let fill = partialFillOperations({ ...base, provenance: tpl, invoice: { id: 'i', supplier_id: 's', invoice_number: 'TPL-1', invoice_date: null, source_total: null, import_meta: meta({ invoice_number: { value: 'TPL-1', level: 'regla' } }) } });
  assert.equal(fieldsOf(fill).invoice_number, 'TPL-2');
  assert.deepEqual(fill.filled.invoice_number, { value: 'TPL-2', level: 'plantilla' });
  // Una persona lo cambió (ya no coincide con lo rellenado): manda
  fill = partialFillOperations({ ...base, provenance: tpl, invoice: { id: 'i', supplier_id: 's', invoice_number: 'MANO-1', invoice_date: null, source_total: null, import_meta: meta({ invoice_number: { value: 'TPL-1', level: 'regla' } }) } });
  assert.equal(fieldsOf(fill).invoice_number, undefined);
  // Mismo nivel o menor: no se cambia
  fill = partialFillOperations({ ...base, invoice: { id: 'i', supplier_id: 's', invoice_number: 'TPL-1', invoice_date: null, source_total: null, import_meta: meta({ invoice_number: { value: 'TPL-1', level: 'plantilla' } }) } });
  assert.equal(fieldsOf(fill).invoice_number, undefined);
  // Formato de la fase 0 (sin nivel): cuenta como inferencia y una regla lo mejora
  fill = partialFillOperations({ ...base, invoice: { id: 'i', supplier_id: 's', invoice_number: 'TPL-1', invoice_date: null, source_total: null, import_meta: meta({ invoice_number: 'TPL-1' }) } });
  assert.equal(fieldsOf(fill).invoice_number, 'TPL-2');
  // Mismo proveedor y número que otra factura viva: duplicado, el número no se escribe
  fill = partialFillOperations({ ...base, invoice: { id: 'i', supplier_id: 's', invoice_number: null, invoice_date: null, source_total: null }, invoices: [{ id: 'otra', code: 'FVR_2026_001', supplier_id: 's', invoice_number: 'tpl-2', status: 'validada', deleted_at: null }] });
  assert.equal(fieldsOf(fill).invoice_number, undefined);
  assert.deepEqual(fill.duplicateOf, { id: 'otra', code: 'FVR_2026_001' });
});

test('fase 3: lo ya leído va a la IA con las instrucciones, y lo que falta', () => {
  const r = extractFromPdfText(page(['TALLERES IA S.L.|CIF: B12345674', 'Factura nº: IA-7', 'TOTAL|121,00']));
  const known = knownFieldsText(r.found, ['la fecha', 'el IVA'])!;
  assert.match(known, /^DATOS YA LEÍDOS POR FINANCE/);
  assert.match(known, /- Proveedor: TALLERES IA S\.L\., NIF B12345674/);
  assert.match(known, /- Número de factura: IA-7/);
  assert.match(known, /- Total: 121/);
  assert.match(known, /Falta: la fecha, el IVA\./);
  const contract = invoiceContractText({ filename: 'f.pdf', sha256: 'a'.repeat(64) }, known);
  assert.ok(contract.indexOf('DATOS YA LEÍDOS') < contract.indexOf('Sobre de intercambio'), 'antes del sobre');
  assert.equal(knownFieldsText({ supplier_name: null, supplier_tax_id: null, invoice_number: null, invoice_date: null, base: null, vat: [], withholding: null, total: null }, []), null);
});

