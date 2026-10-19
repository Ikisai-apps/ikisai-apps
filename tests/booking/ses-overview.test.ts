/** Booking · tanda 27, B2 (MUELA-067 §4, MUELA-038): estado de SES de varias reservas en una lectura (`GET ses`), su
 *  clasificación en áreas (`sesOverview`), el plazo con hora (`deadlineOf`) y a dónde lleva un rechazo (`sesErrorTarget`).
 *  De los huéspedes, solo recuentos y solo para quien puede verlos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, deadlineLevel, deadlineOf, sesErrorTarget, sesOverview, sesRowOf, type SesCommunication, type SesOverviewItem } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const H = 3_600_000;
let app: TestApp;
let designated: string; // editor con scopes.guests
let seq = 0;

test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('booking', $1, 'editor', '{"guests": true}'::jsonb)`, [user]);
  designated = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[], token: string = app.tokens.owner) {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: `so-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
async function confirmed(title: string, paid: boolean, start = '2027-11-05', end = '2027-11-07'): Promise<{ id: string; eventId: string }> {
  const id = uuid(); const eventId = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 12, contact_name: 'Persona Sintética' } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: eventId, from_status: 'pre_reservada' } }]);
  if (paid) await ok([{ op: 'insert', table: TABLES.finance, id, fields: { deposit_required: 100, deposit_paid: 100, payment_type: 'transferencia', payment_date: '2027-10-01' } }]);
  return { id, eventId };
}
async function comm(reservationId: string, fields: Record<string, unknown>): Promise<string> {
  const cols = Object.keys(fields);
  const out = await app.t.db.query<{ id: string }>(`insert into booking.ses_communications (reservation_id, environment, ${cols.join(', ')})
    values ($1, 'pre', ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning id`, [reservationId, ...cols.map((c) => fields[c])]);
  return out.rows[0]!.id;
}
const overview = async (token: string = app.tokens.owner) => app.call('/api/v1/ses', { token });
const itemOf = (data: any, id: string) => (data.items as SesOverviewItem[]).find((i) => i.reservation.id === id);

test('B2 · una lectura con las reservas que importan, sus comunicaciones y los recuentos de huéspedes (solo para quien los ve)', async () => {
  const waiting = await confirmed('Espera el pago', false);
  const ready = await confirmed('Lista para comunicar', true);
  const rejected = await confirmed('Rechazada por el tipo de pago', true);
  await comm(rejected.id, { kind: 'RH', status: 'rechazada', error_code: 'DATA_tipoPago', error_text: 'Indica el tipo de pago.' });
  const done = await confirmed('Comunicada', true, '2099-03-05', '2099-03-07');
  await comm(done.id, { kind: 'RH', status: 'aceptada', ses_code: 'COD-1', accepted_at: new Date().toISOString(), snapshot: { start_date: '2099-03-05', end_date: '2099-03-07', persons: 12 } });
  await ok([{ op: 'insert', table: TABLES.guests, id: uuid(), fields: { event_id: done.eventId, first_name: 'Persona', last_name_1: 'Sintética' } }], designated);
  const cancelled = await confirmed('Cancelada tras comunicarse', true);
  await comm(cancelled.id, { kind: 'RH', status: 'aceptada', ses_code: 'COD-2', snapshot: { start_date: '2027-11-05', end_date: '2027-11-07', persons: 12 } });
  await app.t.db.query(`update booking.reservations set status = 'cancelada' where id = $1`, [cancelled.id]);
  const quiet = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: quiet, fields: { title: 'Pre-reserva', status: 'pre_reservada', start_date: '2027-12-01', end_date: '2027-12-03', expected_guests: 5 } }]);

  const res = await overview();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.settings, { environment: 'pre', paused: false });
  assert.equal(itemOf(res.data, quiet), undefined, 'una pre-reserva no entra');
  assert.equal(itemOf(res.data, waiting.id)!.payment!.registered_at, null);
  assert.ok(itemOf(res.data, ready.id)!.payment!.registered_at, 'el pago registrado, para el plazo');
  assert.equal(itemOf(res.data, rejected.id)!.communications[0]!.error_code, 'DATA_tipoPago');
  assert.ok(itemOf(res.data, cancelled.id), 'cancelada con una comunicación aceptada: hay que anularla');
  const counts = itemOf(res.data, done.id)!.guests!;
  assert.equal(counts.total, 1); assert.equal(counts.incomplete, 1); assert.equal(counts.ready, 0);
  assert.doesNotMatch(JSON.stringify(res.data), /Persona Sintética|"first_name"/, 'sin nombres de huéspedes ni del contacto');

  // la bandeja con esos datos
  const tray = sesOverview(res.data);
  const areaOf = (id: string) => tray.rows.find((r) => r.item.reservation.id === id)?.area;
  assert.equal(areaOf(waiting.id), 'esperando_pago');
  assert.equal(areaOf(ready.id), 'listas');
  assert.equal(areaOf(rejected.id), 'corregir');
  assert.equal(tray.rows.find((r) => r.item.reservation.id === rejected.id)!.target!.where, 'cobro');
  assert.equal(areaOf(done.id), 'antes_de_llegar');
  assert.equal(areaOf(cancelled.id), 'cambio');

  // permisos: el designado ve los recuentos; el editor sin ámbito, no; el lector no lee nada
  assert.ok(itemOf((await overview(designated)).data, done.id)!.guests);
  const plain = await overview(app.tokens.editor);
  assert.equal(plain.status, 200);
  assert.equal(itemOf(plain.data, done.id)!.guests, null);
  assert.equal((await overview(app.tokens.reader)).status, 403);
});

test('partes de viajeros · nombres y documentos solo para quien puede ver huéspedes', async () => {
  const { id } = await confirmed('Parte de viajeros', true);
  assert.equal((await app.call(`/api/v1/ses/${id}/pv`, { token: app.tokens.editor })).status, 403, 'editor sin scopes.guests');
  assert.equal((await app.call(`/api/v1/ses/${id}/pv`, { token: app.tokens.editor, body: {} })).status, 403);
  assert.equal((await app.call(`/api/v1/ses/${id}/pv`, { token: designated })).status, 200);
  assert.equal((await app.call(`/api/v1/ses/${id}/pv`, { token: app.tokens.owner })).status, 200);
});

// ---------------------------------------------------------------------------------------------------------------------
// Reglas puras
// ---------------------------------------------------------------------------------------------------------------------

const NOW = Date.parse('2026-10-15T10:00:00Z');
const c = (fields: Partial<SesCommunication>): SesCommunication => ({ id: uuid(), kind: 'RH', status: 'preparada', environment: 'pre', cancels_id: null, lot_id: null, ses_code: null,
  error_code: null, error_text: null, legal_start_at: null, snapshot: null, attempts: 0, sent_at: null, accepted_at: null, cancelled_at: null, created_at: null, ...fields });
const item = (fields: { status?: string; ses_enabled?: boolean; registered?: string | null; comms?: SesCommunication[]; guests?: SesOverviewItem['guests']; start?: string } = {}): SesOverviewItem => ({
  reservation: { id: uuid(), code: 'RSV_2026_041', title: 'Yoga de otoño', status: fields.status ?? 'confirmada', start_date: fields.start ?? '2026-10-16', end_date: '2026-10-18',
    expected_guests: 24, final_guests: 24, event_id: uuid(), archived_at: null, ses_enabled: fields.ses_enabled ?? true, ses_disabled_reason: null, ses_disabled_note: null },
  payment: { registered_at: fields.registered === undefined ? '2026-10-15T00:00:00Z' : fields.registered, date: '2026-10-15' },
  communications: fields.comms ?? [],
  guests: fields.guests ?? null,
});

test('deadlineOf · vence 24 h después, con los umbrales de 12, 18 y 24 h', () => {
  const start = '2026-10-14T11:00:00Z';
  assert.deepEqual(deadlineOf(start, NOW), { dueAt: '2026-10-15T11:00:00.000Z', level: 'alert', msLeft: H });
  assert.equal(deadlineOf(start, NOW)!.level, deadlineLevel(start, NOW));
  assert.equal(deadlineOf('2026-10-15T09:00:00Z', NOW)!.level, 'ok');
  assert.equal(deadlineOf('2026-10-14T09:00:00Z', NOW)!.level, 'expired');
  assert.ok(deadlineOf('2026-10-14T09:00:00Z', NOW)!.msLeft < 0);
  assert.equal(deadlineOf(null, NOW), null);
});

test('sesErrorTarget · un rechazo lleva a su dato; lo desconocido, a «Revisar la reserva»', () => {
  assert.deepEqual(sesErrorTarget('DATA_tipoPago'), { where: 'cobro', field: 'payment_type', label: 'Corregir el tipo de pago en la ficha' });
  assert.equal(sesErrorTarget('DATA_nombre', 'RH').where, 'reserva', 'en una reserva, lo que falta es del titular');
  assert.equal(sesErrorTarget('DATA_nombre', 'PV').where, 'huespedes', 'en un parte, del huésped');
  assert.equal(sesErrorTarget('AUTH').where, 'ajustes');
  assert.equal(sesErrorTarget('SES_10121').label, 'Revisar la reserva');
  assert.equal(sesErrorTarget(null).label, 'Revisar la reserva');
});

test('sesRowOf · cada caso a su área, también las que añadió la revisión', () => {
  const accepted = c({ status: 'aceptada', ses_code: 'COD', snapshot: { start_date: '2026-10-16', end_date: '2026-10-18', persons: 24 } });
  const cases: Array<[string, SesOverviewItem, string | null]> = [
    ['espera el pago', item({ registered: null }), 'esperando_pago'],
    ['lista', item(), 'listas'],
    ['rechazada', item({ comms: [c({ status: 'rechazada', error_code: 'DATA_fechas' })] }), 'corregir'],
    ['error con reintento', item({ comms: [c({ status: 'error', error_code: 'NETWORK' })] }), 'reintentando'],
    ['retenida por la pausa', item({ comms: [c({ status: 'preparada', error_code: 'PAUSED' })] }), 'retenidas'],
    ['retenida sin credenciales', item({ comms: [c({ status: 'preparada', error_code: 'NOT_CONFIGURED' })] }), 'retenidas'],
    ['en proceso', item({ comms: [c({ status: 'en_proceso' })] }), 'en_proceso'],
    ['comunicada', item({ comms: [accepted] }), 'comunicadas'],
    ['cambió tras comunicarse', item({ comms: [{ ...accepted, snapshot: { ...accepted.snapshot, persons: 20 } }] }), 'cambio'],
    ['SES desactivado con una aceptada', item({ ses_enabled: false, comms: [accepted] }), 'cambio'],
    ['anulación en curso', item({ ses_enabled: false, comms: [c({ kind: 'anulacion', status: 'en_proceso', cancels_id: accepted.id }), accepted] }), 'anulacion'],
    ['parte rechazado', item({ comms: [c({ kind: 'PV', status: 'rechazada', error_code: 'DATA_fechaNacimiento' }), accepted] }), 'partes'],
    ['llegados sin parte', item({ comms: [accepted], guests: { total: 3, incomplete: 0, unsigned: 0, ready: 3, arrived: 2, pending_report: 2 } }), 'partes'],
    ['faltan datos antes de llegar', item({ comms: [accepted], guests: { total: 24, incomplete: 3, unsigned: 3, ready: 18, arrived: 0, pending_report: 0 } }), 'antes_de_llegar'],
    ['ya llegaron: no es «antes de llegar»', item({ start: '2026-10-10', comms: [{ ...accepted, snapshot: { ...accepted.snapshot, start_date: '2026-10-10' } }], guests: { total: 24, incomplete: 3, unsigned: 0, ready: 21, arrived: 0, pending_report: 0 } }), 'comunicadas'],
    ['sin SES', item({ ses_enabled: false }), 'sin_ses'],
    ['cerrada y sin comunicar', item({ status: 'cerrada' }), 'listas'],
    ['cancelada sin nada que anular', item({ status: 'cancelada' }), null],
  ];
  for (const [name, input, area] of cases) assert.equal(sesRowOf(input, NOW)?.area ?? null, area, name);
  assert.equal(sesRowOf(item({ comms: [c({ status: 'preparada', error_code: 'PAUSED' })] }), NOW)!.deadline!.level, 'ok', 'la pausa no para el plazo');
  assert.equal(sesRowOf(item({ comms: [{ ...accepted, snapshot: { ...accepted.snapshot, persons: 20 } }] }), NOW)!.action, 'anular');
  assert.equal(sesRowOf(item(), NOW)!.action, 'comunicar');
});

test('sesOverview · veredicto: cuenta lo que hay que resolver (las retenidas también) y la primera es la que vence antes', () => {
  const soon = item({ registered: '2026-10-14T12:00:00Z' });
  const later = item({ registered: '2026-10-15T08:00:00Z', comms: [c({ status: 'preparada', error_code: 'PAUSED' })] });
  const fine = item({ comms: [c({ status: 'aceptada', snapshot: { start_date: '2026-10-16', end_date: '2026-10-18', persons: 24 } })] });
  const tray = sesOverview({ settings: { environment: 'prod', paused: true }, items: [later, fine, soon, item({ registered: null })] }, NOW);
  assert.equal(tray.problems, 2);
  assert.equal(tray.first!.item, soon);
  assert.equal(tray.byArea.comunicadas.length, 1);
  assert.equal(tray.byArea.esperando_pago.length, 1);
  assert.equal(sesOverview({ settings: null, items: [fine] }, NOW).problems, 0, 'todo en regla');
});
