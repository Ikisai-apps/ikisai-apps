/**
 * Invoices · estado de trabajo de las emitidas (tanda 27, `app/issued-state.ts`): recorrido con la fecha de envío (0240),
 * antigüedad, buzones y lo que debe cada cliente con la regla de Booking. Capa pura.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientGroups, clientSummary, inIssuedBox, issuedBoxFromFilter, issuedState, type IssuedWork } from '../../apps/invoices/src/app/issued-state.ts';

const TODAY = '2026-10-19';
let n = 0;
const iss = (f: Partial<IssuedWork> = {}): IssuedWork => ({ id: `e${++n}`, status: 'emitida', payment_status: 'pendiente', paid_at: null, sent_at: null, issue_date: '2026-10-10', total: 100, invoice_type: 'F1', recipient_name: 'Yoga en Calma', recipient_tax_id: 'G00000000', ...f });

test('recorrido: emitida sin enviar, enviada por cobrar, antigua, cobrada con su fecha y medio, en gestoría; borrador y anulada paradas', () => {
  const unsent = issuedState(iss(), false, TODAY);
  assert.deepEqual([unsent.stage, unsent.caption, unsent.bad, unsent.unsent], ['emitida', 'Emitida · sin enviar (emitida hace 9 días)', ['enviada'], true]);
  const sent = issuedState(iss({ sent_at: '2026-10-14' }), false, TODAY);
  assert.deepEqual([sent.stage, sent.caption, sent.old], ['por_cobrar', 'Por cobrar · enviada hace 5 días', false]);
  const old = issuedState(iss({ sent_at: '2026-09-01' }), false, TODAY);
  assert.deepEqual([old.caption, old.tone, old.bad], ['Por cobrar · enviada hace 48 días · más de 30 días', 'alert', ['por_cobrar']]);
  // Sin enviar, la antigüedad cuenta desde la emisión
  assert.equal(issuedState(iss({ issue_date: '2026-09-01' }), false, TODAY).old, true);
  const paid = issuedState(iss({ payment_status: 'cobrada', paid_at: '2026-09-06', payment_method: 'transferencia' }), false, TODAY, (m) => (m === 'transferencia' ? 'Transferencia' : m));
  assert.deepEqual([paid.stage, paid.caption, paid.owed], ['cobrada', 'Cobrada el 6 sept · Transferencia', 0]);
  assert.equal(issuedState(iss({ payment_status: 'cobrada', paid_at: '2026-09-06' }), true, TODAY).stage, 'gestoria');
  assert.equal(issuedState(iss({ status: 'borrador' }), false, TODAY).stage, null);
  assert.equal(issuedState(iss({ status: 'anulada' }), false, TODAY).stage, null);
  // Una rectificativa que resta no se cobra
  const rect = issuedState(iss({ invoice_type: 'R1', total: -110 }), false, TODAY);
  assert.deepEqual([rect.owed, rect.unsent], [-110, false]);
});

test('buzones: «Todas» sin anuladas; «Por cobrar» sin borradores, anuladas, cobradas ni rectificativas que restan; el filtro de antes', () => {
  const rows = [iss(), iss({ status: 'borrador' }), iss({ status: 'anulada' }), iss({ payment_status: 'cobrada' }), iss({ total: -10, invoice_type: 'R1' }), iss({ review_reason: 'REVISAR IMPORTES' })];
  const count = (box: Parameters<typeof inIssuedBox>[0]) => rows.filter((r) => inIssuedBox(box, r)).length;
  assert.deepEqual([count('por_cobrar'), count('cobradas'), count('borradores'), count('todas'), count('anulada'), count('revisar')], [2, 1, 1, 5, 1, 1]);
  assert.equal(issuedBoxFromFilter('activas'), 'todas');
  assert.equal(issuedBoxFromFilter('pendientes'), 'por_cobrar');
  assert.equal(issuedBoxFromFilter('otro'), null);
});

test('clientes: primero el que más debe; lo cobrado y los borradores no cuentan; la rectificativa resta (regla de Booking)', () => {
  const row = (i: IssuedWork) => ({ invoice: i, state: issuedState(i, false, TODAY) });
  const groups = clientGroups([
    row(iss({ total: 2304, payment_status: 'cobrada', paid_at: '2026-09-06' })),
    row(iss({ total: 5376, sent_at: '2026-09-10' })),
    row(iss({ status: 'borrador', total: 10 })),
    row(iss({ recipient_name: 'Otro cliente', recipient_tax_id: 'B11111111', total: 100 })),
    row(iss({ recipient_name: 'Otro cliente', recipient_tax_id: 'B11111111', total: -40, invoice_type: 'R1' })),
  ]);
  assert.deepEqual(groups.map((g) => [g.name, g.owed]), [['Yoga en Calma', 5376], ['Otro cliente', 60]]);
  const money = (v: number) => `${v.toFixed(2).replace('.', ',')} €`;
  assert.equal(clientSummary(groups[0]!, money), 'Te debe 5376,00 € · 1 de más de 30 días · 1 borrador');
  assert.equal(clientSummary({ ...groups[1]!, owed: 0, old: 0, drafts: 0 }, money), 'Al día');
});
