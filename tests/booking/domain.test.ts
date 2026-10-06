import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TABLES, PROCEDURES, canHoldStatus, depositStatus, eventPhase, missingForConfirmation, nights, validateFields, validateOperations,
} from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();

test('dominio · noches y fechas', () => {
  assert.equal(nights('2026-10-30', '2026-11-01'), 2);
  assert.equal(nights('2026-10-30', '2026-10-30'), 0);
  assert.equal(nights('2026-10-30', null), null);
  assert.equal(nights('2026-02-30', '2026-03-01'), null, 'fecha imposible');
  assert.equal(nights('2026-11-01', '2026-10-30'), null, 'fin anterior al inicio');
});

test('dominio · estado de la señal (C03 §7), con importes numéricos o de texto', () => {
  assert.equal(depositStatus(null), 'no_aplica');
  assert.equal(depositStatus({ deposit_required: null, deposit_paid: 50 }), 'no_aplica');
  assert.equal(depositStatus({ deposit_required: 0, deposit_paid: null }), 'no_aplica');
  assert.equal(depositStatus({ deposit_required: 300, deposit_paid: null }), 'pendiente');
  assert.equal(depositStatus({ deposit_required: '300.00', deposit_paid: '100.00' }), 'parcial');
  assert.equal(depositStatus({ deposit_required: 300, deposit_paid: 300 }), 'completado');
});

test('dominio · requisitos para pre-reservar o confirmar y fase del evento', () => {
  const draft = { status: 'negociacion', start_date: null, end_date: null, expected_guests: null } as const;
  assert.deepEqual(missingForConfirmation(draft), ['start_date', 'end_date', 'expected_guests']);
  assert.equal(canHoldStatus(draft, 'negociacion'), true);
  assert.equal(canHoldStatus(draft, 'pre_reservada'), false);
  assert.equal(canHoldStatus({ ...draft, start_date: '2026-10-30', end_date: '2026-11-01', expected_guests: 0 }, 'pre_reservada'), true);

  const event = { preparation_status: 'pendiente', closed_at: null };
  assert.equal(eventPhase({ status: 'confirmada' }, event), 'pendiente_preparacion');
  assert.equal(eventPhase({ status: 'confirmada' }, { ...event, preparation_status: 'hecha' }), 'preparado');
  assert.equal(eventPhase({ status: 'en_ejecucion' }, event), 'en_ejecucion');
  assert.equal(eventPhase({ status: 'confirmada' }, { ...event, closed_at: '2026-11-02T10:00:00Z' }), 'cerrado');
  assert.equal(eventPhase({ status: 'cancelada' }, event), 'cancelado');
});

test('dominio · validación de campos de reserva, importes y evento', () => {
  const fields = (f: Record<string, unknown>, mode: 'insert' | 'update' = 'update') => validateFields(TABLES.reservations, f, mode).map((i) => i.details.field);
  assert.deepEqual(fields({ title: 'Retiro', status: 'negociacion', start_date: '2026-10-30', end_date: '2026-11-01', expected_guests: 20, minors_count: 2 }, 'insert'), []);
  assert.deepEqual(fields({}, 'insert'), ['title']);
  assert.deepEqual(fields({ title: '   ' }), ['title']);
  assert.deepEqual(fields({ title: null }), ['title']);
  assert.deepEqual(fields({ status: 'propuesta_enviada' }), ['status']);
  assert.deepEqual(fields({ start_date: '30/10/2026' }), ['start_date']);
  assert.deepEqual(fields({ start_date: '2026-11-02', end_date: '2026-11-01' }), ['end_date']);
  assert.deepEqual(fields({ expected_guests: 10, minors_count: 11 }), ['minors_count']);
  assert.deepEqual(fields({ expected_guests: -1 }), ['expected_guests']);
  assert.deepEqual(fields({ expected_guests: null, contact_email: null, start_date: null }), []);
  assert.deepEqual(fields({ contact_email: 'sin-arroba' }), ['contact_email']);
  assert.deepEqual(fields({ uses_pool: 'si' }), ['uses_pool']);
  assert.deepEqual(fields({ campo_inexistente: 1, revision: 5 }), [], 'lo desconocido lo rechaza el núcleo');

  const finance = (f: Record<string, unknown>) => validateFields(TABLES.finance, f, 'update').map((i) => i.details.field);
  assert.deepEqual(finance({ budget_amount: 1200.5, deposit_required: 300, deposit_paid: null, payment_type: 'transferencia', payment_date: '2026-10-01' }), []);
  assert.deepEqual(finance({ budget_amount: -1 }), ['budget_amount']);
  assert.deepEqual(finance({ budget_amount: 10.005 }), ['budget_amount']);
  assert.deepEqual(finance({ budget_amount: '100' }), ['budget_amount']);
  assert.deepEqual(finance({ payment_type: 'bizum' }), ['payment_type']);

  const event = (f: Record<string, unknown>) => validateFields(TABLES.events, f, 'update').map((i) => i.details.field);
  assert.deepEqual(event({ arrival_time: '17:00', departure_time: '12:00:00', final_guests: 22, cleaning_status: 'hecha', kitchen_status: 'no_aplica' }), []);
  assert.deepEqual(event({ arrival_time: '25:00' }), ['arrival_time']);
  assert.deepEqual(event({ cleaning_status: 'hecho' }), ['cleaning_status']);
  assert.deepEqual(event({ preparation_status: null }), ['preparation_status']);
});

