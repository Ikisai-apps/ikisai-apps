/**
 * Organizers · versiones de la propuesta (pasada única, zona 2; Booking #610): cuál es la vigente, cuáles las anteriores
 * y la comparación línea a línea con el precio medio por persona.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { PortalProposal } from '../../apps/organizers/src/app/api.ts';
import { compareVersions, proposalVersions } from '../../apps/organizers/src/app/proposal-state.ts';

const line = (description: string, amount: number | null, unit = 'persona_noche') => ({ description, unit, quantity: 1, unit_amount: amount ?? 0, discount_pct: null, amount });
const proposal = (version: number, status: PortalProposal['status'], over: Partial<PortalProposal> = {}): PortalProposal => ({
  id: `p${version}`, version, status, nature: 'cerrada', start_date: '2027-03-12', end_date: '2027-03-14', persons: 20,
  subtotal: 0, adjustments: 0, vat_amount: 0, total: 2800, deposit_amount: 840, valid_until: null, includes: null, excludes: null,
  sent_at: null, decided_at: null, conditions: null, lines: [], ...over,
});

test('organizers · propuesta: la vigente es la aceptada antes que la enviada', () => {
  const v = proposalVersions([proposal(3, 'enviada'), proposal(2, 'aceptada'), proposal(1, 'sustituida', { superseded_by_version: 2 })]);
  assert.equal(v.current?.version, 2);
  assert.deepEqual(v.previous.map((p) => p.version), [3, 1]);
});

test('organizers · propuesta: sin aceptada, la enviada de versión más alta; las sustituidas y caducadas van a las anteriores', () => {
  const v = proposalVersions([proposal(1, 'sustituida', { superseded_by_version: 2 }), proposal(3, 'enviada'), proposal(2, 'caducada')]);
  assert.equal(v.current?.version, 3);
  assert.deepEqual(v.previous.map((p) => [p.version, p.status]), [[2, 'caducada'], [1, 'sustituida']]);
  const none = proposalVersions([proposal(1, 'caducada')]);
  assert.equal(none.current, null);
  assert.equal(none.previous.length, 1);
  assert.deepEqual(proposalVersions([]), { current: null, previous: [] });
});

test('organizers · propuesta: la comparación marca lo nuevo, lo quitado y la diferencia', () => {
  const a = proposal(2, 'enviada', { total: 3100, deposit_amount: 930, persons: 22, lines: [line('Estancia con pensión completa', 2640), line('Equipo de sonido', 150, 'estancia'), line('Sala grande ', 400, 'dia')] });
  const b = proposal(1, 'sustituida', { total: 2800, deposit_amount: 840, persons: 20, lines: [line('Estancia con pensión completa', 2400), line('sala grande', 400, 'dia'), line('Visita guiada', 120, 'estancia')] });
  const c = compareVersions(a, b);
  assert.deepEqual(c.lines.map((l) => [l.label, l.change]), [
    ['Estancia con pensión completa', 240],
    ['Equipo de sonido', 'nueva'],
    ['Sala grande ', 0],
    ['Visita guiada', 'quitada'],
  ]);
  assert.deepEqual(c.total, { a: 3100, b: 2800 });
  assert.deepEqual(c.deposit, { a: 930, b: 840 });
  assert.deepEqual(c.persons, { a: 22, b: 20 });
  assert.deepEqual(c.average, { a: 140.91, b: 140 });
});

test('organizers · propuesta: el precio medio es null si no hay personas', () => {
  const c = compareVersions(proposal(2, 'enviada', { persons: null }), proposal(1, 'sustituida', { persons: 0 }));
  assert.deepEqual(c.average, { a: null, b: null });
  assert.deepEqual(c.persons, { a: null, b: 0 });
});
