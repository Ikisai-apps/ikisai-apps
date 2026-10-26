/**
 * Organizers · ámbito de las filas propias: por el permiso de cada reserva (`scopes.grants`) o por «todos», con el que
 * dirección figura como coorganizadora de cualquier retiro (decisión de VG del 26-10-2026; peticiones B20 y K8). Y lo que
 * pinta Mis retiros con ese ámbito (buscador y marca) y el botón «Verlo como huésped» (B21).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasAllReservations, inReservationScope, proposalReservation, proposalVisible, TABLES, TEAM_PROPOSAL_KIND, validateOperations, visibleRow, writeMode } from '../../supabase/functions/_domain/organizers/mod.ts';
import { isCoorganizer, matchesRetreat } from '../../apps/organizers/src/app/journey.ts';
import { guestViewUrl } from '../../apps/organizers/src/app/guest-view.ts';

const R1 = '00000000-0000-4000-8000-000000000001';
const R2 = '00000000-0000-4000-8000-000000000002';
const own = { role: 'editor', scopes: { grants: [{ reservation_id: R1 }] } };
const all = { role: 'editor', scopes: { grants: [{ all: true }] } };

test('organizers · ámbito: el permiso propio da solo su reserva', () => {
  assert.equal(hasAllReservations(own), false);
  assert.equal(inReservationScope(own, R1), true);
  assert.equal(inReservationScope(own, R2), false);
  assert.equal(visibleRow(TABLES.offers, { reservation_id: R2 }, own), false);
});

test('organizers · ámbito: «todos» ve cualquier reserva, pero sin permiso propio propone en vez de escribir (VG, 26-10)', () => {
  assert.equal(hasAllReservations(all), true);
  assert.equal(inReservationScope(all, R2), true);
  assert.equal(visibleRow(TABLES.offers, { reservation_id: R2 }, all), true);
  const insert = { op: 'insert' as const, table: TABLES.offers, id: '00000000-0000-4000-8000-0000000000a1', fields: { reservation_id: R2, name: 'Masaje', price: 30 } };
  assert.equal(validateOperations([insert], all)?.code, 'SUGGESTION_REQUIRED');
  assert.equal(validateOperations([insert], all, undefined, null, 'proposal'), null);
  assert.equal(validateOperations([insert], own)?.code, 'OUT_OF_SCOPE');
  assert.equal(validateOperations([insert], own, undefined, null, 'proposal')?.code, 'OUT_OF_SCOPE');
  assert.equal(writeMode(all, R2), 'propose');
  assert.equal(writeMode(own, R1), 'write');
  assert.equal(writeMode(own, R2), null);
  const both = { role: 'editor', scopes: { grants: [{ reservation_id: R1 }, { all: true }] } };
  assert.equal(writeMode(both, R1), 'write', 'dirección que además organiza ese retiro escribe directo');
  assert.equal(validateOperations([{ ...insert, fields: { ...insert.fields, reservation_id: R1 } }], both), null);
});

test('organizers · propuestas del equipo: las ve y decide quien tiene permiso propio sobre su retiro', () => {
  const proposal = { kind: TEAM_PROPOSAL_KIND, detail: { reservation_id: R1 } };
  assert.equal(proposalReservation(proposal), R1);
  assert.equal(proposalReservation({ kind: 'otra', detail: { reservation_id: R1 } }), null);
  assert.equal(proposalReservation({ kind: TEAM_PROPOSAL_KIND, detail: null }), null);
  assert.equal(proposalVisible(proposal, own), true);
  assert.equal(proposalVisible({ ...proposal, detail: { reservation_id: R2 } }, own), false);
  assert.equal(proposalVisible(proposal, all), false, 'dirección no decide sus propias propuestas');
});

test('organizers · ámbito: solo vale «all: true», y sin pertenencia no hay nada', () => {
  assert.equal(hasAllReservations({ scopes: { grants: [{ all: 'true' }] } }), false);
  assert.equal(hasAllReservations({ scopes: { grants: [{ all: 1 }] } }), false);
  assert.equal(hasAllReservations({ scopes: null }), false);
  assert.equal(hasAllReservations(null), false);
  assert.equal(inReservationScope(undefined, R1), false);
});

test('organizers · Mis retiros con «todos»: buscador por título o código, sin acentos ni mayúsculas', () => {
  const r = { title: 'Taller de cerámica', code: 'RSV_2026_042' };
  assert.equal(matchesRetreat(r, ''), true);
  assert.equal(matchesRetreat(r, '   '), true);
  assert.equal(matchesRetreat(r, 'CERAMICA'), true);
  assert.equal(matchesRetreat(r, 'cerámica'), true);
  assert.equal(matchesRetreat(r, '2026_042'), true);
  assert.equal(matchesRetreat(r, 'yoga'), false);
  assert.equal(matchesRetreat({ title: 'Yoga', code: null }, 'rsv'), false);
});

test('organizers · coorganizadora solo con as = coorganizer; sin el dato, como siempre', () => {
  assert.equal(isCoorganizer({ as: 'coorganizer' }), true);
  assert.equal(isCoorganizer({ as: 'organizer' }), false);
  assert.equal(isCoorganizer({}), false);
});

test('organizers · «Verlo como huésped»: solo con ficha de huésped y con Guests en el catálogo', () => {
  const catalog = { items: [{ id: 'organizers', name: 'Organizers', domain: 'organizers.ikisai.com' }, { id: 'guests', name: 'Guests', domain: 'guests.ikisai.com' }] };
  assert.equal(guestViewUrl(catalog, R1, 'g-1'), `https://guests.ikisai.com/#/r/${R1}`);
  assert.equal(guestViewUrl(catalog, R1.toUpperCase(), 'g-1'), `https://guests.ikisai.com/#/r/${R1}`, 'en minúsculas (Gu1)');
  assert.equal(guestViewUrl(catalog, R1, null), null, 'sin ficha de huésped en ese retiro');
  assert.equal(guestViewUrl(catalog, R1, undefined), null, 'Booking aún no lo publica');
  assert.equal(guestViewUrl({ items: [catalog.items[0]!] }, R1, 'g-1'), null, 'la cuenta no tiene Guests');
  assert.equal(guestViewUrl(null, R1, 'g-1'), null, 'sin catálogo (sin red)');
});