test('dominio · reglas de lote: el evento solo nace al confirmar y solo lo borra un propietario', () => {
  const events = TABLES.events;
  const codes = (ops: Parameters<typeof validateOperations>[0], role: 'editor' | 'owner' = 'editor') => validateOperations(ops, { role }).map((i) => i.code);
  assert.deepEqual(codes([{ op: 'insert', table: events, id: uuid(), fields: { reservation_id: uuid() } }]), ['INVALID_OPERATION']);
  assert.deepEqual(codes([{ op: 'delete', table: events, id: uuid() }]), ['FORBIDDEN']);
  assert.deepEqual(codes([{ op: 'restore', table: events, id: uuid() }]), ['FORBIDDEN']);
  assert.deepEqual(codes([{ op: 'delete', table: events, id: uuid() }], 'owner'), []);
  assert.deepEqual(codes([{ op: 'update', table: events, id: uuid(), fields: { reservation_id: uuid() } }]), ['INVALID_FIELDS']);
  assert.deepEqual(codes([{ op: 'update', table: events, id: uuid(), fields: { final_guests: 22 } }]), []);
  assert.deepEqual(codes([{ op: 'delete', table: TABLES.reservations, id: uuid() }]), []);

  const call = (args: Record<string, unknown>) => validateOperations([{ op: 'call', procedure: PROCEDURES.confirmReservation, args }], { role: 'editor' }).map((i) => i.details.field);
  assert.deepEqual(call({ reservation_id: uuid(), event_id: uuid(), from_status: 'pre_reservada' }), []);
  assert.deepEqual(call({ reservation_id: uuid(), event_id: uuid(), from_status: 'pre_reservada', expectedRevision: 3 }), []);
  assert.deepEqual(call({ reservation_id: 'x', from_status: 'otro', expectedRevision: 0 }), ['reservation_id', 'event_id', 'from_status', 'expectedRevision']);

  const second = validateOperations([
    { op: 'update', table: TABLES.reservations, id: uuid(), fields: { title: 'Bien' } },
    { op: 'update', table: TABLES.reservations, id: uuid(), fields: { priority: 'urgente' } },
  ], { role: 'editor' });
  assert.equal(second.length, 1);
  assert.equal(second[0]!.details.index, 1);
});

test('dominio · agentes: cancelar, archivar, huéspedes e importes exigen aprobación; el resto no', async () => {
  const { bookingAgentRisk } = await import('../../supabase/functions/_domain/booking/mod.ts');
  const id = uuid();
  const res = (fields: Record<string, unknown>) => bookingAgentRisk([{ op: 'update', table: TABLES.reservations, id, fields }]);
  assert.deepEqual(res({ contact_phone: '600000000' }), { required: false, reasons: [] });
  assert.deepEqual(res({ status: 'pre_reservada' }), { required: false, reasons: [] });
  assert.deepEqual(res({ status: 'cancelada' }), { required: true, reasons: ['booking:status:cancelada'] });
  assert.deepEqual(res({ archived_at: '2027-01-01T00:00:00Z' }).reasons, ['booking:archive']);
  assert.deepEqual(res({ archived_at: null }).required, false, 'desarchivar no');
  assert.deepEqual(bookingAgentRisk([{ op: 'insert', table: TABLES.guests, id, fields: { first_name: 'X' } }]).reasons, ['booking:guests:insert']);
  assert.equal(bookingAgentRisk([{ op: 'insert', table: TABLES.finance, id, fields: {} }]).required, false, 'la fila de importes vacía nace con la reserva');
  assert.deepEqual(bookingAgentRisk([{ op: 'update', table: TABLES.finance, id, fields: { deposit_paid: 10 } }]).reasons, ['booking:finance']);
  assert.equal(bookingAgentRisk([{ op: 'update', table: TABLES.checklist, id, fields: { status: 'hecho' } }]).required, false);
});
