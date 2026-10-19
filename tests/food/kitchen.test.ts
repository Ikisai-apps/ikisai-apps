/**
 * Food · capa pura de Cocina y Preparación (tanda 27): días y servicios de los pasos, atrasado, siguiente, cifras,
 * reparto, el círculo del responsable y las fases de los servicios. Hora local fija (Europe/Madrid, `TZ` de la CI).
 *
 * Cómo correrlo:   npx tsx --test tests/food/kitchen.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOverdue, localDayKey, nextResponsible, nextStep, prepStats, servicePhases, shareOut, shiftTime, stepDay, stepService, untilText,
} from '../../supabase/functions/_domain/food/kitchen.ts';

const services = [
  { id: 's-cena', service_date: '2026-10-20', service_time: '20:30:00', service_type: 'cena' as const, position: 2 },
  { id: 's-comida', service_date: '2026-10-20', service_time: '14:00:00', service_type: 'comida' as const, position: 1 },
  { id: 's-sin-hora', service_date: '2026-10-20', service_time: null, service_type: 'merienda' as const, position: 3 },
];
const items = [{ id: 'i-curry', service_id: 's-cena' }, { id: 'i-sopa', service_id: 's-comida' }];
const step = (over: Record<string, unknown>) => ({ id: crypto.randomUUID(), menu_item_id: null, scheduled_date: null, scheduled_time: null, done: false, ...over });
const at = (iso: string) => new Date(iso);

test('el día y el servicio de un paso: el escrito manda; si no, el de su servicio; sin nada, «Sin día»', () => {
  const ofDish = step({ menu_item_id: 'i-curry' });
  assert.equal(stepService(ofDish, items, services)?.id, 's-cena');
  assert.equal(stepDay(ofDish, items, services), '2026-10-20');
  assert.equal(stepDay(step({ menu_item_id: 'i-curry', scheduled_date: '2026-10-19' }), items, services), '2026-10-19');
  assert.equal(stepDay(step({}), items, services), null);
  assert.equal(stepService(step({ menu_item_id: 'i-borrado' }), items, services), null);
});

test('atrasado: sin hacer y con la hora pasada; sin hora, si el día pasó; sin día o hecho, nunca', () => {
  const now = at('2026-10-20T15:00:00');
  assert.equal(isOverdue(step({ scheduled_time: '14:30' }), '2026-10-20', now), true);
  assert.equal(isOverdue(step({ scheduled_time: '15:30' }), '2026-10-20', now), false);
  assert.equal(isOverdue(step({ scheduled_time: '14:30', done: true }), '2026-10-20', now), false);
  assert.equal(isOverdue(step({}), '2026-10-20', now), false); // hoy sin hora: aún no
  assert.equal(isOverdue(step({}), '2026-10-19', now), true);
  assert.equal(isOverdue(step({}), null, now), false);
});

test('cifras: pendientes, atrasados y % hecho; siguiente: el primero sin hacer de hoy que no va atrasado', () => {
  const now = at('2026-10-20T15:00:00');
  const steps = [
    step({ scheduled_date: '2026-10-20', scheduled_time: '10:00', done: true, text: 'a' }),
    step({ scheduled_date: '2026-10-20', scheduled_time: '12:00', text: 'b' }), // atrasado
    step({ scheduled_date: '2026-10-20', scheduled_time: '18:00', text: 'c' }),
    step({ scheduled_date: '2026-10-20', scheduled_time: '16:00', text: 'd' }),
    step({ text: 'sin día' }),
  ];
  const dayOf = (s: { scheduled_date: string | null }) => s.scheduled_date;
  assert.deepEqual(prepStats(steps, dayOf, now), { total: 5, done: 1, pending: 4, overdue: 1, pct: 20 });
  assert.equal((nextStep(steps, dayOf, now) as unknown as { text: string }).text, 'd');
  assert.deepEqual(prepStats([], dayOf, now), { total: 0, done: 0, pending: 0, overdue: 0, pct: 0 });
});

test('servicios del día: el primero que no ha pasado (hora + 90 min) es «ahora»; sin hora, al final', () => {
  const phases = (iso: string, day = '2026-10-20') => servicePhases(services, day, at(iso)).map((p) => `${p.service.id}:${p.phase}`);
  assert.deepEqual(phases('2026-10-20T11:00:00'), ['s-comida:ahora', 's-cena:despues', 's-sin-hora:despues']);
  assert.deepEqual(phases('2026-10-20T15:00:00'), ['s-comida:ahora', 's-cena:despues', 's-sin-hora:despues']); // 14:00 + 90 min
  assert.deepEqual(phases('2026-10-20T15:31:00'), ['s-comida:hecho', 's-cena:ahora', 's-sin-hora:despues']);
  assert.deepEqual(phases('2026-10-20T23:00:00'), ['s-comida:hecho', 's-cena:hecho', 's-sin-hora:ahora']);
  assert.deepEqual(phases('2026-10-19T12:00:00'), ['s-comida:despues', 's-cena:despues', 's-sin-hora:despues']);
  assert.deepEqual(phases('2026-10-21T12:00:00'), ['s-comida:hecho', 's-cena:hecho', 's-sin-hora:hecho']);
});

test('textos de tiempo, reparto, círculo del responsable y mover la hora', () => {
  const now = at('2026-10-20T11:20:00');
  assert.equal(untilText('2026-10-20', '14:00:00', now), 'en 2 h 40 min');
  assert.equal(untilText('2026-10-20', '11:35', now), 'en 15 min');
  assert.equal(untilText('2026-10-20', '11:00', now), 'empezó hace 20 min');
  assert.equal(untilText('2026-10-20', '12:20', now), 'en 1 h');
  assert.equal(untilText('2026-10-20', null, now), null);
  assert.deepEqual(shareOut([{ responsible: 'Tomás' }, { responsible: 'Marga' }, { responsible: ' Marga ' }, { responsible: null }, { responsible: 'Ana', deleted_at: 'x' }]),
    [{ name: 'Marga', count: 2 }, { name: 'Tomás', count: 1 }]);
  assert.equal(nextResponsible(null, ['Marga', 'Tomás']), 'Marga');
  assert.equal(nextResponsible('Marga', ['Marga', 'Tomás']), 'Tomás');
  assert.equal(nextResponsible('Tomás', ['Marga', 'Tomás']), null);
  assert.equal(nextResponsible(null, []), null);
  assert.equal(shiftTime('19:00:00', 30), '19:30');
  assert.equal(shiftTime('00:20', -60), '00:00');
  assert.equal(shiftTime('23:40', 60), '23:59');
  assert.equal(shiftTime(null, -30), '11:30');
  assert.equal(localDayKey(at('2026-10-20T23:59:00')), '2026-10-20');
});
