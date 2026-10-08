/** Booking · marcadores del «Texto de las condiciones»: resolución, bloque vacío, tramos ordenados y sin tramos (TS y SQL). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, PROCEDURES, renderConditionsText, cancellationLines } from '../../supabase/functions/_domain/booking/mod.ts';

const CONDITIONS = { deposit_percent: 30, deposit_minimum: 0, deposit_days: 7, deposit_days_short: 1, short_notice_days: 15, vat_rate: 10, minimum_total: 2500, balance_deadline_hours_after_end: 24 };
const TIERS = [
  { min_days_before: 45, deposit_refund_pct: 50, extra_costs: false },
  { min_days_before: 0, deposit_refund_pct: 0, extra_costs: true },
  { min_days_before: 90, deposit_refund_pct: 100, extra_costs: false },
];
const TEXT = 'Señal del {{condiciones.senal_porcentaje}} en {{condiciones.senal_plazo}} ({{condiciones.senal_plazo_corto}} con menos de {{condiciones.poca_antelacion}}).'
  + '{{#condiciones.senal_minima}} Mínimo {{condiciones.senal_minima}}.{{/condiciones.senal_minima}} IVA {{condiciones.iva}}. Mínimo por retiro {{condiciones.minimo}}.\n'
  + 'Cancelación:\n{{condiciones.cancelacion}}\n{{condiciones.saldo_plazo}}';
const EXPECTED = 'Señal del 30 % en 7 días (1 día con menos de 15 días). IVA 10 %. Mínimo por retiro 2.500 €.\nCancelación:\n'
  + 'Con 90 días o más de antelación: se devuelve el 100 % de la señal.\n'
  + 'Con 45 días o más de antelación: se devuelve el 50 % de la señal.\n'
  + 'Con menos de 45 días: no se devuelve la señal y se cobran costes extra.\n{{condiciones.saldo_plazo}}';

test('marcadores · resolución, bloque vacío fuera, tramos de mayor a menor y desconocidos tal cual', () => {
  const out = renderConditionsText(TEXT, CONDITIONS, TIERS);
  assert.equal(out.text, EXPECTED);
  assert.deepEqual(out.unknown, ['condiciones.saldo_plazo'], 'el plazo interno del saldo no tiene marcador');
  // con mínimo de señal, el bloque se queda y pierde sus marcas
  assert.equal(renderConditionsText('A{{#condiciones.senal_minima}} mínimo {{condiciones.senal_minima}}{{/condiciones.senal_minima}}.', { ...CONDITIONS, deposit_minimum: 1234.5 }, []).text, 'A mínimo 1.234,50 €.');
  // sin tramos: la lista queda vacía y su bloque desaparece
  assert.deepEqual(cancellationLines([]), []);
  assert.equal(renderConditionsText('X{{#condiciones.cancelacion}} Tramos: {{condiciones.cancelacion}}{{/condiciones.cancelacion}}.', CONDITIONS, []).text, 'X.');
  assert.equal(cancellationLines([{ min_days_before: 0, deposit_refund_pct: 20 }])[0], 'En cualquier momento: se devuelve el 20 % de la señal.');
  assert.equal(renderConditionsText('{{condiciones.iva}}', { vat_rate: 12.5 }, [], 'en').text, '12.5%');
  assert.equal(renderConditionsText(null, CONDITIONS, TIERS).text, '');
});

let app: TestApp;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('marcadores · el portal recibe el texto ya resuelto, igual que la app', async () => {
  const uuid = () => crypto.randomUUID();
  const cond = uuid(); const res = uuid(); const proposal = uuid();
  const ok = async (operations: unknown[]) => {
    const r = await app.call('/api/v1/commands', { body: { requestId: `ct-${uuid()}`, operations } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  await ok([
    { op: 'insert', table: TABLES.conditions, id: cond, fields: { name: 'Con marcadores', is_default: true, ...CONDITIONS, text: TEXT } },
    ...TIERS.map((t, i) => ({ op: 'insert', table: TABLES.cancellationTiers, id: uuid(), fields: { conditions_id: cond, ...t, position: i } })),
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro marcadores', status: 'pre_reservada', start_date: '2028-10-01', end_date: '2028-10-03', expected_guests: 10 } },
  ]);
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: proposal } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, description: 'Estancia', unit: 'unidad', quantity: 1, unit_amount: 3000, position: 1 } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: proposal } }]);
  const org = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [org, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  const out = await app.t.rpc('core_read', { p_app: 'organizers', p_actor: org, p_name: 'booking.portal_proposals', p_args: { reservation_id: res } }) as any;
  assert.equal(out.items[0].conditions.text, EXPECTED);
});
