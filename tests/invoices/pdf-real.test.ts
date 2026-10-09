/**
 * Lectura sin IA de facturas de texto con el formato típico de proveedor español (9-10-2026: las dos primeras facturas
 * reales por Drive salieron sin leer). PDF sintéticos con datos inventados, leídos con el mismo PDF.js que la Edge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPdfItemsServer } from '../../supabase/functions/invoices-api/drive.ts';
import { extractWithTemplates } from '../../packages/domain-invoices/src/index.ts';
import { textPdf } from './pdf-fixture.ts';

async function read(lines: Array<[string, number, number]>, suppliers: Array<{ id: string; name: string; tax_id: string }> = []) {
  const items = await readPdfItemsServer(new Uint8Array(textPdf(lines)));
  return extractWithTemplates(items, { suppliers });
}

test('pie en tabla (cabecera y cifras debajo), NIF del cliente antes que el del proveedor, CIF con puntos y «Número:» suelto', async () => {
  const r = await read([
    ['SUMINISTROS EJEMPLO, S.L.', 40, 800], ['FACTURA', 380, 800],
    ['Polígono Inventado, nave 3', 40, 786], ['Número: 2026/FV-00812', 380, 786],
    ['46000 Valencia', 40, 772], ['Fecha factura: 14/07/2026', 380, 772],
    ['Cliente: EMPRESA DE PRUEBA S.L.  NIF B87654321', 40, 740],
    ['C.I.F.: B-12.345.674', 40, 758],
    ['Tornillería variada', 40, 700], ['125,00', 480, 700],
    ['Cable eléctrico', 40, 686], ['80,75', 480, 686],
    ['Base imponible', 40, 640], ['% IVA', 200, 640], ['Cuota IVA', 300, 640], ['Total factura', 420, 640],
    ['205,75', 40, 626], ['21,00', 200, 626], ['43,21', 300, 626], ['248,96 €', 420, 626],
    ['Vencimiento: 14/08/2026', 40, 600],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const d = r.document!;
  assert.equal(d.invoice.supplier_tax_id, 'B12345674', 'el del proveedor, no el del cliente');
  assert.equal(d.invoice.supplier_name, 'SUMINISTROS EJEMPLO, S.L.');
  assert.equal(d.invoice.invoice_number, '2026/FV-00812');
  assert.equal(d.invoice.invoice_date, '2026-07-14');
  assert.deepEqual([d.document_totals.base, d.document_totals.vat, d.document_totals.total], [205.75, 43.21, 248.96]);
  assert.deepEqual(d.taxes.map((t) => [t.rate, t.taxable_base, t.amount]), [[21, 205.75, 43.21]]);
});

test('varias etiquetas en una línea («Base: … · IVA 10 %: … · TOTAL: …») y fecha antes que el vencimiento', async () => {
  const r = await read([
    ['Frutas Ejemplo S.L. · CIF B12345674 · Calle Inventada 12', 40, 800],
    ['Factura nº A-2026/0457 · Fecha: 05/10/2026 · Vencimiento: 05/11/2026', 40, 786],
    ['Base imponible: 1.234,56 € · IVA 10 %: 123,46 € · TOTAL: 1.358,02 €', 40, 700],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const d = r.document!;
  assert.equal(d.invoice.supplier_name, 'Frutas Ejemplo S.L.');
  assert.equal(d.invoice.invoice_date, '2026-10-05');
  assert.deepEqual([d.document_totals.base, d.document_totals.vat, d.document_totals.total], [1234.56, 123.46, 1358.02]);
  assert.equal(r.warnings.length, 0, r.warnings.join(' | '));
});

test('pie en tabla con dos tipos de IVA (una fila por tipo) y retención', async () => {
  const r = await read([
    ['Asesores Ejemplo, S.L.P.', 40, 800], ['NIF: B12345674', 300, 800],
    ['Factura nº: AS-77', 40, 786], ['Fecha: 30/09/2026', 300, 786],
    ['Base imponible', 40, 640], ['Tipo IVA', 160, 640], ['Cuota IVA', 260, 640], ['Retención IRPF', 360, 640], ['Total', 470, 640],
    ['100,00', 40, 626], ['21 %', 160, 626], ['21,00', 260, 626],
    ['50,00', 40, 612], ['10 %', 160, 612], ['5,00', 260, 612], ['15,00', 360, 612], ['161,00', 470, 612],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const d = r.document!;
  assert.deepEqual(d.taxes.filter((t) => t.tax_type === 'iva').map((t) => [t.rate, t.amount]).sort(), [[10, 5], [21, 21]]);
  assert.equal(d.document_totals.withholding, 15);
  assert.equal(d.document_totals.total, 161);
  assert.equal(d.document_totals.vat, 26);
});

test('ticket de cadena de tiendas: NIF del cliente arriba, totales en una celda («Total SI · Total IVA · Total TII»), fila de pago y CIF en el pie legal', async () => {
  const r = await read([
    ['FACTURA 123-0001-000001', 300, 800],
    ['Tienda Ejemplo Ciudad', 40, 786], ['Autonomo', 300, 786],
    ['Número NIF:', 40, 760], ['11111111H', 160, 760],
    ['Fecha de venta:', 40, 746], ['07/07/2026', 160, 746],
    ['Modos de pago', 40, 600], ['Tasa IVA/IGIC/IPSI', 200, 600], ['Total SI (EUR) Total IVA/IGIC/IPSI Total TII (EUR)', 300, 600],
    ['TARJ.BANC. (EUR)', 40, 586], ['121,00', 150, 586], ['ANTICIPO 21.00%', 220, 586], ['100,00', 330, 586], ['21,00', 410, 586], ['121,00', 490, 586],
    ['EUR', 40, 572], ['100,00', 330, 572], ['21,00', 410, 572], ['121,00', 490, 572],
    ['Pendiente de pago 0,00', 40, 556],
    ['Comercio Ejemplo España S.L.U. Avenida Inventada 2, 28000 Madrid N.I.F.B-12.345.674. Inscrita en el', 40, 520],
    ['Registro Mercantil de Madrid. Tomo 1, Folio 1', 40, 506],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const d = r.document!;
  assert.equal(d.invoice.supplier_tax_id, 'B12345674', 'el CIF de la empresa, no el NIF del cliente');
  assert.equal(d.invoice.supplier_name, 'Comercio Ejemplo España S.L.U.');
  assert.equal(d.invoice.invoice_number, '123-0001-000001');
  assert.equal(d.invoice.invoice_date, '2026-07-07');
  assert.deepEqual([d.document_totals.base, d.document_totals.vat, d.document_totals.total], [100, 21, 121]);
});

test('factura de transporte: tabla de líneas con fechas (se suman las filas), «Precio sin IVA» y «Precio Incl. IVA», CIF de la empresa en el pie', async () => {
  const r = await read([
    ['Número de factura', 40, 800], ['V_00000000000001', 160, 800], ['Razón social', 300, 800], ['Persona Ejemplo', 400, 800],
    ['Localizador de reserva', 40, 786], ['ABC123', 160, 786], ['CIF', 300, 786], ['11111111H', 400, 786],
    ['Fecha y hora de reserva', 40, 772], ['2026-05-20 22:41', 160, 772],
    ['Base imponible', 160, 700], ['Descuento', 240, 700], ['% IVA', 310, 700], ['IVA', 370, 700], ['Precio Incl. IVA', 430, 700],
    ['Inicial', 40, 686], ['28-05-2026', 90, 686], ['50,00', 160, 686], ['0.00', 240, 686], ['10,00', 310, 686], ['5,00', 370, 686], ['55,00', 430, 686],
    ['Inicial', 40, 672], ['31-05-2026', 90, 672], ['60,00', 160, 672], ['0.00', 240, 672], ['10,00', 310, 672], ['6,00', 370, 672], ['66,00', 430, 672],
    ['% IVA', 40, 640], ['11,00', 160, 640],
    ['Precio sin IVA', 40, 626], ['110,00', 160, 626],
    ['Precio Incl. IVA', 40, 612], ['121,00', 160, 612],
    ['Calle Inventada 2. Valencia 46000 / Transportes Ejemplo SA / CIF A12345674', 40, 560],
  ]);
  assert.equal(r.ok, true, JSON.stringify(r.missing));
  const d = r.document!;
  assert.equal(d.invoice.supplier_tax_id, 'A12345674');
  assert.equal(d.invoice.supplier_name, 'Transportes Ejemplo SA');
  assert.equal(d.invoice.invoice_number, 'V_00000000000001');
  assert.deepEqual([d.document_totals.base, d.document_totals.vat, d.document_totals.total], [110, 11, 121]);
  assert.deepEqual(d.taxes.map((t) => [t.rate, t.taxable_base, t.amount]), [[10, 110, 11]]);
});
