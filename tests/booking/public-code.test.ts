/** Booking · código público del evento y su lectura pública (0488, VG V0.2; BG17 y BG19 de Guests). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { PUBLIC_CODE_PATTERN, newPublicCode, validateFields, visitorUrl } from '../../supabase/functions/_domain/booking/mod.ts';

test('código público: al confirmar, 10 caracteres sin ambigüedades y único; la lectura pública da solo lo público', async () => {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  await t.db.query(`insert into core.memberships (app, user_id, role) values ('booking', $1, 'owner')`, [owner]);
  let seq = 0;
  const commit = (operations: unknown[]) => { const id = `pc-${++seq}`; return t.rpc('core_commit', { p_app: 'booking', p_actor: owner, p_request_id: id, p_digest: id, p_expected_cursor: null, p_operations: operations }); };
  const confirm = async (title: string, fields: Record<string, unknown> = {}) => {
    const res = crypto.randomUUID(); const event = crypto.randomUUID();
    await commit([{ op: 'insert', table: 'booking.reservations', id: res, fields: { title, event_type: 'jornadas_abiertas', status: 'pre_reservada', start_date: '2031-10-30', end_date: '2031-11-01', expected_guests: 200, guests_visible: true, public_summary: 'Carrera y comida.', contact_name: 'Persona Sintética', ...fields } }]);
    await commit([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
    return { res, event, code: (await t.db.query<{ c: string }>(`select public_code c from booking.events where id = $1`, [event])).rows[0]!.c };
  };
  const a = await confirm('Carrera sintética');
  const b = await confirm('Otra sintética', { guests_visible: false });
  assert.match(a.code, PUBLIC_CODE_PATTERN);
  assert.notEqual(a.code, b.code);
  const read = (code: unknown) => t.rpc('core_public_read', { p_name: 'booking_event', p_args: { code } }) as Promise<any>;
  assert.deepEqual(await read(a.code.toLowerCase()), {
    code: a.code, name: 'Carrera sintética', starts_on: '2031-10-30', ends_on: '2031-11-01', kind: 'jornadas_abiertas', status: 'abierto', joinable: true, summary: 'Carrera y comida.',
  });
  // no visible para huéspedes: se ve, pero sin resumen y sin apuntarse
  const other = await read(b.code);
  assert.deepEqual([other.joinable, other.summary], [false, null]);
  assert.ok(!JSON.stringify(other).includes('Persona Sintética'), 'nada del organizador');
  assert.equal(await read('ZZZZZZZZZZ'), null);
  assert.equal(await read(null), null);
  // cancelada: deja de responder
  await t.db.query(`update booking.reservations set status = 'cancelada' where id = $1`, [b.res]);
  assert.equal(await read(b.code), null);
  // «Regenerar»: un update con un código nuevo; uno con otro formato no entra
  const fresh = newPublicCode();
  await commit([{ op: 'update', table: 'booking.events', id: a.event, expectedRevision: Number((await t.db.query<{ r: string }>(`select revision r from booking.events where id = $1`, [a.event])).rows[0]!.r), fields: { public_code: fresh } }]);
  assert.equal(await read(a.code), null, 'el QR anterior deja de valer');
  assert.equal((await read(fresh)).name, 'Carrera sintética');
  await assert.rejects(t.db.query(`update booking.events set public_code = 'abc' where id = $1`, [a.event]));
  await t.close();
});

test('código público: dominio (formato, código nuevo y URL)', () => {
  const field = (f: Record<string, unknown>) => validateFields('booking.events', f, 'update').map((i) => i.details.field);
  assert.deepEqual(field({ public_code: 'ABCDEFGH23' }), []);
  assert.deepEqual(field({ public_code: 'ABCDEFGH0I' }), ['public_code'], 'sin 0 ni I');
  assert.match(newPublicCode(), PUBLIC_CODE_PATTERN);
  assert.equal(newPublicCode(() => new Uint8Array(10)), 'AAAAAAAAAA');
  assert.equal(visitorUrl('ABCDEFGH23'), 'https://ven.ikisai.com/e/ABCDEFGH23');
});
