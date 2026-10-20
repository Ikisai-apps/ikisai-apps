/**
 * Tasks · Inicio, «La cola» (MUELA-055): `priorityOf` y `homeQueue` de apps/tasks/public/home-priority.js, funciones puras
 * de la interfaz heredada (script clásico). Se cargan en un contexto aislado, sin navegador.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '../../apps/tasks/public/home-priority.js'), 'utf8');
const ctx: Record<string, any> = {};
vm.runInNewContext(`${source}\nthis.priorityOf = priorityOf; this.homeQueue = homeQueue; this.homeDaysBetween = homeDaysBetween;`, ctx);
const { priorityOf, homeQueue, homeDaysBetween } = ctx as { priorityOf: Function; homeQueue: Function; homeDaysBetween: Function };

const TODAY = '2026-10-20';
const NOW = Date.parse('2026-10-20T10:00:00+02:00');
const fresh = '2026-10-19T10:00:00Z';
const t = (title: string, extra: Record<string, unknown> = {}) => ({ title, done: false, blocked: 0, due: '', prio: 'normal', blocksOthers: 0, updatedAt: fresh, ...extra });

test('días entre fechas en el calendario (sin horas ni zonas)', () => {
  assert.equal(homeDaysBetween('2026-10-18', TODAY), 2);
  assert.equal(homeDaysBetween('2026-10-25', TODAY), -5);
  assert.equal(homeDaysBetween('2026-03-28', '2026-03-30'), 2); // cambio de hora en España
  assert.equal(homeDaysBetween('', TODAY), null);
});

test('hechas y bloqueadas no entran en la cola', () => {
  assert.equal(priorityOf(t('hecha', { done: true }), TODAY, NOW), null);
  assert.equal(priorityOf(t('bloqueada', { blocked: 1, due: '2026-10-01' }), TODAY, NOW), null);
});

test('el orden del 055: vencidas (más cuanto más tiempo), hoy, críticas, las que bloquean, paradas ≥ 10 días y el resto', () => {
  const items = [
    t('resto'),
    t('alta', { prio: 'high' }),
    t('parada', { updatedAt: '2026-10-05T10:00:00Z' }),
    t('parada poco', { updatedAt: '2026-10-15T10:00:00Z' }),
    t('bloquea a dos', { blocksOthers: 2 }),
    t('bloquea a una', { blocksOthers: 1 }),
    t('crítica', { prio: 'critical' }),
    t('hoy', { due: TODAY }),
    t('vencida ayer', { due: '2026-10-19' }),
    t('vencida hace diez', { due: '2026-10-10' }),
    t('mañana', { due: '2026-10-21' }),
  ];
  const order = homeQueue(items, TODAY, NOW).map((x: any) => x.item.title);
  assert.deepEqual(order, ['vencida hace diez', 'vencida ayer', 'hoy', 'crítica', 'bloquea a dos', 'bloquea a una', 'parada', 'alta', 'mañana', 'parada poco', 'resto']);
});

test('dentro de un escalón, la prioridad suma: una vencida crítica va delante de una vencida normal del mismo día', () => {
  const order = homeQueue([t('normal', { due: '2026-10-18' }), t('crítica', { due: '2026-10-18', prio: 'critical' })], TODAY, NOW).map((x: any) => x.item.title);
  assert.deepEqual(order, ['crítica', 'normal']);
  // A igual urgencia, la que vence antes y después por título.
  const same = homeQueue([t('b'), t('a')], TODAY, NOW).map((x: any) => x.item.title);
  assert.deepEqual(same, ['a', 'b']);
});
