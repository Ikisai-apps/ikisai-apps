/** Booking · tanda 27: calendario de precios (MUELA-067 §5 y §7). La disponibilidad del dispositivo da lo mismo que
 *  `booking.range_availability` (la que ve el organizador), y el precio sale del mismo cálculo que la propuesta. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, applyMinimum, fridays, priceCalendar, priceFor, proposalTotals, rangeAvailability, suggestLines, type AvailabilityInput } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!, createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });
async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `pc-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}

test('rangeAvailability · mismo resultado que booking.range_availability con los mismos datos', async () => {
  // año lejano para no cruzarse con otras pruebas
  const mk = async (status: string, start: string, end: string, extra: Record<string, unknown> = {}) => {
    const id = uuid();
    await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: `Caso ${status}`, status: 'en_estudio', start_date: start, end_date: end, expected_guests: 10, ...extra } }]);
    // las confirmadas, con su evento (invariante de Booking); las demás, el estado tal cual
    if (status === 'confirmada') await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'en_estudio' } }]);
    else await app.t.db.query('update booking.reservations set status = $2 where id = $1', [id, status]);
    return id;
  };
  await mk('confirmada', '2091-05-04', '2091-05-06');
  await mk('pre_reservada', '2091-05-11', '2091-05-13', { dates_definitive: true });
  await mk('pre_reservada', '2091-05-18', '2091-05-20');
  const study = await mk('en_estudio', '2091-06-01', '2091-06-03');
  // opción y bloqueo directos en la base: aquí solo importa la regla, no sus validaciones
  await app.t.db.query(`insert into booking.reservation_date_options (reservation_id, start_date, end_date, proposed_by) values ($1, '2091-05-25', '2091-05-27', 'ikisai')`, [study]);
  await mk('cancelada', '2091-06-08', '2091-06-10');
  const archived = await mk('confirmada', '2091-06-15', '2091-06-17');
  await app.t.db.query('update booking.reservations set archived_at = now() where id = $1', [archived]);
  await app.t.db.query(`insert into booking.date_blocks (start_date, end_date, reason) values ('2091-06-22', '2091-06-24', 'Obras')`);

  const q = async (sql: string) => (await app.t.db.query<Record<string, any>>(sql)).rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v])));
  const input: AvailabilityInput = {
    reservations: await q('select id, status, start_date, end_date, dates_definitive, archived_at, deleted_at from booking.reservations') as any,
    blocks: await q('select start_date, end_date, deleted_at from booking.date_blocks') as any,
    options: await q('select reservation_id, start_date, end_date, proposed_by, deleted_at from booking.reservation_date_options') as any,
  };
  const ranges = [...fridays('2091-05-01', 2).map((start) => [start, new Date(Date.parse(`${start}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10)]),
    ['2091-05-04', '2091-05-06'], ['2091-05-11', '2091-05-13'], ['2091-05-18', '2091-05-20'], ['2091-05-25', '2091-05-27'],
    ['2091-06-08', '2091-06-10'], ['2091-06-15', '2091-06-17'], ['2091-06-22', '2091-06-24'], ['2091-05-06', '2091-05-08']] as Array<[string, string]>;
  for (const [start, end] of ranges) {
    const sql = (await app.t.db.query<{ a: string }>('select booking.range_availability($1::date, $2::date, null) a', [start, end])).rows[0]!.a;
    assert.equal(rangeAvailability(start, end, input), sql, `${start}`);
  }
  // los casos que importan, por si cambian las fechas de la semana
  assert.equal(rangeAvailability('2091-05-04', '2091-05-06', input), 'ocupado', 'confirmada');
  assert.equal(rangeAvailability('2091-05-11', '2091-05-13', input), 'ocupado', 'pre-reserva con fecha definitiva');
  assert.equal(rangeAvailability('2091-05-18', '2091-05-20', input), 'libre', 'pre-reserva sin fecha definitiva ni opciones: como en SQL');
  assert.equal(rangeAvailability('2091-05-25', '2091-05-27', input), 'en_opcion', 'opción propuesta por Ikisai');
  assert.equal(rangeAvailability('2091-06-08', '2091-06-10', input), 'libre', 'cancelada');
  assert.equal(rangeAvailability('2091-06-15', '2091-06-17', input), 'libre', 'archivada');
  assert.equal(rangeAvailability('2091-06-22', '2091-06-24', input), 'ocupado', 'bloqueo');
  assert.equal(rangeAvailability('2091-05-06', '2091-05-08', input), 'libre', 'la salida es día libre');
});

const rate = (id: string, f: Record<string, unknown>) => ({ id, name: id, layer: 'por_persona', unit: 'persona_noche', amount: 40, service: null,
  min_persons: null, max_persons: null, event_types: null, valid_from: null, valid_to: null, active: true, ...f });
const RATES = [
  rate('recinto', { layer: 'recinto', unit: 'dia', amount: 500 }),
  rate('noche', {}),
  rate('alta', { layer: 'ajuste', unit: 'porcentaje', amount: 10, valid_from: '2026-07-01', valid_to: '2026-08-31' }),
];
const CONDITIONS = { deposit_percent: 30, deposit_minimum: 0, prices_include_vat: true, vat_rate: 10, minimum_total: 2000 };
const CASE = { reservation: { event_type: 'retiro', start_date: null, end_date: null, expected_guests: 24, uses_accommodation: true }, persons: 24, nights: 2, rates: RATES, conditions: CONDITIONS };

test('priceFor · el mismo cálculo que la propuesta, solo cambia la fecha', () => {
  const start = '2026-10-16';
  const expected = applyMinimum(proposalTotals(suggestLines({ ...CASE.reservation, start_date: start, end_date: '2026-10-18' }, RATES, { persons: 24 }), CONDITIONS).total, 2000);
  const got = priceFor(CASE, start);
  assert.equal(got.total, expected.total);
  assert.equal(got.end, '2026-10-18');
  assert.equal(got.perPerson, Math.round(expected.total / 24 * 100) / 100);
  assert.equal(got.high, false);
  assert.equal(priceFor(CASE, '2026-07-17').high, true, 'el ajuste que sube el precio marca la temporada alta');
  assert.ok(priceFor(CASE, '2026-07-17').total! > got.total!);
  assert.equal(priceFor({ ...CASE, persons: 2 }, start).minimumApplied, true);
  assert.equal(priceFor({ ...CASE, rates: [] }, start).total, null);
});

test('priceCalendar · viernes por meses con su cifra de libres, el más barato y los ocupados', () => {
  assert.deepEqual(fridays('2026-10-01', 1), ['2026-10-02', '2026-10-09', '2026-10-16', '2026-10-23', '2026-10-30']);
  assert.equal(fridays('2026-10-17', 1)[0], '2026-10-23', 'desde el día dado');
  const availability: AvailabilityInput = {
    reservations: [{ id: 'r1', status: 'confirmada', start_date: '2026-07-03', end_date: '2026-07-05' }],
    blocks: [], options: [],
  };
  const months = priceCalendar({ ...CASE, from: '2026-06-01', months: 3, availability });
  assert.deepEqual(months.map((m) => m.month), ['2026-06', '2026-07', '2026-08']);
  const july = months[1]!;
  assert.equal(july.weekends[0]!.availability, 'ocupado');
  assert.equal(july.free, july.weekends.length - 1);
  const cheapest = months.flatMap((m) => m.weekends).filter((w) => w.cheapest);
  assert.ok(cheapest.length >= 1 && cheapest.every((w) => w.start.startsWith('2026-06')), 'los de junio, sin temporada alta');
  assert.ok(july.weekends.every((w) => w.high));
  assert.equal(priceCalendar({ ...CASE, from: '2026-07-01', months: 1, availability, ownId: 'r1' }).at(0)!.weekends[0]!.availability, 'libre', 'la propia reserva no cuenta');
});

test('price_calendar_source · el lector ve lo justo para el precio, sin motivos ni textos (tanda 30)', async () => {
  // Se apoya en lo que sembró la primera prueba (año 2091): un bloqueo «Obras» y una opción de Ikisai.
  await app.t.db.query(`insert into booking.rates (name, layer, unit, amount, active, position, includes) values ('Noche lector', 'por_persona', 'persona_noche', 40, true, 1, 'Sábanas'), ('Inactiva lector', 'por_persona', 'persona_noche', 99, false, 2, null)`);
  await app.t.db.query(`insert into booking.conditions (name, is_default, vat_rate, text, minimum_total) values ('Condiciones lector', true, 10, 'Texto interno', 1500)`);
  const res = await app.call('/api/v1/read/booking.price_calendar_source', { token: app.tokens.reader, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const data = res.data as { rates: Array<Record<string, unknown>>; conditions: Record<string, unknown>; blocks: Array<Record<string, unknown>>; options: Array<Record<string, unknown>> };
  assert.ok(data.rates.some((r) => r.name === 'Noche lector'));
  assert.ok(!data.rates.some((r) => r.name === 'Inactiva lector'), 'solo las activas');
  assert.equal(Number(data.conditions.minimum_total), 1500);
  assert.ok(data.blocks.some((b) => String(b.start_date).startsWith('2091-06-22')));
  assert.ok(data.options.some((o) => String(o.start_date).startsWith('2091-05-25')));
  const text = JSON.stringify(data);
  for (const hidden of ['Obras', 'Sábanas', 'Texto interno']) assert.ok(!text.includes(hidden), `sin «${hidden}»`);
  // con ello, el precio en el dispositivo es el mismo que con las tablas
  const price = priceFor({ ...CASE, rates: data.rates as never, conditions: data.conditions as never }, '2091-05-04');
  assert.equal(price.total, applyMinimum(proposalTotals(suggestLines({ ...CASE.reservation, start_date: '2091-05-04', end_date: '2091-05-06' }, data.rates as never, { persons: 24 }), data.conditions as never).total, 1500).total);
});
