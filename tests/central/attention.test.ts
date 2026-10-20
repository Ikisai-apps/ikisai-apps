/**
 * Central · «Lo que urge» de Inicio (`centralAttention`, MUELA-004 confirmado por VG en la 089): una sola cola con los
 * vencimientos y los indicadores en crítico o atención, en el orden bloquea > crítico > vencido > atención > vence pronto,
 * sin duplicados y con los desempates de Core Sevilla. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attentionSummary, centralAttention, dueRank, type AttentionKpi, type DueItem } from '../../supabase/functions/_domain/central/mod.ts';

const due = (id: string, over: Partial<DueItem> = {}): DueItem => ({
  source: 'requirement', id, parentId: null, code: null, title: id, dueOn: '2026-10-25', daysLeft: 5, state: 'por_vencer', risk: null, blocksOperation: false, ...over,
});
const kpi = (key: string, state: AttentionKpi['state'], app = 'booking', label = key): AttentionKpi => ({ app, kpi: key, label, state, value: 0, unit: 'count', period: '2026-10', link: null });

test('orden del 004: bloquea, crítico, vencido, atención y vence pronto', () => {
  const out = centralAttention(
    [due('pronto'), due('vencido', { state: 'vencido', dueOn: '2026-10-01' }), due('bloquea', { blocksOperation: true, dueOn: '2026-11-01' })],
    [kpi('booking.atencion', 'atencion'), kpi('booking.critico', 'critico'), kpi('booking.ok', 'ok'), kpi('booking.sin', null)],
  );
  assert.deepEqual(out.map((i) => i.key), ['due:requirement:bloquea', 'kpi:booking.critico', 'due:requirement:vencido', 'kpi:booking.atencion', 'due:requirement:pronto']);
  assert.deepEqual(out.map((i) => i.rank), [1, 2, 3, 4, 5]);
  // Los indicadores en objetivo o sin estado no entran.
  assert.equal(out.some((i) => i.key === 'kpi:booking.ok' || i.key === 'kpi:booking.sin'), false);
});

test('lo que bloquea va primero aunque aún no haya vencido, y vencido y bloqueante sigue siendo «bloquea»', () => {
  assert.equal(dueRank({ blocksOperation: true, state: 'por_vencer' }), 1);
  assert.equal(dueRank({ blocksOperation: true, state: 'vencido' }), 1);
  assert.equal(dueRank({ blocksOperation: false, state: 'vencido' }), 3);
  assert.equal(dueRank({ blocksOperation: false, state: 'por_vencer' }), 5);
});

test('desempates (Core Sevilla): vencimientos por fecha y título; indicadores por app y etiqueta', () => {
  const out = centralAttention(
    [due('b', { dueOn: '2026-10-22' }), due('a', { dueOn: '2026-10-22' }), due('c', { dueOn: '2026-10-21' })],
    [kpi('tasks.x', 'critico', 'tasks', 'Zeta'), kpi('booking.y', 'critico', 'booking', 'Beta'), kpi('booking.z', 'critico', 'booking', 'Alfa'), kpi('central.w', 'critico', 'central', 'Omega')],
  );
  assert.deepEqual(out.map((i) => i.key), ['kpi:central.w', 'kpi:booking.z', 'kpi:booking.y', 'kpi:tasks.x', 'due:requirement:c', 'due:requirement:a', 'due:requirement:b']);
});

test('sin duplicados por clave: la misma cosa entra una vez', () => {
  const out = centralAttention([due('x'), due('x'), due('x', { source: 'key_document' })], [kpi('booking.a', 'critico'), kpi('booking.a', 'critico')]);
  // Misma fecha y título: se queda el orden de llegada (orden estable).
  assert.deepEqual(out.map((i) => i.key), ['kpi:booking.a', 'due:requirement:x', 'due:key_document:x']);
});

test('resumen escrito de la cola', () => {
  const out = centralAttention([due('a', { blocksOperation: true }), due('b'), due('c')], [kpi('booking.k', 'critico'), kpi('booking.j', 'atencion')]);
  assert.equal(attentionSummary(out), '1 bloquea · 1 crítico · 1 en atención · 2 vencen pronto');
  assert.equal(attentionSummary([]), '');
});
