/**
 * Tasks · la cuenta única de los proyectos (MUELA-041, hallazgo 8; tanda 31): `whenOf`, `projectStats`, `healthOf` y
 * `attentionOrder` de apps/tasks/public/project-stats.js, funciones puras de la interfaz heredada (script clásico). Las usan
 * las portadas de Proyectos, la ficha del proyecto y el tablero. Se cargan en un contexto aislado, sin navegador.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '../../apps/tasks/public/project-stats.js'), 'utf8');
const ctx: Record<string, any> = {};
vm.runInNewContext(`${source}\nthis.whenOf = whenOf; this.projectStats = projectStats; this.healthOf = healthOf; this.attentionOrder = attentionOrder;`, ctx);
type Fn = (...args: any[]) => any;
const { whenOf, projectStats, healthOf, attentionOrder } = ctx as { whenOf: Fn; projectStats: Fn; healthOf: Fn; attentionOrder: Fn };

const TODAY = '2026-10-20';
const task = (id: string, extra: Record<string, unknown> = {}) => ({ id, text: id, done: false, due: '', parentId: null, order: 1024, deleted: false, ...extra });
const project = (tasks: any[], extra: Record<string, unknown> = {}) => ({ id: 'p', title: 'Obra', status: 'active', due: '', system: null, tasks, ...extra });

test('whenOf: el punto de cada tarea, en el calendario de casa', () => {
  const p = project([
    task('vieja', { due: '2026-10-18' }), task('hoy', { due: TODAY }), task('manana', { due: '2026-10-21' }),
    task('semana', { due: '2026-10-27' }), task('luego', { due: '2026-10-28' }), task('nada'), task('hecha', { due: '2026-10-01', done: true }),
  ]);
  assert.deepEqual(p.tasks.map((t: any) => whenOf(p, t, TODAY)), ['vencida', 'hoy', 'manana', 'semana', 'luego', 'sinfecha', 'hecha']);
});

test('whenOf: una madre vencida es vencida aunque sus hijas no tengan fecha; sus hijas, también', () => {
  const p = project([task('madre', { due: '2026-10-10' }), task('h1', { parentId: 'madre' }), task('h2', { parentId: 'madre', done: true })]);
  assert.equal(whenOf(p, p.tasks[0], TODAY), 'vencida');
  assert.equal(whenOf(p, p.tasks[1], TODAY), 'vencida');
  assert.equal(whenOf(p, p.tasks[2], TODAY), 'hecha');
  // Una madre sin fecha toma la más cercana de sus hijas pendientes; con todas hechas, está hecha.
  const q = project([task('m'), task('a', { parentId: 'm', due: '2026-10-25' }), task('b', { parentId: 'm', due: '2026-10-21' }), task('c', { parentId: 'm', due: '2026-10-01', done: true })]);
  assert.equal(whenOf(q, q.tasks[0], TODAY), 'manana');
  const r = project([task('m'), task('a', { parentId: 'm', done: true })]);
  assert.equal(whenOf(r, r.tasks[0], TODAY), 'hecha');
});

test('projectStats: pendientes por hojas, vencidas por raíces (una vez cada una) y la cola', () => {
  const p = project([
    task('madre', { due: '2026-10-10', order: 1 }), task('h1', { parentId: 'madre' }), task('h2', { parentId: 'madre', due: '2026-10-12' }),
    task('suelta', { due: '2026-10-19', order: 2 }), task('mañana', { due: '2026-10-21', order: 3 }), task('sin', { order: 4 }),
    task('hecha', { done: true, order: 5 }), task('borrada', { deleted: true, due: '2026-01-01' }),
  ], { due: '2026-10-25' });
  const s = projectStats(p, TODAY);
  assert.equal(s.total, 6);
  assert.equal(s.open, 5);
  assert.equal(s.pct, 17);
  assert.equal(s.late, 2, 'la madre vencida y su hija vencida cuentan una vez');
  assert.equal(s.dueIn, 5);
  assert.deepEqual(s.queue.map((t: any) => t.id), ['madre', 'suelta', 'mañana', 'sin']);
  assert.equal(s.whenOf.madre, 'vencida');
});

test('healthOf: Entrada, pausa, atención, semana, hecho y en marcha', () => {
  const base = { inbox: false, paused: false, open: 2, total: 3, late: 0, dueIn: null };
  assert.equal(healthOf({ ...base, inbox: true }), 'entrada');
  assert.equal(healthOf({ ...base, paused: true, late: 3 }), 'pausa');
  assert.equal(healthOf({ ...base, late: 1 }), 'atencion');
  assert.equal(healthOf({ ...base, dueIn: -1 }), 'atencion');
  assert.equal(healthOf({ ...base, dueIn: 7 }), 'semana');
  assert.equal(healthOf({ ...base, dueIn: 8 }), 'marcha');
  assert.equal(healthOf({ ...base, open: 0 }), 'hecho');
  assert.equal(healthOf({ ...base, open: 0, total: 0 }), 'marcha');
});

test('attentionOrder: Entrada, el fijado y después por atención y fecha; a igualdad, el orden de siempre', () => {
  const s = (id: string, extra: Record<string, unknown> = {}) => ({ stats: { id, inbox: false, paused: false, open: 1, total: 1, late: 0, dueIn: null, ...extra }, order: 0 });
  const list = [
    { ...s('marcha-b'), order: 2 }, { ...s('marcha-a'), order: 1 }, s('pausa', { paused: true }), s('semana', { dueIn: 3 }),
    s('fijado', { paused: true }), s('atencion-tarde', { late: 1, dueIn: 9 }), s('atencion', { late: 2, dueIn: -2 }), s('entrada', { inbox: true }),
  ];
  assert.deepEqual([...attentionOrder(list, 'fijado')].map((x: any) => x.stats.id), ['entrada', 'fijado', 'atencion', 'atencion-tarde', 'semana', 'marcha-a', 'marcha-b', 'pausa']);
});
