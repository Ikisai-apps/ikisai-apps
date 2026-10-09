/** Fase 3: plantillas por proveedor aprendidas de confirmaciones (huella, aprender, aplicar, versiones, anomalías). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTemplate, chooseTemplate, extractFromPdfText, extractWithTemplates, jaccard, layoutTokens, learnFromConfirmation, linesFromItems, patternFor,
  templateOperation, type ConfirmedValues, type PdfTextItem, type TemplateLike,
} from '../../packages/domain-invoices/src/index.ts';

const SUPPLIER = '11111111-1111-4111-8111-111111111111';
const INVOICE = '22222222-2222-4222-8222-222222222222';

function page(lines: string[]): PdfTextItem[] {
  const items: PdfTextItem[] = [];
  lines.forEach((line, i) => line.split('|').forEach((part, col) => {
    if (part.trim()) items.push({ str: part.trim(), page: 1, x: 40 + col * 260, y: 800 - i * 14, w: part.trim().length * 5, h: 10 });
  }));
  return items;
}

/** Formato del proveedor: el número va tras «Doc. ref.», que las reglas genéricas no reconocen. */
function pepe(n: string, date: string, base: string, quota: string, total: string): PdfTextItem[] {
  return page([
    'FRUTAS PEPE S.L.', 'CIF: B12345674', 'Albarán y factura de mercancía', `Doc. ref.: ${n}`, `Emitido el | ${date}`,
    'Concepto | Importe', 'Fruta y verdura variada | ' + base, `Base imponible | ${base}`, `IVA 10% | ${quota}`, `Importe total | ${total}`, 'Gracias por su confianza',
  ]);
}

const first = pepe('X-77', '06/10/2026', '100,00', '10,00', '110,00');
const confirmed1: ConfirmedValues = { invoice_number: 'X-77', invoice_date: '2026-10-06', supplier_tax_id: 'B12345674', base: 100, total: 110, vat: { '10': 10 } };

async function asTemplate(promise: ReturnType<typeof learnFromConfirmation>, id: string): Promise<TemplateLike> {
  const learning = await promise;
  assert.ok(learning);
  return { ...learning.template, id: learning.template.id ?? id, revision: 1, deleted_at: null } as TemplateLike;
}

test('huella: palabras sin cifras de la cabecera y similitud de Jaccard', () => {
  const tokens = layoutTokens(linesFromItems(first));
  assert.ok(tokens.includes('albaran') && tokens.includes('emitido') && !tokens.some((t) => /\d/.test(t)));
  assert.equal(jaccard(['a', 'b', 'c'], ['a', 'b', 'd']), 0.5);
  assert.equal(patternFor('X-77'), '^X-\\d{2}$');
  assert.equal(patternFor('A-2026/0457'), '^A-\\d{4}\\/\\d{4}$');
});

test('aprender de la primera confirmación: reglas por etiqueta; lo ambiguo no se aprende', async () => {
  const learning = await learnFromConfirmation({ lines: linesFromItems(first), confirmed: confirmed1, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [] });
  assert.ok(learning); assert.equal(learning.isNew, true);
  const t = learning.template;
  assert.equal(t.version, 1); assert.equal(t.status, 'aprendiendo'); assert.equal(t.confirmations, 1);
  assert.deepEqual(t.fields.invoice_number!.anchor.text, 'doc. ref.'); assert.equal(t.fields.invoice_number!.relation, 'same_line_right');
  assert.equal(t.fields.invoice_date!.anchor.text, 'emitido el');
  assert.equal(t.fields.total!.anchor.text, 'importe total');
  assert.equal(t.fields['vat:10']!.anchor.text, 'iva 10%');
  // La base (100,00) aparece en la línea del concepto y en «Base imponible»: se desempata por la etiqueta esperable.
  assert.equal(t.fields.base!.anchor.text, 'base imponible');
  const op = templateOperation(learning, null, INVOICE, 'tpl-1');
  assert.equal(op.op, 'insert'); assert.equal(op.fields.last_confirmed_invoice_id, INVOICE); assert.equal(op.fields.supplier_id, SUPPLIER);
});

