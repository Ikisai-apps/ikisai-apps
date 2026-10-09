/**
 * Artículos aprendidos (9-10-2026): al validar una factura con sus artículos, la plantilla aprende la tabla y la siguiente
 * factura del proveedor sale desglosada; los totales no se tocan y, si la tabla no cuadra con la base, se avisa.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyItemTable, extractWithTemplates, learnFromConfirmation, learnItemTable, learnItemsFromConfirmation, linesFromItems, ITEMS_KEY,
  type ConfirmedItem, type ItemTableRule, type PdfTextItem, type TemplateLike,
} from '../../packages/domain-invoices/src/index.ts';

/** Una línea con sus celdas en `[texto, x]` (el ancho, 5 puntos por carácter). */
const row = (y: number, cells: Array<[string, number]>, page = 1): PdfTextItem[] => cells.map(([str, x]) => ({ str, page, x, y, w: str.length * 5, h: 10 }));
const money = (v: number) => v.toFixed(2).replace('.', ',');

/** Factura de Makro con tabla: cabecera, artículos `[descripción, cantidad, precio, importe]` y totales al 10 %. */
function invoice(number: string, articles: Array<[string, number, number, number]>, opts: { base?: number; extraVat?: boolean; continuation?: string } = {}): PdfTextItem[] {
  const base = opts.base ?? Math.round(articles.reduce((n, a) => n + a[3], 0) * 100) / 100;
  const vat = Math.round(base * 10) / 100;
  let y = 640;
  const items: PdfTextItem[] = [
    ...row(800, [['MAKRO AUTOSERVICIO MAYORISTA S.A.', 40], ['CIF: A28647451', 380]]),
    ...row(770, [[`Factura nº: ${number}`, 40], ['Fecha factura: 06/10/2026', 380]]),
    ...row(700, [['Cliente: Yoga Retiros S.L.', 40]]),
    ...row(660, [['Descripción', 40], ['Cantidad', 300], ['Precio', 380], ['Importe', 470]]),
  ];
  for (const [i, [d, q, p, imp]] of articles.entries()) {
    items.push(...row(y, [[d, 40], [String(q), 310], [money(p), 385], [money(imp), 475]]));
    y -= 14;
    if (i === 0 && opts.continuation) { items.push(...row(y, [[opts.continuation, 40]])); y -= 14; }
  }
  items.push(...row(y - 20, [['Base imponible', 40], [money(base), 475]]));
  items.push(...row(y - 34, [['IVA 10%', 40], [money(base), 385], [money(vat), 475]]));
  if (opts.extraVat) items.push(...row(y - 48, [['IVA 21%', 40], ['0,00', 385], ['0,00', 475]]));
  items.push(...row(y - 62, [['TOTAL FACTURA', 40], [money(base + vat), 475]]));
  return items;
}
const FIRST: Array<[string, number, number, number]> = [['Tomate pera 1kg', 2, 3.5, 7], ['Aceite de oliva 1l', 1, 12, 12], ['Harina de trigo', 4, 0.75, 3]];
const confirmed = (arts: Array<[string, number, number, number]>): ConfirmedItem[] => arts.map(([description, quantity, unit_price, net_amount]) => ({ description, quantity, unit_price, net_amount }));

test('aprende la tabla de artículos (cabecera y columnas) a partir de los artículos confirmados', () => {
  const rule = learnItemTable(linesFromItems(invoice('MK-1', FIRST)), confirmed(FIRST))!;
  assert.ok(rule, 'tabla aprendida');
  assert.deepEqual(rule.header.sort(), ['cantidad', 'descripcion', 'importe', 'precio']);
  assert.ok(rule.columns.quantity && rule.columns.unit_price, 'con columnas de cantidad y precio');
  // Con menos de dos artículos, o si no están en el documento, no aprende
  assert.equal(learnItemTable(linesFromItems(invoice('MK-1', FIRST)), confirmed(FIRST).slice(0, 1)), null);
  assert.equal(learnItemTable(linesFromItems(invoice('MK-1', FIRST)), [{ description: 'Otra cosa', quantity: null, unit_price: null, net_amount: 99 }, { description: 'Y otra', quantity: null, unit_price: null, net_amount: 98 }]), null);
});

