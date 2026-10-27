/**
 * Food · ofertas de comida por evento (1111) contra PGlite: lo de hoy convertido en ofertas, las reglas de quién paga y de
 * qué menú, la lectura para Booking (sin internas), el portal (Organizers sin internas; Guests con ellas marcadas) y lo que
 * pide un evento sumando todas sus ofertas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFoodApp, FOOD_ORIGINS } from '../../supabase/functions/food-api/app.ts';
import { defaultOfferFields, eventSnapshot, offerGroupsText, offerPayerText, offerProblem, validateOperation, type FoodEvent } from '../../supabase/functions/_domain/food/mod.ts';
import { day, seedBookingEvent } from './helpers.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let counter = 0;
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const q = async <T = any>(sql: string, params: unknown[] = []) => (await app.t.db.query<T>(sql, params)).rows;
const send = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `offers-${++counter}`, operations } });
async function ok(operations: unknown[]) {
  const res = await send(operations);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string) {
  const res = await send(operations);
  assert.notEqual(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
const read = (portal: string, actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: portal, p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
async function member(portal: string, grant: Record<string, string>): Promise<string> {
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', $3::jsonb)`, [portal, user, JSON.stringify({ grants: [grant] })]);
  return user;
}

let event = '', reservation = '', other = '';
const menu = uuid(), carta = uuid(), saved = uuid(), house = 'f00dca5a-0000-4000-8000-000000000001';
const curry = uuid(), rice = uuid(), service = uuid(), lineA = uuid();

test.before(async () => {
  app = await createTestApp({
    app: 'food', slug: 'food-api', origin: FOOD_ORIGINS[0]!,
    createHandler: (config) => createFoodApp({ ...config, origins: [FOOD_ORIGINS[0]!] }),
  });
  event = await seedBookingEvent(app, { title: 'Retiro con barra', start: day(20), end: day(21) });
  other = await seedBookingEvent(app, { title: 'Otro retiro', start: day(30), end: day(31) });
  reservation = (await q(`select reservation_id r from booking.events where id = $1`, [event]))[0].r;
  const snapshot = (await app.call(`/api/v1/events/${event}`)).data.event as FoodEvent;
  await ok([
    insert('food.ingredients', rice, { name: 'Arroz', preferred_unit: 'kg' }),
    insert('food.recipes', curry, { name: 'Curry', public_name: 'Curry de verduras', category: 'principal', base_servings: 10, allergens: [], allergens_checked: true, diet_tags: ['vegano'] }),
    insert('food.recipe_ingredients', uuid(), { recipe_id: curry, ingredient_id: rice, quantity: 1, unit: 'kg' }),
    insert('food.menus', menu, { event_id: event, source_event_revision: snapshot.event_revision, source_event_snapshot: eventSnapshot(snapshot) }),
    insert('food.menu_services', service, { menu_id: menu, service_date: day(20), service_type: 'cena', service_time: '20:30', position: 1 }),
    insert('food.menu_items', uuid(), { service_id: service, recipe_id: curry, servings: 20, position: 1 }),
    insert('food.menus', carta, { kind: 'carta', name: 'Barra del retiro', event_id: event }),
    insert('food.carta_lines', lineA, { menu_id: carta, recipe_id: curry, scope: 'clasico', code: 'A', sale_price_cents: 300, expected_units: 10 }),
    insert('food.menus', saved, { kind: 'carta', name: 'Carta guardada' }),
    insert('food.menus', house, { kind: 'casa' }),
  ]);
});
test.after(async () => { await app.close(); });

test('conversión · cada menú de hoy es una oferta (una sola vez)', async () => {
  assert.equal((await q(`select food.backfill_event_offers() n`))[0].n, 3);
  assert.equal((await q(`select food.backfill_event_offers() n`))[0].n, 0);
  const rows = await q(`select menu_id, event_id, name, audience, payer, charge_when from food.event_offers order by position`);
  assert.deepEqual(rows, [
    { menu_id: house, event_id: null, name: 'Menú de casa', audience: 'interna', payer: null, charge_when: null },
    { menu_id: menu, event_id: event, name: 'Menú', audience: 'huespedes', payer: 'organizador', charge_when: null },
    { menu_id: carta, event_id: event, name: 'Barra del retiro', audience: 'huespedes', payer: 'huesped', charge_when: 'barra' },
  ]);
});

test('reglas · quién paga, cuándo se cobra, menú de otro evento y carta guardada', async () => {
  // La Edge, con el mismo texto que la base.
  await rejected([insert('food.event_offers', uuid(), { event_id: event, menu_id: menu, name: 'Sin pagador', audience: 'huespedes' })], 'INVALID_FIELDS');
  await rejected([insert('food.event_offers', uuid(), { event_id: event, menu_id: carta, name: 'Huésped sin cobro', audience: 'huespedes', payer: 'huesped' })], 'INVALID_FIELDS');
  await rejected([insert('food.event_offers', uuid(), { event_id: event, menu_id: menu, name: 'Interna que cobra', audience: 'interna', payer: 'organizador' })], 'INVALID_FIELDS');
  // El menú de este evento no se ofrece en otro.
  assert.equal((await rejected([insert('food.event_offers', uuid(), { event_id: other, menu_id: menu, name: 'Ajeno', audience: 'huespedes', payer: 'organizador' })], 'OFFER_EVENT_MISMATCH')).details.menu_id, menu);
  // Una carta guardada (sin evento) se ofrece tal cual, sin copiarla; y una interna para el equipo de este evento.
  await ok([
    insert('food.event_offers', uuid(), { event_id: event, menu_id: saved, name: 'Cena de ponentes', audience: 'huespedes', meal_groups: ['Ponentes', 'VIP'], days: [day(21)], services: ['cena'], payer: 'huesped', charge_when: 'cuenta', place: 'Terraza', position: 3 }),
    insert('food.event_offers', uuid(), { event_id: event, menu_id: menu, name: 'Equipo', audience: 'interna', meal_groups: ['Equipo'], position: 4 }),
  ]);
  // El evento de una oferta no cambia.
  const offer = (await q(`select id, revision from food.event_offers where name = 'Equipo'`))[0];
  await rejected([{ op: 'update', table: 'food.event_offers', id: offer.id, expectedRevision: Number(offer.revision), fields: { event_id: other } }], 'IMMUTABLE_FIELD');
});

test('Booking · ve las ofertas de huéspedes, nunca las internas', async () => {
  assert.deepEqual(await q(`select app from core.allowed_reads where name = 'food.event_offers_projection' order by app`), [{ app: 'booking' }, { app: 'food' }]);
  const rows = await q(`select name, menu_kind, payer, charge_when, meal_groups, active from food.event_offers_projection where event_id = $1 order by position`, [event]);
  assert.deepEqual(rows.map((r) => r.name), ['Menú', 'Barra del retiro', 'Cena de ponentes']);
  assert.deepEqual(rows[2], { name: 'Cena de ponentes', menu_kind: 'carta', payer: 'huesped', charge_when: 'cuenta', meal_groups: ['Ponentes', 'VIP'], active: false });
});

test('portal · Organizers sin internas y con lo provisional; Guests con las internas marcadas y solo lo validado', async () => {
  const org = await member('organizers', { reservation_id: reservation });
  // En Guests, el ámbito es la reserva y la ficha del huésped: la lectura lleva su guest_id.
  const guest = uuid();
  const guestUser = await member('guests', { reservation_id: reservation, guest_id: guest });
  await assert.rejects(read('organizers', await member('organizers', { reservation_id: uuid() }), 'food.portal_offers', { reservation_id: reservation }), /OUT_OF_SCOPE/);

  const forOrg = await read('organizers', org, 'food.portal_offers', { reservation_id: reservation });
  assert.deepEqual(forOrg.offers.map((o: any) => [o.name, o.audience]), [['Menú', 'huespedes'], ['Barra del retiro', 'huespedes'], ['Cena de ponentes', 'huespedes']]);
  assert.equal(forOrg.offers[0].provisional, true);
  assert.deepEqual(forOrg.offers[1].lines.map((l: any) => [l.code, l.name, l.price_cents]), [['A', 'Curry de verduras', 300]]);
  assert.equal(JSON.stringify(forOrg).includes('cost'), false, 'nada de costes');
  // Por día: la cena del 20 con el menú (sin platos hasta que cocina lo comparte) y la barra los dos días.
  const day20 = forOrg.days.find((d: any) => d.date === day(20));
  assert.deepEqual(day20.services.map((s: any) => s.type), ['cena']);
  assert.deepEqual(day20.services[0].included[0].options, []);
  assert.equal(day20.cartas.length, 1);

  const forGuests = await read('guests', guestUser, 'food.portal_offers', { reservation_id: reservation, guest_id: guest });
  // El menú cerrado sin validar no le llega al huésped; la interna, sí, marcada (Guests la filtra por portal_role).
  assert.deepEqual(forGuests.offers.map((o: any) => [o.name, o.audience]), [['Barra del retiro', 'huespedes'], ['Cena de ponentes', 'huespedes'], ['Equipo', 'interna']]);
  const equipo = forGuests.days.find((d: any) => d.date === day(20)).services[0].included[0];
  assert.deepEqual(equipo.options.map((o: any) => o.name), ['Curry de verduras'], 'la interna enseña sus platos');
});

test('visitantes por QR · solo las ofertas públicas del evento, sin grupos ni internas', async () => {
  // El código del evento lo pone Booking al confirmar; el de prueba no lo trae.
  const code = 'EVT_2026_901';
  await q(`update booking.events set code = $2 where id = $1`, [event, code]);
  const visitor = async (args: unknown) => (await q(`select food.visitor_offers($1::jsonb) as out`, [JSON.stringify(args)]))[0].out;
  assert.deepEqual((await visitor({ event_code: code })).offers, [], 'nada es público por defecto');
  const barra = (await q(`select id, revision from food.event_offers where name = 'Barra del retiro'`))[0];
  await ok([{ op: 'update', table: 'food.event_offers', id: barra.id, expectedRevision: Number(barra.revision), fields: { public: true } }]);
  const out = await visitor({ event_code: code });
  assert.deepEqual(out.offers.map((o: any) => [o.name, o.meal_groups]), [['Barra del retiro', []]]);
  assert.deepEqual(out.offers[0].lines.map((l: any) => l.price_cents), [300]);
  assert.deepEqual(await visitor({ event_code: 'NO_EXISTE' }), { event_code: 'NO_EXISTE', offers: [], days: [] }, 'un código desconocido no dice nada');
  // Lectura pública del núcleo: registrada y servida por core_public_read (la ruta HTTP es del kit).
  assert.deepEqual(await q(`select procedure from core.public_reads where name = 'food_visitor_offers'`), [{ procedure: 'food.visitor_offers' }]);
  const viaCore = await app.t.rpc('core_public_read', { p_name: 'food_visitor_offers', p_args: { event_code: code } }) as any;
  assert.deepEqual(viaCore.offers.map((o: any) => o.name), ['Barra del retiro']);
  // Una interna no puede ser pública.
  const equipo = (await q(`select id, revision from food.event_offers where name = 'Equipo'`))[0];
  await rejected([{ op: 'update', table: 'food.event_offers', id: equipo.id, expectedRevision: Number(equipo.revision), fields: { public: true } }], 'CONSTRAINT_VIOLATION');
});

test('lo que pide el evento · suma todas sus ofertas por ingrediente', async () => {
  // Menú: 20 raciones × 1 kg ÷ 10 = 2 kg; barra: 10 × 1 kg ÷ 10 = 1 kg; la interna repite el menú y no lo cuenta dos veces.
  const out = await app.call('/api/v1/read/food.event_needs', { body: { event_id: event } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.deepEqual(out.data.items.map((i: any) => [i.name, Number(i.quantity), i.unit, i.menus]), [['Arroz', 3, 'kg', 2]]);
});

test('dominio · textos y reglas de una oferta', () => {
  assert.equal(offerPayerText({ audience: 'huespedes', payer: 'organizador', charge_when: null }), 'Incluido: paga el organizador');
  assert.equal(offerPayerText({ audience: 'huespedes', payer: 'huesped', charge_when: 'cuenta' }), 'Paga el huésped, a su cuenta');
  assert.equal(offerPayerText({ audience: 'interna', payer: null, charge_when: null }), 'Interna');
  assert.equal(offerGroupsText({ audience: 'huespedes', meal_groups: [] }), 'Todos los huéspedes');
  assert.equal(offerGroupsText({ audience: 'interna', meal_groups: ['Equipo'] }), 'Equipo (interna)');
  assert.equal(offerProblem({ audience: 'huespedes', payer: 'organizador', charge_when: 'barra' })?.field, 'charge_when');
  assert.equal(offerProblem({ audience: 'huespedes', payer: 'huesped', charge_when: 'barra', meal_groups: ['x'.repeat(41)] })?.field, 'meal_groups');
  assert.equal(offerProblem({ audience: 'interna', services: ['brunch' as never] })?.field, 'services');
  assert.deepEqual(defaultOfferFields({ id: 'm', kind: 'carta', name: 'Barra' }, 'e'), { event_id: 'e', menu_id: 'm', name: 'Barra', audience: 'huespedes', meal_groups: [], payer: 'huesped', charge_when: 'barra', position: 2 });
  assert.equal(validateOperation({ op: 'update', table: 'food.event_offers', fields: { days: [] } })?.details.field, 'days');
});