test('usar la plantilla: lee el número que las reglas genéricas no leen; confianza baja mientras aprende y alta cuando está activa', async () => {
  const t1 = await asTemplate(learnFromConfirmation({ lines: linesFromItems(first), confirmed: confirmed1, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [] }), 'tpl-1');
  const second = pepe('X-78', '07/10/2026', '50,00', '5,00', '55,00');
  assert.equal(extractFromPdfText(second).document?.invoice.invoice_number ?? null, null, 'el genérico no ve «Doc. ref.»');
  const r = extractWithTemplates(second, { suppliers: [{ id: SUPPLIER, name: 'Frutas Pepe S.L.', tax_id: 'B12345674' }], templates: [t1] });
  assert.equal(r.ok, true); assert.equal(r.template?.version, 1);
  assert.equal(r.document!.invoice.invoice_number, 'X-78'); assert.equal(r.document!.invoice.invoice_date, '2026-10-07');
  assert.deepEqual(r.document!.document_totals, { base: 50, vat: 5, withholding: 0, total: 55 });
  assert.equal(r.provenance['invoice.invoice_number']!.method, 'supplier_template');
  assert.ok(r.provenance['invoice.invoice_number']!.confidence <= 0.5);
  // Segunda confirmación: todo acierta y pasa a activa; la confianza sube
  const learning2 = await learnFromConfirmation({ lines: r.lines, confirmed: { invoice_number: 'X-78', invoice_date: '2026-10-07', supplier_tax_id: 'B12345674', base: 50, total: 55, vat: { '10': 5 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t1] });
  assert.ok(learning2); assert.equal(learning2.isNew, false); assert.deepEqual(learning2.misses, []);
  assert.equal(learning2.template.status, 'activa'); assert.equal(learning2.template.confirmations, 2); assert.equal(learning2.template.full_hits, 1);
  const op = templateOperation(learning2, { revision: 3 }, INVOICE, 'nuevo');
  assert.equal(op.op, 'update'); assert.equal((op as { expectedRevision: number }).expectedRevision, 3);
  const t2: TemplateLike = { ...t1, ...learning2.template, id: t1.id } as TemplateLike;
  const third = extractWithTemplates(pepe('X-79', '08/10/2026', '20,00', '2,00', '22,00'), { suppliers: [{ id: SUPPLIER, name: 'Frutas Pepe S.L.', tax_id: 'B12345674' }], templates: [t2] });
  assert.ok(third.provenance['invoice.invoice_number']!.confidence > 0.5);
});

test('una factura anómala no cambia la etiqueta; tres fallos seguidos retiran la regla; otro formato crea otra versión', async () => {
  let t = await asTemplate(learnFromConfirmation({ lines: linesFromItems(first), confirmed: confirmed1, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [] }), 'tpl-1');
  // Un valor que no está en el documento (p. ej. una fecha que el usuario eligió conservar) no cuenta como fallo.
  const kept = await learnFromConfirmation({ lines: linesFromItems(pepe('X-79', '09/10/2026', '10,00', '1,00', '11,00')), confirmed: { invoice_number: 'X-79', invoice_date: '2026-10-01', base: 10, total: 11, vat: { '10': 1 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t] });
  assert.ok(kept); assert.ok(!kept.misses.includes('invoice_date')); assert.equal(kept.template.fields.invoice_date!.misses, 0);
  // El usuario corrige el número: el bueno (Y-90) está en otra línea del documento → fallo, y su etiqueta queda como variante
  for (let i = 0; i < 3; i++) {
    const lines = linesFromItems([...pepe('X-80', '09/10/2026', '10,00', '1,00', '11,00'), { str: 'Pedido: Y-90', page: 1, x: 40, y: 500, w: 60, h: 10 }]);
    const l = await learnFromConfirmation({ lines, confirmed: { invoice_number: 'Y-90', invoice_date: '2026-10-09', base: 10, total: 11, vat: { '10': 1 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t] });
    assert.ok(l); assert.ok(l.misses.includes('invoice_number'));
    assert.equal(l.template.fields.invoice_number!.anchor.text, 'doc. ref.');
    assert.deepEqual(l.template.fields.invoice_number!.anchor.variants, ['pedido']);
    t = { ...t, ...l.template, id: t.id } as TemplateLike;
  }
  assert.equal(t.fields.invoice_number!.retired, true);
  assert.equal(applyTemplate(linesFromItems(first), t).values.invoice_number, undefined);
  // Mismo proveedor, otro formato (otras palabras): versión nueva, la anterior se conserva
  const other = page(['FRUTAS PEPE SL - NUEVO DISEÑO', 'NIF B12345674', 'Número de factura: 2026-0001', 'Fecha 10/10/2026', 'Subtotal 30,00', 'IVA 10% 3,00', 'TOTAL 33,00', 'Pague por transferencia bancaria']);
  assert.equal(chooseTemplate([t], SUPPLIER, layoutTokens(linesFromItems(other))), null);
  const v2 = await learnFromConfirmation({ lines: linesFromItems(other), confirmed: { invoice_number: '2026-0001', invoice_date: '2026-10-10', base: 30, total: 33, vat: { '10': 3 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t] });
  assert.ok(v2); assert.equal(v2.isNew, true); assert.equal(v2.template.version, 2);
});

test('proveedor sin plantilla o desconocido: solo reglas genéricas', () => {
  const r = extractWithTemplates(pepe('X-1', '06/10/2026', '100,00', '10,00', '110,00'), { suppliers: [{ id: SUPPLIER, name: 'Frutas Pepe S.L.', tax_id: 'B12345674' }], templates: [] });
  assert.equal(r.template, null); assert.equal(r.supplierId, SUPPLIER);
  assert.equal(r.provenance['document_totals.total']!.method, 'pdf_text');
});

test('fase 2: una regla que falla mucho, aunque no sea seguido, se retira (más del 40 % de fallos tras 5 usos)', async () => {
  let t = await asTemplate(learnFromConfirmation({ lines: linesFromItems(first), confirmed: confirmed1, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [] }), 'tpl-r');
  const hit = () => learnFromConfirmation({ lines: linesFromItems(pepe('X-81', '09/10/2026', '10,00', '1,00', '11,00')), confirmed: { invoice_number: 'X-81', invoice_date: '2026-10-09', base: 10, total: 11, vat: { '10': 1 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t] });
  const miss = () => learnFromConfirmation({ lines: linesFromItems([...pepe('X-82', '09/10/2026', '10,00', '1,00', '11,00'), { str: 'Pedido: Z-12', page: 1, x: 40, y: 500, w: 60, h: 10 }]), confirmed: { invoice_number: 'Z-12', invoice_date: '2026-10-09', base: 10, total: 11, vat: { '10': 1 } }, supplierId: SUPPLIER, invoiceId: INVOICE, templates: [t] });
  // acierto, fallo, acierto, fallo, fallo (nunca tres seguidos): 3 fallos de 6 usos → retirada
  for (const step of [miss, hit, miss, hit, miss]) {
    const l = (await step())!;
    t = { ...t, ...l.template, id: t.id } as TemplateLike;
  }
  const rule = t.fields.invoice_number!;
  assert.deepEqual([rule.hits, rule.misses, rule.streak_misses < 3], [3, 3, true]);
  assert.equal(rule.retired, true);
  // Las demás reglas, que aciertan, siguen
  assert.notEqual(t.fields.base?.retired, true);
});