test('lee las filas de otra factura con la misma tabla (otros artículos, una descripción en dos líneas) hasta los totales', () => {
  const rule = learnItemTable(linesFromItems(invoice('MK-1', FIRST)), confirmed(FIRST))!;
  const next: Array<[string, number, number, number]> = [['Queso manchego', 1, 18.4, 18.4], ['Leche entera 6x1l', 3, 5.1, 15.3]];
  const read = applyItemTable(linesFromItems(invoice('MK-2', next, { continuation: 'curado 3 meses' })), rule);
  assert.deepEqual(read.map((r) => [r.description, r.quantity, r.unit_price, r.net_amount]), [['Queso manchego curado 3 meses', 1, 18.4, 18.4], ['Leche entera 6x1l', 3, 5.1, 15.3]]);
});

test('al validar, la plantilla guarda la tabla; la siguiente factura sale desglosada con procedencia de plantilla, sin tocar los totales', async () => {
  const suppliers = [{ id: 'makro', name: 'Makro', tax_id: 'A28647451' }];
  const learning = (await learnFromConfirmation({ lines: linesFromItems(invoice('MK-1', FIRST)), supplierId: 'makro', invoiceId: 'inv-1', templates: [],
    confirmed: { invoice_number: 'MK-1', invoice_date: '2026-10-06', base: 22, total: 24.2, vat: { 10: 2.2 } }, items: confirmed(FIRST) }))!;
  assert.ok(learning.learned.includes('items'));
  const template: TemplateLike = { ...learning.template, id: 'tpl-1', status: 'activa', confirmations: 2 } as TemplateLike;
  assert.equal((template.fields as Record<string, unknown>)[ITEMS_KEY] !== undefined, true);
  const next: Array<[string, number, number, number]> = [['Queso manchego', 1, 18.4, 18.4], ['Leche entera 6x1l', 3, 5.1, 15.3], ['Huevos docena', 2, 2.65, 5.3]];
  const r = extractWithTemplates(invoice('MK-2', next), { suppliers, templates: [template] });
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.deepEqual(r.document!.lines.map((l) => [l.description, l.quantity, l.unit_price, l.net_amount, l.vat_rate]), [
    ['Queso manchego', 1, 18.4, 18.4, 10], ['Leche entera 6x1l', 3, 5.1, 15.3, 10], ['Huevos docena', 2, 2.65, 5.3, 10]]);
  assert.equal(r.document!.document_totals.base, 39);
  assert.equal(r.provenance.lines!.method, 'supplier_template');

  // Si la tabla no cuadra con la base: líneas por tipo de IVA y aviso; los totales, los del documento
  const off = extractWithTemplates(invoice('MK-3', next, { base: 40 }), { suppliers, templates: [template] });
  assert.equal(off.document!.lines.length, 1);
  assert.equal(off.document!.document_totals.base, 40);
  assert.ok(off.warnings.some((w) => /suman 39,00 € y la base es 40,00 €/.test(w)), JSON.stringify(off.warnings));
});

test('aciertos y fallos de la tabla: una factura rara no la cambia; tres fallos seguidos la retiran y se aprende otra', () => {
  const lines = linesFromItems(invoice('MK-1', FIRST));
  let rule: ItemTableRule = learnItemTable(lines, confirmed(FIRST))!;
  let r = learnItemsFromConfirmation(lines, confirmed(FIRST), rule);
  assert.deepEqual([r.outcome, r.rule!.hits], ['hit', 2]);
  // Confirmados distintos de lo que lee la tabla (otra factura del documento): fallo, la tabla se queda
  const odd = confirmed([['Tomate pera 1kg', 2, 3.5, 7], ['Aceite de oliva 1l', 1, 12, 12]]);
  rule = r.rule!;
  for (let i = 1; i <= 3; i++) { r = learnItemsFromConfirmation(lines, odd, rule); rule = r.rule!; }
  assert.equal(r.outcome, 'miss');
  assert.equal(rule.retired, true);
  assert.equal(learnItemsFromConfirmation(lines, confirmed(FIRST), rule).outcome, 'learned');
  // Un documento sin la tabla no cuenta como fallo
  const plain = linesFromItems(row(800, [['Sin tabla', 40]]));
  assert.equal(learnItemsFromConfirmation(plain, confirmed(FIRST), learnItemTable(lines, confirmed(FIRST))).outcome, 'none');
});
