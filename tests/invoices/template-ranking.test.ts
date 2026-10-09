/**
 * Fase 2 del lector: plantillas sin depender del NIF. Si el NIF del documento no es de un proveedor conocido, se elige la
 * plantilla de cualquier proveedor por evidencia determinista (huella, etiquetas, nombre), con umbral y margen; el
 * proveedor que sale así va como «revísalo».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWithTemplates, learnFromConfirmation, linesFromItems, rankTemplates, type PdfTextItem, type TemplateLike } from '../../packages/domain-invoices/src/index.ts';

const row = (y: number, cells: Array<[string, number]>): PdfTextItem[] => cells.map(([str, x]) => ({ str, page: 1, x, y, w: str.length * 5, h: 10 }));

/** Factura con el diseño de un proveedor: nombre en cabecera, NIF opcional, etiquetas propias y totales. */
function doc(name: string, taxLine: string | null, number: string, labels: { number: string; date: string; base: string; total: string }, base = 100): PdfTextItem[] {
  return [
    ...row(800, [[name, 40], ...(taxLine ? [[taxLine, 380] as [string, number]] : [])]),
    ...row(780, [['Calle del Puerto 12, Valencia', 40]]),
    ...row(750, [[labels.number, 40], [number, 200]]),
    ...row(736, [[labels.date, 40], ['06/10/2026', 200]]),
    ...row(700, [['Servicio de transporte de mercancía', 40], ['100,00', 470]]),
    ...row(660, [[labels.base, 40], [base.toFixed(2).replace('.', ','), 470]]),
    ...row(646, [['IVA 21%', 40], [base.toFixed(2).replace('.', ','), 380], [(base * 0.21).toFixed(2).replace('.', ','), 470]]),
    ...row(620, [[labels.total, 40], [(base * 1.21).toFixed(2).replace('.', ','), 470]]),
  ];
}
const TRANSPORTES = { number: 'Núm. documento', date: 'Emitida el', base: 'Neto gravable', total: 'Importe a liquidar' };

async function templateFor(supplierId: string, items: PdfTextItem[], confirmed: Record<string, unknown>): Promise<TemplateLike> {
  const learning = (await learnFromConfirmation({ lines: linesFromItems(items), supplierId, invoiceId: 'v', templates: [], confirmed: confirmed as never }))!;
  return { ...learning.template, id: `tpl-${supplierId}`, status: 'activa', confirmations: 3, created_at: '2026-10-01' } as unknown as TemplateLike;
}

test('sin NIF conocido, la plantilla del proveedor con el mismo formato se elige por huella, etiquetas y nombre; el proveedor va como «revísalo»', async () => {
  const suppliers = [{ id: 'trans', name: 'Transportes Levante S.L.', tax_id: 'B12345674' }, { id: 'otro', name: 'Papelería Centro S.L.', tax_id: 'B87654321' }];
  const tpl = await templateFor('trans', doc('TRANSPORTES LEVANTE S.L.', 'CIF: B12345674', 'TL-0001', TRANSPORTES), { invoice_number: 'TL-0001', invoice_date: '2026-10-06', base: 100, total: 121, vat: { 21: 21 } });
  // La siguiente llega sin el NIF (o con uno que no casa): antes no se probaba ninguna plantilla
  const next = doc('TRANSPORTES LEVANTE S.L.', null, 'TL-0002', TRANSPORTES, 200);
  const ranked = rankTemplates([tpl], linesFromItems(next), suppliers);
  assert.ok(ranked[0]!.score >= 0.7, JSON.stringify(ranked.map((r) => r.score)));
  const r = extractWithTemplates(next, { suppliers, templates: [tpl] });
  assert.equal(r.supplierId, 'trans');
  assert.equal(r.template?.id, 'tpl-trans');
  assert.equal(r.found.invoice_number, 'TL-0002', 'la plantilla lee su etiqueta propia');
  assert.equal(r.found.base, 200);
  assert.match(String(r.found.supplier_name), /transportes levante/i);
  assert.ok(r.provenance['invoice.supplier_name']!.confidence < 0.8, 'revísalo');
  assert.ok(r.warnings.some((w) => /por el formato de sus facturas \(Transportes Levante S\.L\.\)/.test(w)));
  // Ni NIF ni nombre: el formato solo no basta (prudente); queda para leerla a mano o con la IA
  const nameless = extractWithTemplates(doc('', null, 'TL-0003', TRANSPORTES).filter((i) => i.str), { suppliers, templates: [tpl] });
  assert.equal(nameless.template, null);
});

test('sin claridad no se elige: dos plantillas parecidas, o un documento de otro formato', async () => {
  const suppliers = [{ id: 'a', name: 'Alfa Servicios S.L.', tax_id: 'B12345674' }, { id: 'b', name: 'Beta Servicios S.L.', tax_id: 'A87654323' }];
  const a = await templateFor('a', doc('ALFA SERVICIOS S.L.', 'CIF: B12345674', 'A-1', TRANSPORTES), { invoice_number: 'A-1', invoice_date: '2026-10-06', base: 100, total: 121 });
  const b = await templateFor('b', doc('BETA SERVICIOS S.L.', 'CIF: A87654323', 'B-1', TRANSPORTES), { invoice_number: 'B-1', invoice_date: '2026-10-06', base: 100, total: 121 });
  // Mismo formato y sin nombre de ninguno: empate, no se elige
  const anonymous = doc('SERVICIOS VARIOS', null, 'X-9', TRANSPORTES);
  assert.equal(extractWithTemplates(anonymous, { suppliers, templates: [a, b] }).template, null);
  // Otro formato del todo: tampoco
  const other = doc('CAFETERÍA LA ESQUINA', null, '77', { number: 'Ticket', date: 'Día', base: 'Base', total: 'Total' });
  assert.equal(extractWithTemplates(other, { suppliers, templates: [a, b] }).template, null);
  // Con el NIF de un proveedor conocido, manda el NIF (como siempre)
  const withTax = doc('ALFA SERVICIOS S.L.', 'CIF: B12345674', 'A-2', TRANSPORTES);
  assert.equal(extractWithTemplates(withTax, { suppliers, templates: [a, b] }).template?.id, 'tpl-a');
});
