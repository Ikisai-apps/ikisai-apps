/**
 * Organizers · asistentes por lo que les falta (pasada única, zona 3): el grupo de cada asistente se deriva de sus datos,
 * su firma y su enlace vivo más reciente.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PortalLink } from '../../apps/organizers/src/app/api.ts';
import { linksByGuest, reasonOf, stageOf, STAGE_GROUPS } from '../../apps/organizers/src/app/guests-state.ts';

const link = (guest: string, createdAt: string, extra: Partial<PortalLink> = {}): PortalLink => ({
  linkId: `l-${guest}-${createdAt}`, app: 'guests', label: null, scope: { reservation_id: 'r', guest_id: guest },
  createdAt, lastUsedAt: null, revokedAt: null, validUntil: null, ...extra,
});
const g = (missing: string[], signed = false) => ({ missing, signed, display_name: 'Ana' });

test('organizers · la etapa sigue el orden: sin enlace, sin abrir, faltan datos, falta firmar y completo', () => {
  assert.equal(stageOf(g(['contact']), undefined, 'ses', true), 'sinenlace');
  assert.equal(stageOf(g(['contact']), link('a', '2027-01-01'), 'ses', true), 'sinabrir');
  assert.equal(stageOf(g(['contact']), link('a', '2027-01-01', { lastUsedAt: '2027-01-02' }), 'ses', true), 'faltan');
  assert.equal(stageOf(g([]), link('a', '2027-01-01', { lastUsedAt: '2027-01-02' }), 'ses', true), 'sinfirma');
  assert.equal(stageOf(g([], true), undefined, 'ses', true), 'completo');
  // Completo manda aunque no tenga enlace: no le falta nada.
  assert.equal(stageOf(g([], true), undefined, 'ses', false), 'completo');
  assert.deepEqual(STAGE_GROUPS.map((x) => x.key), ['sinenlace', 'sinabrir', 'faltan', 'sinfirma', 'completo']);
});

test('organizers · sin registro de viajeros nunca falta la firma', () => {
  const used = link('a', '2027-01-01', { lastUsedAt: '2027-01-02' });
  assert.equal(stageOf(g([]), used, 'operativo', true), 'completo');
  assert.equal(stageOf(g([]), undefined, 'operativo', false), 'completo');
  for (const l of [undefined, link('a', '2027-01-01'), used]) {
    for (const known of [true, false]) assert.notEqual(stageOf(g(['contact']), l, 'operativo', known), 'sinfirma');
  }
});

test('organizers · los enlaces revocados no cuentan y vale el más reciente', () => {
  const links = [
    link('a', '2027-01-01', { lastUsedAt: '2027-01-02' }),
    link('a', '2027-01-05'),
    link('b', '2027-01-03', { revokedAt: '2027-01-04' }),
  ];
  const map = linksByGuest(links);
  assert.equal(map.get('a')?.createdAt, '2027-01-05');
  assert.equal(map.has('b'), false);
  assert.equal(stageOf(g(['contact']), map.get('b'), 'ses', true), 'sinenlace');
  assert.equal(stageOf(g(['contact']), map.get('a'), 'ses', true), 'sinabrir');
});

test('organizers · sin saber los enlaces nunca se afirma «Sin enlace» ni «No han abierto»', () => {
  for (const l of [undefined, link('a', '2027-01-01')]) {
    assert.equal(stageOf(g(['contact']), l, 'ses', false), 'faltan');
    assert.equal(stageOf(g([]), l, 'ses', false), 'sinfirma');
  }
});

test('organizers · el porqué de cada fila', () => {
  const texts = { t: (s: string, v?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v?.[k] ?? '')), day: (iso: string) => iso.slice(5, 10), missing: (k: readonly string[]) => k.join('+') };
  assert.equal(reasonOf('sinenlace', g(['contact']), undefined, 'ses', texts), 'Aún no le has enviado su enlace');
  assert.equal(reasonOf('sinabrir', g(['contact']), link('a', '2027-01-03T10:00:00Z'), 'ses', texts), 'Enlace enviado el 01-03, sin abrir');
  assert.equal(reasonOf('faltan', g(['contact', 'birth_date']), undefined, 'ses', texts), 'Falta: contact+birth_date');
  assert.equal(reasonOf('sinfirma', g([]), undefined, 'ses', texts), 'La hará Ana al abrir su enlace o al llegar');
  assert.equal(reasonOf('completo', g([], true), undefined, 'ses', texts), 'Todo listo');
});
