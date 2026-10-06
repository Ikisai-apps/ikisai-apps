/** Booking · ampliación V2, bloque 3 (API.md §15.2): tarifario, condiciones, propuestas versionadas y su paso a los importes. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { bookingAgentRisk, lineAmount, PROCEDURES, proposalTotals, refundFor, round2, suggestLines, TABLES, validateFields } from '../../supabase/functions/_domain/booking/mod.ts';

const { reservations: RESERVATIONS, rates: RATES, conditions: CONDITIONS, cancellationTiers: TIERS, proposals: PROPOSALS, proposalLines: LINES, finance: FINANCE } = TABLES;
const uuid = () => crypto.randomUUID();

let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

function commands(operations: unknown[], token: string = app.tokens.owner) {
  return app.call('/api/v1/commands', { token, body: { requestId: `rt-${++seq}-${uuid()}`, operations } });
}
async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await commands(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res;
}
const row = async (table: string, id: string) => (await app.t.db.query<Record<string, any>>(`select * from ${table} where id = $1`, [id])).rows[0]!;
const revision = async (table: string, id: string) => Number((await row(table, id)).revision);
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

async function createReservation(guests = 20): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: RESERVATIONS, id, fields: { title: 'Retiro tarifas', event_type: 'retiro', status: 'negociacion', start_date: '2027-05-10', end_date: '2027-05-12', expected_guests: guests, uses_accommodation: true } }]);
  return id;
}
async function createConditions(fields: Record<string, unknown> = {}): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: CONDITIONS, id, fields: { name: `Condiciones ${seq}`, deposit_percent: 30, deposit_minimum: 300, ...fields } },
    { op: 'insert', table: TIERS, id: uuid(), fields: { conditions_id: id, min_days_before: 60, deposit_refund_pct: 100 } },
    { op: 'insert', table: TIERS, id: uuid(), fields: { conditions_id: id, min_days_before: 30, deposit_refund_pct: 50, extra_costs: true } }]);
  return id;
}

test('tarifas · dominio: sugerencia, totales con y sin IVA, señal mínima y devolución por tramos', () => {
  const rate = (id: string, f: Record<string, unknown>) => ({ id, name: id, layer: 'por_persona', unit: 'persona_noche', amount: 40, service: null,
    min_persons: null, max_persons: null, event_types: null, valid_from: null, valid_to: null, active: true, ...f });
  const reservation = { event_type: 'retiro', start_date: '2027-05-10', end_date: '2027-05-12', expected_guests: 20, uses_accommodation: true, requires_meals: false };
  const rates = [
    rate('recinto', { layer: 'recinto', unit: 'dia', amount: 500 }),
    rate('pequeño', { max_persons: 15 }), rate('grande', { min_persons: 16 }),
    rate('comidas', { layer: 'servicio', unit: 'persona_dia', service: 'comidas' }),
    rate('formacion', { event_types: ['formacion'] }), rate('2026', { valid_to: '2026-12-31' }), rate('inactiva', { active: false }),
    rate('descuento', { layer: 'ajuste', unit: 'porcentaje', amount: -10 }),
  ];
  assert.deepEqual(suggestLines(reservation, rates).map((l) => [l.rate_id, l.quantity]), [['recinto', 3], ['grande', 40], ['descuento', 1]]);

  // extras: no se sugieren, salvo la supletoria cuando hay supletorias activadas (por cama y noche)
  const extras = [...rates, rate('sonido', { layer: 'extra', unit: 'estancia', amount: 150 }),
    rate('supletoria', { layer: 'extra', unit: 'noche', amount: 15, service: 'cama_supletoria' })];
  assert.deepEqual(suggestLines(reservation, extras).map((l) => l.rate_id), ['recinto', 'grande', 'descuento']);
  assert.deepEqual(suggestLines(reservation, extras, { extraBeds: 3 }).map((l) => [l.rate_id, l.quantity]), [['recinto', 3], ['grande', 40], ['supletoria', 6], ['descuento', 1]]);
  assert.deepEqual(suggestLines(reservation, extras, { persons: 10 }).map((l) => l.rate_id), ['recinto', 'pequeño', 'descuento']);
  // descuento en % de una línea o importe cambiado a mano
  assert.equal(lineAmount({ unit: 'persona_noche', quantity: 40, unit_amount: 40, discount_pct: 15 }), 1360);
  assert.equal(lineAmount({ unit: 'porcentaje', quantity: 1, unit_amount: -10, discount_pct: 15 }), null);

  const lines = [{ unit: 'dia', quantity: 3, unit_amount: 500 }, { unit: 'persona_noche', quantity: 40, unit_amount: 40 }, { unit: 'porcentaje', quantity: 1, unit_amount: -10 }];
  assert.deepEqual(proposalTotals(lines, { deposit_percent: 30, deposit_minimum: 300, prices_include_vat: true, vat_rate: 10 }),
    { subtotal: 3100, adjustments: -310, vat_amount: 253.64, total: 2790, deposit_amount: 837 });
  assert.deepEqual(proposalTotals(lines, { deposit_percent: 30, deposit_minimum: 300, prices_include_vat: false, vat_rate: 10 }),
    { subtotal: 3100, adjustments: -310, vat_amount: 279, total: 3069, deposit_amount: 920.7 });
  assert.equal(proposalTotals([{ unit: 'unidad', quantity: 1, unit_amount: 500 }], { deposit_percent: 30, deposit_minimum: 300, prices_include_vat: true, vat_rate: 10 }).deposit_amount, 300);
  assert.equal(proposalTotals([{ unit: 'unidad', quantity: 1, unit_amount: 200 }], { deposit_percent: 30, deposit_minimum: 300, prices_include_vat: true, vat_rate: 10 }).deposit_amount, 200, 'la señal no pasa del total');
  assert.equal(round2(1.005), 1.01); assert.equal(round2(-1.005), -1.01);

  const tiers = [{ min_days_before: 60, deposit_refund_pct: 100, extra_costs: false }, { min_days_before: 30, deposit_refund_pct: 50, extra_costs: true }];
  assert.deepEqual(refundFor(837, '2027-05-10', '2027-03-01', tiers), { daysBefore: 70, percent: 100, amount: 837, extraCosts: false });
  assert.deepEqual(refundFor(837, '2027-05-10', '2027-04-01', tiers), { daysBefore: 39, percent: 50, amount: 418.5, extraCosts: true });
  assert.equal(refundFor(837, '2027-05-10', '2027-05-01', tiers)!.amount, 0);

  const field = (table: string, f: Record<string, unknown>) => validateFields(table, f, 'update').map((i) => i.details.field);
  assert.deepEqual(field(RATES, { unit: 'porcentaje', amount: -150 }), ['amount']);
  assert.deepEqual(field(RATES, { unit: 'dia', amount: -5 }), ['amount']);
  assert.deepEqual(field(RATES, { event_types: ['retiro', 'nada'] }), ['event_types']);
  assert.deepEqual(field(PROPOSALS, { status: 'aceptada' }), ['status']);
  assert.deepEqual(field(PROPOSALS, { status: 'rechazada' }), []);
  assert.deepEqual(bookingAgentRisk([call(PROCEDURES.sendProposal, {})]).reasons, ['booking:proposal']);
});

test('tarifas · ciclo: borrador → enviada (inmutable) → nueva versión → aceptada escribe los importes', async () => {
  const conditionsId = await createConditions();
  const rateId = uuid();
  await ok([{ op: 'insert', table: RATES, id: rateId, fields: { name: 'Grupo con pernocta', layer: 'por_persona', unit: 'persona_noche', amount: 40, service: 'alojamiento', event_types: ['retiro', 'convivencia'] } }]);
  assert.match((await row(RATES, rateId)).code, /^TAR_/);
  assert.equal((await commands([{ op: 'insert', table: RATES, id: uuid(), fields: { name: 'X', layer: 'recinto', unit: 'dia', amount: 1 } }], app.tokens.editor)).status, 403, 'solo el owner toca el tarifario');
  await ok([{ op: 'update', table: CONDITIONS, id: conditionsId, expectedRevision: await revision(CONDITIONS, conditionsId), fields: { is_default: true } }]);

  const reservationId = await createReservation();
  const v1 = uuid();
  const created = await ok([call(PROCEDURES.newProposalVersion, { reservation_id: reservationId, proposal_id: v1 })], app.tokens.editor);
  assert.equal(created.status, 200);
  assert.deepEqual(await row(PROPOSALS, v1).then((p) => [p.version, p.status, p.conditions_id, p.persons]), [1, 'borrador', conditionsId, 20]);
  await ok([
    { op: 'insert', table: LINES, id: uuid(), fields: { proposal_id: v1, rate_id: rateId, description: 'Grupo con pernocta', unit: 'persona_noche', quantity: 40, unit_amount: 40, position: 1 } },
    { op: 'insert', table: LINES, id: uuid(), fields: { proposal_id: v1, description: 'Sala grande', unit: 'dia', quantity: 3, unit_amount: 500, position: 2 } },
    { op: 'insert', table: LINES, id: uuid(), fields: { proposal_id: v1, description: 'Descuento grupo', unit: 'porcentaje', quantity: 1, unit_amount: -10, position: 3 } },
  ], app.tokens.editor);

  // Un cliente no puede saltarse el envío ni fijar los totales.
  assert.equal((await commands([{ op: 'update', table: PROPOSALS, id: v1, expectedRevision: await revision(PROPOSALS, v1), fields: { status: 'enviada' } }])).status, 422);

  await ok([call(PROCEDURES.sendProposal, { proposal_id: v1, expectedRevision: await revision(PROPOSALS, v1) })], app.tokens.editor);
  const p1 = await row(PROPOSALS, v1);
  assert.equal(p1.status, 'enviada'); assert.ok(p1.sent_at);
  assert.deepEqual([p1.subtotal, p1.adjustments, p1.vat_amount, p1.total, p1.deposit_amount].map(Number), [3100, -310, 253.64, 2790, 837], 'SQL y dominio coinciden');

  // Enviada: líneas y cabecera bloqueadas; las condiciones usadas ya no cambian.
  const lineId = (await app.t.db.query<{ id: string }>(`select id from booking.proposal_lines where proposal_id = $1 order by position limit 1`, [v1])).rows[0]!.id;
  const lineEdit = await commands([{ op: 'update', table: LINES, id: lineId, expectedRevision: await revision(LINES, lineId), fields: { unit_amount: 1 } }]);
  assert.equal(lineEdit.data.error.code, 'PROPOSAL_LOCKED');
  assert.equal((await commands([{ op: 'update', table: PROPOSALS, id: v1, expectedRevision: await revision(PROPOSALS, v1), fields: { persons: 30 } }])).data.error.code, 'PROPOSAL_LOCKED');
  assert.equal((await commands([{ op: 'update', table: CONDITIONS, id: conditionsId, expectedRevision: await revision(CONDITIONS, conditionsId), fields: { deposit_percent: 50 } }])).data.error.code, 'CONDITIONS_IN_USE');
  assert.equal((await commands([{ op: 'insert', table: TIERS, id: uuid(), fields: { conditions_id: conditionsId, min_days_before: 0, deposit_refund_pct: 0 } }])).data.error.code, 'CONDITIONS_IN_USE');
  assert.equal((await commands([{ op: 'delete', table: PROPOSALS, id: v1, expectedRevision: await revision(PROPOSALS, v1) }])).status, 422);
  await ok([{ op: 'update', table: PROPOSALS, id: v1, expectedRevision: await revision(PROPOSALS, v1), fields: { notes: 'Llamar el lunes' } }]);

  // Nueva versión: copia cabecera y líneas en un borrador; al enviarla, la anterior queda sustituida.
  const v2 = uuid();
  await ok([call(PROCEDURES.newProposalVersion, { reservation_id: reservationId, proposal_id: v2, from_proposal_id: v1 })], app.tokens.editor);
  const p2 = await row(PROPOSALS, v2);
  assert.deepEqual([p2.version, p2.status, p2.notes], [2, 'borrador', 'Llamar el lunes']);
  assert.equal((await app.t.db.query(`select 1 from booking.proposal_lines where proposal_id = $1 and deleted_at is null`, [v2])).rows.length, 3);
  const pct = (await app.t.db.query<{ id: string }>(`select id from booking.proposal_lines where proposal_id = $1 and unit = 'porcentaje'`, [v2])).rows[0]!.id;
  await ok([{ op: 'delete', table: LINES, id: pct, expectedRevision: await revision(LINES, pct) }], app.tokens.editor);
  await ok([call(PROCEDURES.sendProposal, { proposal_id: v2, expectedRevision: await revision(PROPOSALS, v2) })], app.tokens.editor);
  assert.equal((await row(PROPOSALS, v1)).status, 'sustituida');
  assert.equal(Number((await row(PROPOSALS, v2)).total), 3100);

  // Aceptar: único punto que toca los importes; reader no puede.
  assert.equal((await commands([call(PROCEDURES.acceptProposal, { proposal_id: v2 })], app.tokens.reader)).status, 403);
  assert.equal((await commands([call(PROCEDURES.acceptProposal, { proposal_id: v1 })], app.tokens.editor)).data.error.code, 'INVALID_TRANSITION');
  await ok([call(PROCEDURES.acceptProposal, { proposal_id: v2, expectedRevision: await revision(PROPOSALS, v2) })], app.tokens.editor);
  const fin = await row(FINANCE, reservationId);
  assert.deepEqual([fin.budget_amount, fin.final_amount, fin.deposit_required].map(Number), [3100, 3100, 930]);
  assert.equal((await row(PROPOSALS, v2)).status, 'aceptada');
  const history = await app.t.db.query(`select 1 from core.changes where table_name = 'reservation_finance' and row_id = $1`, [reservationId]).catch(() => null);
  if (history) assert.ok(history.rows.length >= 1, 'el cambio de importes queda en el historial');
});

test('tarifas · enviar exige condiciones y líneas; un borrador se edita y se borra; rechazar a mano', async () => {
  const reservationId = await createReservation(8);
  const draft = uuid();
  await ok([{ op: 'insert', table: PROPOSALS, id: draft, fields: { reservation_id: reservationId } }], app.tokens.editor);
  const empty = await commands([call(PROCEDURES.sendProposal, { proposal_id: draft })], app.tokens.editor);
  assert.equal(empty.data.error.code, 'PROPOSAL_INCOMPLETE');
  const conditionsId = await createConditions({ deposit_minimum: 0, prices_include_vat: false, vat_rate: 21 });
  await ok([{ op: 'update', table: PROPOSALS, id: draft, expectedRevision: await revision(PROPOSALS, draft), fields: { conditions_id: conditionsId, nature: 'cerrada', persons: 8 } },
    { op: 'insert', table: LINES, id: uuid(), fields: { proposal_id: draft, description: 'Jornada', unit: 'persona_dia', quantity: 8, unit_amount: 25.5 } },
    { op: 'insert', table: LINES, id: uuid(), fields: { proposal_id: draft, description: 'Equipo de sonido', unit: 'estancia', quantity: 1, unit_amount: 120, discount_pct: 50 } }], app.tokens.editor);
  await ok([call(PROCEDURES.sendProposal, { proposal_id: draft })], app.tokens.editor);
  const sent = await row(PROPOSALS, draft);
  assert.deepEqual([sent.version, sent.subtotal, sent.vat_amount, sent.total, sent.deposit_amount].map(Number), [1, 264, 55.44, 319.44, 95.83]);
  await ok([{ op: 'update', table: PROPOSALS, id: draft, expectedRevision: await revision(PROPOSALS, draft), fields: { status: 'rechazada', decided_at: '2027-04-01T10:00:00Z' } }], app.tokens.editor);
  assert.equal((await row(PROPOSALS, draft)).status, 'rechazada');

  const other = uuid();
  await ok([{ op: 'insert', table: PROPOSALS, id: other, fields: { reservation_id: reservationId } }], app.tokens.editor);
  assert.equal((await row(PROPOSALS, other)).version, 2);
  await ok([{ op: 'delete', table: PROPOSALS, id: other, expectedRevision: await revision(PROPOSALS, other) }], app.tokens.editor);
  // reader no ve el tarifario ni las propuestas
  const snap = await app.call(`/api/v1/snapshot?tables=${PROPOSALS},${RATES}`, { token: app.tokens.reader });
  assert.ok(snap.status === 403 || (snap.data.tables ?? []).every((t: any) => (t.rows ?? []).length === 0), JSON.stringify(snap.data).slice(0, 200));
});
