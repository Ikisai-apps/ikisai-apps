/**
 * Invoices · estado de trabajo de las recibidas (tanda 27, `app/work-state.ts`): recorrido, pago en palabras, etiquetas,
 * buzones, grupos por proveedor y la cola de Inicio. Capa pura, sin espejo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupSummary, homeQueue, inMailbox, invoiceLabels, mailboxFromFilter, payState, supplierGroups, workState, type WorkFacts, type WorkInvoice,
} from '../../apps/invoices/src/app/work-state.ts';

const TODAY = '2026-10-19';
let n = 0;
function inv(fields: Partial<WorkInvoice> = {}): WorkInvoice {
  return {
    id: `i${++n}`, supplier_id: 's1', status: 'validada', review_reason: null, payment_status: 'pendiente', payment_source: null, paid_at: null,
    due_date: null, invoice_date: '2026-10-01', calculated_total: 100, ...fields,
  };
}
const facts = (f: Partial<WorkFacts> = {}): WorkFacts => ({ hasOriginal: true, missing: [], inExport: false, late: null, ...f });

test('payState: pagada, sin confirmar, vencida, vence y sin pagar; la fecha nunca es la de hoy si no la hay', () => {
  assert.equal(payState(inv({ payment_status: 'pagada', payment_source: 'confirmado', paid_at: '2026-10-05' }), TODAY).text, 'Pagada el 5 oct');
  assert.equal(payState(inv({ payment_status: 'pagada', payment_source: 'leido' }), TODAY).confirmed, true);
  const unconfirmed = payState(inv({ payment_status: 'pagada', payment_source: 'sin_confirmar', paid_at: '2026-10-01' }), TODAY);
  assert.deepEqual([unconfirmed.kind, unconfirmed.text, unconfirmed.confirmed, unconfirmed.tone], ['unconfirmed', 'Pago sin confirmar', false, 'warn']);
  assert.equal(payState(inv({ due_date: '2026-10-06' }), TODAY).text, 'Vencida hace 13 días');
  assert.equal(payState(inv({ due_date: '2026-10-18' }), TODAY).text, 'Vencida hace 1 día');
  assert.equal(payState(inv({ due_date: TODAY }), TODAY).text, 'Vence hoy');
  assert.deepEqual([payState(inv({ due_date: '2026-10-24' }), TODAY).text, payState(inv({ due_date: '2026-10-24' }), TODAY).tone], ['Vence el 24 oct', 'warn']);
  assert.equal(payState(inv({ due_date: '2026-12-01' }), TODAY).tone, null);
  assert.equal(payState(inv(), TODAY).text, 'Sin pagar');
  assert.equal(payState(inv({ status: 'anulada' }), TODAY).kind, 'none');
});

test('recorrido: «Pagada» solo con el pago confirmado; sin confirmar lleva «!» y la frase lo dice; anulada, parada', () => {
  const llega = workState(inv({ status: 'pendiente_datos' }), facts(), TODAY);
  assert.deepEqual([llega.stage, llega.caption], ['llega', 'Llega · sin datos: léela o rellénala']);
  const ready = workState(inv({ status: 'pendiente_revision', payment_status: 'pagada', payment_source: 'sin_confirmar' }), facts(), TODAY);
  assert.deepEqual([ready.stage, ready.ready, ready.caption, ready.bad], ['por_resolver', true, 'Por resolver · lista para confirmar · pago sin confirmar', ['pagada']]);
  const missing = workState(inv({ status: 'pendiente_revision' }), facts({ missing: ['la categoría'] }), TODAY);
  assert.deepEqual([missing.caption, missing.ready, missing.bad], ['Por resolver · falta la categoría', false, ['por_resolver']]);
  const amounts = workState(inv({ status: 'pendiente_revision', review_reason: 'REVISAR IMPORTES' }), facts(), TODAY);
  assert.deepEqual([amounts.caption, amounts.tone], ['Por resolver · revisa los importes', 'alert']);
  const unconfirmed = workState(inv({ payment_status: 'pagada', payment_source: 'sin_confirmar' }), facts(), TODAY);
  assert.deepEqual([unconfirmed.stage, unconfirmed.caption, unconfirmed.bad], ['validada', 'Validada · pago sin confirmar', ['pagada']]);
  const paid = workState(inv({ payment_status: 'pagada', payment_source: 'confirmado', paid_at: '2026-10-03' }), facts(), TODAY);
  assert.deepEqual([paid.stage, paid.caption, paid.bad], ['pagada', 'Pagada', []]);
  const overdue = workState(inv({ due_date: '2026-10-06' }), facts(), TODAY);
  assert.deepEqual([overdue.stage, overdue.caption, overdue.tone], ['validada', 'Validada · vencida hace 13 días', 'alert']);
  assert.equal(workState(inv({ payment_status: 'pagada', payment_source: 'confirmado' }), facts({ inExport: true }), TODAY).stage, 'gestoria');
  // Archivada sin entrega: no se fuerza a «En gestoría»
  assert.equal(workState(inv({ status: 'archivada', payment_status: 'pagada', payment_source: 'confirmado' }), facts(), TODAY).stage, 'pagada');
  const annulled = workState(inv({ status: 'anulada' }), facts(), TODAY);
  assert.equal(annulled.stage, null);
  assert.equal(workState(inv(), facts({ hasOriginal: false }), TODAY).caption, 'Validada · sin pagar · sin documento');
});

test('etiquetas: todas las de hoy, la más grave primero (la lista enseña dos y «+n»)', () => {
  const labels = invoiceLabels(inv({ payment_status: 'pagada', payment_source: 'sin_confirmar', invoice_kind: 'rectificativa' }), facts({ hasOriginal: false, late: '3T' }), TODAY);
  assert.deepEqual(labels.map((l) => l.text), ['Sin documento', 'Pagada (sin confirmar)', 'Rectificativa sin enlazar', 'Atrasada (3T)']);
  assert.deepEqual(invoiceLabels(inv({ status: 'archivada', payment_status: 'pagada', payment_source: 'confirmado', delivered_elsewhere: true }), facts(), TODAY).map((l) => l.text),
    ['Ya pasada a la gestoría', 'Archivada', 'Pagada']);
  assert.deepEqual(invoiceLabels(inv({ status: 'pendiente_revision', review_reason: 'REVISAR IMPORTES', due_date: '2026-10-01' }), facts(), TODAY).map((l) => l.text),
    ['Revisar importes', 'Vencida hace 18 días']);
  assert.deepEqual(invoiceLabels(inv({ status: 'anulada' }), facts({ hasOriginal: false }), TODAY).map((l) => l.text), ['Anulada']);
});

test('buzones: «Por resolver» con «Sin datos» y «Por revisar»; los ?filtro= de siempre llevan a su buzón', () => {
  const datos = inv({ status: 'pendiente_datos' }); const revisar = inv({ status: 'pendiente_revision' }); const valid = inv(); const annul = inv({ status: 'anulada' });
  assert.deepEqual([datos, revisar, valid].map((i) => inMailbox('por_resolver', i, true)), [true, true, false]);
  assert.deepEqual([datos, revisar].map((i) => inMailbox('por_resolver', i, true, 'sin_datos')), [true, false]);
  assert.deepEqual([datos, revisar].map((i) => inMailbox('por_resolver', i, true, 'por_revisar')), [false, true]);
  assert.equal(inMailbox('todas', annul, true), false);
  assert.equal(inMailbox('anulada', annul, true), true);
  assert.equal(inMailbox('sin_documento', valid, false), true);
  assert.equal(inMailbox('sin_pagar', inv({ payment_status: 'pagada', payment_source: 'sin_confirmar' }), true), false);
  assert.deepEqual(mailboxFromFilter('pendiente_datos'), { box: 'por_resolver', pill: 'sin_datos' });
  assert.deepEqual(mailboxFromFilter('pendiente_revision'), { box: 'por_resolver', pill: 'por_revisar' });
  assert.deepEqual(mailboxFromFilter('sin_pagar'), { box: 'sin_pagar', pill: null });
  assert.deepEqual(mailboxFromFilter('drive'), { box: 'drive', pill: null });
  assert.equal(mailboxFromFilter('otro'), null);
});

test('grupos por proveedor: primero lo que pide algo, dentro por fecha; resumen escrito', () => {
  const names: Record<string, string> = { a: 'Alfa', b: 'Beta', c: 'Gamma' };
  const row = (i: WorkInvoice) => ({ invoice: i, state: workState(i, facts(), TODAY) });
  const rows = [
    row(inv({ supplier_id: 'a', payment_status: 'pagada', payment_source: 'confirmado', invoice_date: '2026-09-01' })),
    row(inv({ supplier_id: 'b', status: 'pendiente_revision', invoice_date: '2026-10-02' })),
    row(inv({ supplier_id: 'c', due_date: '2026-10-01', calculated_total: 899.37, invoice_date: '2026-09-15' })),
    row(inv({ supplier_id: 'c', payment_status: 'pagada', payment_source: 'confirmado', invoice_date: '2026-10-10' })),
  ];
  const groups = supplierGroups(rows, (id) => names[id]!);
  assert.deepEqual(groups.map((g) => g.supplierId), ['c', 'b', 'a']);
  assert.deepEqual(groups[0]!.rows.map((r) => r.invoice.invoice_date), ['2026-10-10', '2026-09-15']);
  const money = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;
  assert.equal(groupSummary(groups[0]!, money), '1 vencida · Sin pagar 899,37 €');
  assert.equal(groupSummary(groups[1]!, money), '1 por resolver · Sin pagar 100,00 €');
  assert.equal(groupSummary(groups[2]!, money), 'Al día');
  assert.equal(groups[0]!.tone, 'alert');
  assert.equal(groups[2]!.tone, 'ok');
});

test('cola de Inicio: primero las listas para confirmar, las más antiguas antes; nada validado', () => {
  const row = (i: WorkInvoice, f: Partial<WorkFacts> = {}) => ({ invoice: i, state: workState(i, facts(f), TODAY) });
  const a = row(inv({ status: 'pendiente_datos', invoice_date: '2026-09-01' }));
  const b = row(inv({ status: 'pendiente_revision', invoice_date: '2026-10-05' }), { missing: ['la categoría'] });
  const c = row(inv({ status: 'pendiente_revision', invoice_date: '2026-10-07' }));
  const d = row(inv({ status: 'pendiente_revision', invoice_date: '2026-10-03' }));
  const e = row(inv());
  assert.deepEqual(homeQueue([a, b, c, d, e]).map((r) => r.invoice.id), [d, c, b, a].map((r) => r.invoice.id));
});

test('Inicio (tanda 30): la acción cambia según el caso y «He leído esto» marca cada cosa con ✓ o !', async () => {
  const { homeAction, readChecks } = await import('../../apps/invoices/src/app/work-state.ts');
  const money = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;
  const row = (invoice: Record<string, unknown>, facts: Record<string, unknown>, state: Record<string, unknown> = { ready: false }) =>
    ({ invoice: { id: 'x', supplier_id: 's', status: 'pendiente_revision', review_reason: null, payment_status: 'pendiente', paid_at: null, due_date: null, invoice_date: '2026-10-01', calculated_total: 121, ...invoice },
      facts: { hasOriginal: true, missing: [], missingKeys: [], inExport: false, late: null, ...facts }, state }) as never;
  assert.deepEqual(homeAction(row({}, {}, { ready: true })), { kind: 'confirm', label: 'Confirmar y siguiente', focus: null });
  assert.equal(homeAction(row({ status: 'pendiente_datos' }, {})).label, 'Leer el documento');
  assert.deepEqual(homeAction(row({ status: 'pendiente_datos' }, { hasOriginal: false })), { kind: 'open', label: 'Subir el documento', focus: 'original_file' });
  assert.deepEqual(homeAction(row({ review_reason: 'REVISAR IMPORTES' }, {})), { kind: 'open', label: 'Revisar los importes', focus: 'totals' });
  assert.deepEqual(homeAction(row({}, { missingKeys: ['expense_category'] })), { kind: 'open', label: 'Elegir la categoría', focus: 'expense_category' });
  const checks = readChecks(row({ review_reason: 'REVISAR IMPORTES' }, { missingKeys: ['expense_category'] }), true, money);
  assert.deepEqual(checks.map((c) => [c.key, c.ok, c.text]), [['proveedor', true, 'identificado'], ['fecha', true, '1 oct'], ['importes', false, 'no cuadran'], ['categoria', false, 'falta'], ['documento', true, 'original']]);
  assert.deepEqual(readChecks(row({}, {}), false, money).filter((c) => !c.ok).map((c) => c.key), ['proveedor']);
  // Sin leer (llega) no hay «He leído esto»
  assert.deepEqual(readChecks(row({ status: 'pendiente_datos' }, {}), true, money), []);
});
