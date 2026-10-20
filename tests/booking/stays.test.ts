/**
 * Booking · O2, parte 1: estancias de outsider y del staff (migración 0467). Sobre PGlite:
 * - la cama por defecto, el choque con un retiro como aviso (nunca bloquea) y la ocupación en `bed_free`;
 * - el arreglo de `bed_free` con huésped nulo (las asignaciones de grupo de otro retiro cuentan);
 * - las lecturas y acciones de outsider para Guests, con su ámbito (`core.house_levels`);
 * - la familia: personas con clave estable, separar una estancia y agrupar fichas de la misma persona;
 * - la presencia del staff sin nombres y las notas con hora;
 * - la disponibilidad del organizador no cuenta las estancias (decisión del usuario).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { TABLES, stayClashes } from '../../supabase/functions/_domain/booking/mod.ts';

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

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `stays-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) {
  const res = await commit(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
const q = async <T extends Record<string, any>>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const read = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const invoke = (appId: string, actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: appId, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
async function code(promise: Promise<unknown>) {
  try { await promise; return 'OK'; } catch (error) { return String((error as Error).message).match(/[A-Z_]{5,}/)?.[0] ?? String(error); }
}
async function retreat(title: string, start: string, end: string) {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title, status: 'pre_reservada', start_date: start, end_date: end, expected_guests: 4 } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  return { res, event };
}
async function member(appId: string, grants: unknown[] | null, level: string | null = null) {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [appId, user, grants ? JSON.stringify({ grants }) : null]);
  if (level) await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, $2)`, [user, level]);
  return user;
}
async function room(name: string, beds = 1) {
  const space = uuid(); const ids = Array.from({ length: beds }, () => uuid());
  await ok([
    { op: 'insert', table: TABLES.spaces, id: space, fields: { name, kind: 'habitacion', capacity: beds } },
    ...ids.map((id, i) => ({ op: 'insert', table: TABLES.beds, id, fields: { space_id: space, label: `Cama ${i + 1}` } })),
  ]);
  return { space, beds: ids };
}
const bedFree = async (bed: string, event: string, guest: string | null) => (await q<{ v: boolean }>(`select booking.bed_free($1, $2, $3) v`, [bed, event, guest]))[0]!.v;

test('bed_free con huésped nulo: la asignación de grupo de otro retiro solapado ocupa la cama', async () => {
  const { space, beds: [bed] } = await room('Hab grupo');
  const a = await retreat('Retiro de grupo', '2031-01-10', '2031-01-12');
  const b = await retreat('Retiro solapado', '2031-01-11', '2031-01-13');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: a.event, space_id: space, bed_id: bed, group_label: 'Grupo', persons: 1 } }]);
  assert.equal(await bedFree(bed!, b.event, null), false, 'antes salía libre');
  assert.equal(await bedFree(bed!, b.event, uuid()), false, 'con huésped concreto, como siempre');
});

test('estancia de outsider: cama por defecto, choque con un retiro como aviso y ocupación', async () => {
  const { space, beds: [bed] } = await room('Hab outsider');
  const marta = await member('guests', null, 'outsider');
  await ok([{ op: 'insert', table: TABLES.outsiderDefaults, id: uuid(), fields: { account_id: marta, bed_id: bed } }]);
  const [def] = await q(`select space_id from booking.outsider_defaults where account_id = $1`, [marta]);
  assert.equal(def!.space_id, space, 'el espacio sale de la cama');

  const stay = uuid();
  const saved = await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2031-02-05', to: '2031-02-08' });
  assert.equal(saved.clash, false);
  const [row] = await q(`select space_id, bed_id, source, kind from booking.stays where id = $1`, [stay]);
  assert.deepEqual([row!.space_id, row!.bed_id, row!.source, row!.kind], [space, bed, 'guest', 'outsider'], 'sin cama, la de por defecto');

  // un retiro reparte esa cama: se guarda igual (aviso, no bloqueo) y la estancia sale con choque
  const r = await retreat('Retiro que choca', '2031-02-07', '2031-02-09');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: r.event, space_id: space, bed_id: bed, group_label: 'G', persons: 1 } }]);
  const mine = await read('guests', marta, 'booking.portal_my_stays', { from: '2031-02-01', to: '2031-03-01' });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].clash, true);
  assert.equal(mine.items[0].bed_label, 'Cama 1');
  assert.equal(mine.default_bed.bed_label, 'Cama 1');
  // ids de Recursos (0478): sin pareja, null; con ella, en la estancia y en la cama por defecto
  assert.deepEqual([mine.items[0].resource_space_id, mine.items[0].resource_bed_id, mine.default_bed.resource_bed_id], [null, null, null]);
  const [rSpace, rBed] = [uuid(), uuid()];
  await q(`update booking.spaces set resource_id = $2 where id = $1`, [space, rSpace]);
  await q(`update booking.beds set resource_id = $2 where id = $1`, [bed, rBed]);
  const linked = await read('guests', marta, 'booking.portal_my_stays', { from: '2031-02-01', to: '2031-03-01' });
  assert.deepEqual([linked.items[0].resource_space_id, linked.items[0].resource_bed_id], [rSpace, rBed]);
  assert.deepEqual([linked.default_bed.resource_space_id, linked.default_bed.resource_bed_id], [rSpace, rBed]);
  await q(`update booking.spaces set resource_id = null where id = $1`, [space]);
  await q(`update booking.beds set resource_id = null where id = $1`, [bed]);
  assert.equal(JSON.stringify(mine).includes('Retiro que choca'), false, 'el outsider no ve de qué retiro es');

  const clashing = await read('booking', await member('booking', null), 'booking.stays_clashing', { from: '2031-02-01', to: '2031-03-01' });
  const item = clashing.items.find((i: any) => i.stay_id === stay);
  assert.deepEqual(item.clashes.map((c: any) => [c.kind, c.title]), [['retiro', 'Retiro que choca']], 'el personal ve con qué choca');

  // la estancia ocupa la cama para los portales: un retiro en esas noches no la ve libre
  const other = await retreat('Retiro en las noches de la estancia', '2031-02-05', '2031-02-06');
  assert.equal(await bedFree(bed!, other.event, null), false);
  const after = await retreat('Retiro tras la estancia', '2031-02-09', '2031-02-10');
  assert.equal(await bedFree(bed!, after.event, null), true, 'la salida de la estancia es la entrada del retiro');

  // mover y quitar
  const moved = await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2031-02-01', to: '2031-02-03', expectedRevision: Number(saved.revision) });
  assert.equal(moved.clash, false);
  await invoke('guests', marta, 'booking.portal_stay_remove', { id: stay });
  assert.equal((await read('guests', marta, 'booking.portal_my_stays', { from: '2031-01-01', to: '2031-03-01' })).items.length, 0);
});

test('ámbito: solo outsiders, y cada uno lo suyo', async () => {
  const marta = await member('guests', null, 'outsider');
  const luis = await member('guests', null, 'outsider');
  const huesped = await member('guests', null);
  const stay = uuid();
  await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2031-03-01', to: '2031-03-02' });
  assert.equal(await code(read('guests', huesped, 'booking.portal_my_stays', {})), 'OUT_OF_SCOPE', 'un huésped sin nivel outsider');
  assert.equal(await code(read('guests', huesped, 'booking.portal_staff_presence', {})), 'OUT_OF_SCOPE');
  assert.equal(await code(invoke('guests', luis, 'booking.portal_stay_save', { id: stay, from: '2031-03-05', to: '2031-03-06' })), 'OUT_OF_SCOPE', 'otra cuenta no mueve la estancia');
  assert.equal(await code(invoke('guests', luis, 'booking.portal_stay_remove', { id: stay })), 'OUT_OF_SCOPE');
  assert.equal(await code(invoke('guests', marta, 'booking.portal_stay_save', { id: uuid(), from: '2031-03-05', to: '2031-03-05' })), 'INVALID_FIELDS');
  // el personal no deja una estancia al revés
  const bad = await commit([{ op: 'insert', table: TABLES.stays, id: uuid(), fields: { account_id: marta, from_date: '2031-03-05', to_date: '2031-03-04' } }]);
  assert.equal(bad.status, 422);
});

test('familia: personas con clave estable, separar y claves ajenas', async () => {
  const marta = await member('guests', null, 'outsider');
  const stay = uuid();
  await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2031-04-01', to: '2031-04-05', persons: [{ name: 'Marta' }, { name: 'Nico' }] });
  let mine = await read('guests', marta, 'booking.portal_my_stays', { from: '2031-04-01', to: '2031-05-01' });
  const persons = mine.items[0].persons as { person_key: string; name: string }[];
  assert.deepEqual(persons.map((p) => p.name).sort(), ['Marta', 'Nico']);
  const nico = persons.find((p) => p.name === 'Nico')!.person_key;

  // renombrar con la misma clave no crea otra persona
  await invoke('guests', marta, 'booking.portal_stay_save', { id: stay, from: '2031-04-01', to: '2031-04-05',
    persons: persons.map((p) => ({ person_key: p.person_key, name: p.name === 'Nico' ? 'Nicolás' : p.name })) });
  mine = await read('guests', marta, 'booking.portal_my_stays', { from: '2031-04-01', to: '2031-05-01' });
  assert.equal(mine.items[0].persons.find((p: any) => p.person_key === nico).name, 'Nicolás');

  const split = await invoke('guests', marta, 'booking.portal_stay_split', { id: stay, person_keys: [nico], from: '2031-04-03', to: '2031-04-06' });
  assert.deepEqual(split.persons.map((p: any) => p.person_key), [nico]);
  mine = await read('guests', marta, 'booking.portal_my_stays', { from: '2031-04-01', to: '2031-05-01' });
  assert.deepEqual(mine.items.map((s: any) => [s.from, s.to, s.persons.map((p: any) => p.name)]),
    [['2031-04-01', '2031-04-05', ['Marta']], ['2031-04-03', '2031-04-06', ['Nicolás']]]);
  assert.equal(await code(invoke('guests', marta, 'booking.portal_stay_split', { id: split.id, person_keys: [nico], from: '2031-04-03', to: '2031-04-04' })), 'INVALID_FIELDS', 'no se separa a todos');

  // la clave de otra cuenta no se acepta
  const luis = await member('guests', null, 'outsider');
  assert.equal(await code(invoke('guests', luis, 'booking.portal_stay_save', { id: uuid(), from: '2031-04-01', to: '2031-04-02', persons: [{ person_key: nico, name: 'Nico' }] })), 'OUT_OF_SCOPE');
});

test('presencia del staff por día, sin nombres', async () => {
  const marta = await member('guests', null, 'outsider');
  const ana = await app.t.createUser();
  await ok([{ op: 'insert', table: TABLES.stays, id: uuid(), fields: { kind: 'staff', account_id: ana, from_date: '2031-05-02', to_date: '2031-05-04' } }]);
  const out = await read('guests', marta, 'booking.portal_staff_presence', { from: '2031-05-01', to: '2031-05-05' });
  assert.deepEqual(out.items.map((d: any) => [d.date, d.present]), [['2031-05-01', false], ['2031-05-02', true], ['2031-05-03', true], ['2031-05-04', false]]);
  assert.equal(JSON.stringify(out).includes(ana), false);
});

test('notas con hora: el outsider y el personal; cada uno cambia las suyas', async () => {
  const marta = await member('guests', null, 'outsider');
  const note = uuid();
  await invoke('guests', marta, 'booking.portal_stay_note_save', { id: note, at: '2031-06-01T20:00:00Z', text: 'Llego a las 22:00' });
  const staffNote = uuid();
  await ok([{ op: 'insert', table: TABLES.stayNotes, id: staffNote, fields: { account_id: marta, at: '2031-06-02T08:00:00Z', note: 'Desayuno a las 9' } }]);
  const out = await read('guests', marta, 'booking.portal_stay_notes', { from: '2031-06-01', to: '2031-06-03' });
  assert.deepEqual(out.items.map((n: any) => [n.text, n.mine, n.by]), [['Llego a las 22:00', true, 'outsider'], ['Desayuno a las 9', false, 'staff']]);
  assert.equal(await code(invoke('guests', marta, 'booking.portal_stay_note_save', { id: staffNote, at: '2031-06-02T08:00:00Z', text: 'Cambiada' })), 'OUT_OF_SCOPE');
  assert.equal(await code(invoke('guests', marta, 'booking.portal_stay_note_remove', { id: staffNote })), 'OUT_OF_SCOPE');
  await invoke('guests', marta, 'booking.portal_stay_note_save', { id: note, at: '2031-06-01T21:00:00Z', text: 'Llego a las 23:00' });
  await invoke('guests', marta, 'booking.portal_stay_note_remove', { id: staffNote }).catch(() => undefined);
  await invoke('guests', marta, 'booking.portal_stay_note_remove', { id: note });
  const left = await read('guests', marta, 'booking.portal_stay_notes', { from: '2031-06-01', to: '2031-06-03' });
  assert.deepEqual(left.items.map((n: any) => n.text), ['Desayuno a las 9']);
});

test('mis retiros y agrupar fichas de la misma persona', async () => {
  const one = await retreat('Primavera', '2031-07-03', '2031-07-05');
  const two = await retreat('Otoño', '2031-08-07', '2031-08-09');
  const [g1, g2, g3] = [uuid(), uuid(), uuid()];
  const org1 = await member('organizers', [{ reservation_id: one.res }]);
  const org2 = await member('organizers', [{ reservation_id: two.res }]);
  await invoke('organizers', org1, 'booking.portal_add_guest', { reservation_id: one.res, guest_id: g1, declaration: true, fields: { first_name: 'Marta' } });
  await invoke('organizers', org1, 'booking.portal_add_guest', { reservation_id: one.res, guest_id: g3, declaration: true, fields: { first_name: 'Nico' } });
  await invoke('organizers', org2, 'booking.portal_add_guest', { reservation_id: two.res, guest_id: g2, declaration: true, fields: { first_name: 'Marta' } });
  const marta = await member('guests', [{ reservation_id: one.res, guest_id: g1 }, { reservation_id: one.res, guest_id: g3 }, { reservation_id: two.res, guest_id: g2 }]);

  let mine = await read('guests', marta, 'booking.portal_my_retreats', {});
  assert.deepEqual(mine.items.map((i: any) => [i.title, i.name, i.person_key]), [['Primavera', 'Marta', null], ['Primavera', 'Nico', null], ['Otoño', 'Marta', null]]);

  const linked = await invoke('guests', marta, 'booking.portal_person_link', { guest_ids: [g1, g2] });
  mine = await read('guests', marta, 'booking.portal_my_retreats', {});
  assert.deepEqual(mine.items.filter((i: any) => i.name === 'Marta').map((i: any) => i.person_key), [linked.person_key, linked.person_key]);
  assert.equal(await code(invoke('guests', marta, 'booking.portal_person_link', { guest_ids: [g1, g3] })), 'INVALID_FIELDS', 'dos personas del mismo retiro no son la misma');
  const stranger = await member('guests', [{ reservation_id: two.res, guest_id: g2 }]);
  assert.equal(await code(invoke('guests', stranger, 'booking.portal_person_link', { guest_ids: [g1] })), 'OUT_OF_SCOPE');

  // la clave ya es de la cuenta: sirve para la estancia de la misma persona
  await app.t.db.query(`insert into core.house_levels (user_id, level) values ($1, 'outsider')`, [marta]);
  const saved = await invoke('guests', marta, 'booking.portal_stay_save', { id: uuid(), from: '2031-09-01', to: '2031-09-02', persons: [{ person_key: linked.person_key, name: 'Marta' }] });
  assert.ok(saved.id);
});

test('el dominio (stayClashes) dice lo mismo que booking.stay_clashes; house_people da nombre y nivel', async () => {
  const { space, beds: [bed] } = await room('Hab espejo');
  const marta = await member('guests', null, 'outsider');
  const r = await retreat('Retiro espejo', '2031-11-07', '2031-11-09');
  await ok([{ op: 'insert', table: TABLES.roomAssignments, id: uuid(), fields: { event_id: r.event, space_id: space, group_label: 'Toda la habitación', persons: 1 } }]);
  const [s1, s2] = [uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.stays, id: s1, fields: { account_id: marta, from_date: '2031-11-08', to_date: '2031-11-10', bed_id: bed } },
    { op: 'insert', table: TABLES.stays, id: s2, fields: { account_id: marta, from_date: '2031-11-09', to_date: '2031-11-11', bed_id: bed } },
  ]);
  // (como en el espejo de la app: fechas en texto AAAA-MM-DD)
  const day = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? null : String(v).slice(0, 10));
  const dated = (rows: any[], keys: string[]) => rows.map((r) => ({ ...r, ...Object.fromEntries(keys.map((k) => [k, day(r[k])])) }));
  const data = { assignments: dated(await q('select * from booking.room_assignments'), ['from_date', 'to_date']), events: await q('select * from booking.events'),
    reservations: dated(await q('select * from booking.reservations'), ['start_date', 'end_date']),
    stays: dated(await q('select * from booking.stays'), ['from_date', 'to_date']) };
  const norm = (v: any) => JSON.parse(JSON.stringify(v));
  for (const id of [s1, s2]) {
    const [sql] = await q<{ c: unknown }>('select booking.stay_clashes(s) c from booking.stays s where id = $1', [id]);
    const stay = data.stays.find((s: any) => s.id === id)!;
    const fixDates = (list: any[]) => list.map((c) => ({ ...c, from: day(c.from), to: day(c.to) }));
    assert.deepEqual(fixDates(stayClashes(stay as any, data as any)), fixDates(norm(sql!.c)), `misma lista para ${id}`);
  }
  await app.t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Marta Espejo') on conflict (user_id) do update set display_name = excluded.display_name`, [marta]);
  const people = await read('booking', await member('booking', null), 'booking.house_people', {});
  assert.deepEqual(people.items.find((p: any) => p.account_id === marta), { account_id: marta, name: 'Marta Espejo', level: 'outsider' });
});

test('disponibilidad del organizador: las estancias no cuentan', async () => {
  const marta = await member('guests', null, 'outsider');
  await invoke('guests', marta, 'booking.portal_stay_save', { id: uuid(), from: '2031-10-03', to: '2031-10-05' });
  const mine = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: mine, fields: { title: 'Mi retiro', status: 'en_estudio' } }]);
  const org = await member('organizers', [{ reservation_id: mine }]);
  const out = await read('organizers', org, 'booking.portal_availability', { reservation_id: mine, from: '2031-10-03', to: '2031-10-06' });
  assert.equal(out.weekends.find((w: any) => w.start === '2031-10-03').status, 'libre');
});
