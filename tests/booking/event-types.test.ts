/** Booking · tres tipos de reserva (migración 0482, VG 26-10-2026): solo retiro, jornadas_abiertas y familiar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { EVENT_TYPES, validateFields } from '../../supabase/functions/_domain/booking/mod.ts';

test('tipos de reserva: los tres nuevos entran; los viejos, no (base y dominio)', async () => {
  assert.deepEqual([...EVENT_TYPES], ['retiro', 'jornadas_abiertas', 'familiar']);
  const t = await createTestDatabase();
  const owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  let seq = 0;
  const commit = (fields: Record<string, unknown>) => {
    const id = `et-${++seq}`;
    return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: 'booking.reservations', id: crypto.randomUUID(), fields: { title: `Tipo ${seq}`, status: 'en_estudio', ...fields } }] });
  };
  for (const type of EVENT_TYPES) await commit({ event_type: type });
  for (const old of ['otro', 'convivencia', 'formacion']) await assert.rejects(commit({ event_type: old }), old);
  const rows = (await t.db.query<{ event_type: string }>(`select event_type from booking.reservations order by title`)).rows.map((r) => r.event_type);
  assert.deepEqual(rows.sort(), ['familiar', 'jornadas_abiertas', 'retiro']);
  await t.close();
});

test('tipos de reserva: el dominio rechaza los valores viejos, en la reserva y en las tarifas', () => {
  const field = (table: string, f: Record<string, unknown>) => validateFields(table, f, 'update').map((i) => i.details.field);
  assert.deepEqual(field('booking.reservations', { event_type: 'otro' }), ['event_type']);
  assert.deepEqual(field('booking.reservations', { event_type: 'familiar' }), []);
  assert.deepEqual(field('booking.rates', { event_types: ['retiro', 'convivencia'] }), ['event_types']);
  assert.deepEqual(field('booking.rates', { event_types: ['jornadas_abiertas'] }), []);
});
