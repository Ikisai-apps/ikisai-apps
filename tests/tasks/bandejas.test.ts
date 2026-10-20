/**
 * Tasks · las cuentas puras de las bandejas (tanda 31, zona 3): `urgencyOf` y `requestBands` de «Por clasificar» (MUELA-057),
 * `reportStatus` y `reportStage` del Reporte (MUELA-064 y 073: lo descartado y la papelera nunca son «Resuelto») y
 * `labelUsage` / `personUsage` de Etiquetas (MUELA-061). Son de apps/tasks/public/bandejas.js (script clásico) y se cargan en
 * un contexto aislado, sin navegador.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.resolve(here, '../../apps/tasks/public/bandejas.js'), 'utf8');
const ctx: Record<string, any> = {};
vm.runInNewContext(`${source}\nObject.assign(this, { urgencyOf, compareUrgency, requestBands, reportStatus, reportStage, REPORT_TEXT, REPORT_STAGES, labelUsage, personUsage });`, ctx);
type Fn = (...args: any[]) => any;
const { urgencyOf, reportStatus, reportStage, labelUsage, personUsage } = ctx as { urgencyOf: Fn; reportStatus: Fn; reportStage: Fn; labelUsage: Fn; personUsage: Fn };
/** Lo que sale del contexto aislado, con los prototipos de aquí (deepStrictEqual compara prototipos). */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const requestBands: Fn = (...args) => plain(ctx.requestBands(...args));
const REPORT_TEXT = ctx.REPORT_TEXT as Record<string, string>;
const REPORT_STAGES = plain(ctx.REPORT_STAGES) as Array<{ key: string; label: string }>;

const TODAY = '2026-10-20';
const req = (id: string, extra: Record<string, unknown> = {}) => ({ id, source: 'central', kind: 'central.compliance_due', kind_label: null, title: id, priority: 'normal', due: null, status: 'pending', created_at: '2026-10-19T10:00:00Z', ...extra });

test('urgencyOf: crítica o vencida urge; alta o para dentro de dos días, pronto; lo demás, nada', () => {
  assert.equal(urgencyOf(req('a', { priority: 'critical' }), TODAY).tone, 'alert');
  assert.equal(urgencyOf(req('b', { due: '2026-10-19' }), TODAY).tone, 'alert');
  assert.equal(urgencyOf(req('c', { priority: 'high' }), TODAY).tone, 'warn');
  assert.equal(urgencyOf(req('d', { due: '2026-10-22' }), TODAY).tone, 'warn');
  assert.equal(urgencyOf(req('e', { due: '2026-10-23' }), TODAY).tone, null);
  assert.equal(urgencyOf(req('f'), TODAY).tone, null);
  assert.equal(urgencyOf(req('g', { due: '2026-10-21' }), TODAY).days, 1);
});

test('requestBands: una banda por app, la de la petición más urgente primero; dentro, por tipo y por urgencia', () => {
  const bands = requestBands([
    req('organizador', { source: 'booking', kind: 'booking.organizer_dates', created_at: '2026-10-18T08:00:00Z' }),
    req('averia', { source: 'feedback', kind: 'feedback.space.damage', priority: 'critical', created_at: '2026-10-20T07:00:00Z' }),
    req('limpieza', { source: 'feedback', kind: 'feedback.space.cleaning' }),
    req('vto-tarde', { due: '2026-10-30' }),
    req('vto-pronto', { due: '2026-10-21' }),
  ], TODAY);
  // La avería urgente de hace 3 h va antes que lo de Booking de hace días (el orden ya no es alfabético).
  assert.deepEqual(bands.map((b: any) => b.source), ['feedback', 'central', 'booking']);
  assert.deepEqual(bands.map((b: any) => [b.count, b.urgent, b.tone]), [[2, 1, 'alert'], [2, 1, 'warn'], [1, 0, null]]);
  assert.deepEqual(bands[0].kinds.map((k: any) => k.kind), ['feedback.space.damage', 'feedback.space.cleaning']);
  assert.deepEqual(bands[1].items.map((r: any) => r.id), ['vto-pronto', 'vto-tarde']);
  assert.deepEqual(requestBands([], TODAY), []);
});

test('reportStatus en sus seis estados; descartado y papelera nunca son «Resuelto»', () => {
  const pending = req('r', { source: 'feedback' });
  const task = { id: 'r', done: false, deleted_at: null };
  assert.equal(reportStatus(pending, null), 'pending');
  // Tras «Deshacer» (unrouteRequestOps a pendiente), la tarea está en la papelera pero manda la petición.
  assert.equal(reportStatus(pending, { ...task, deleted_at: '2026-10-20T10:00:00Z' }), 'pending');
  assert.equal(reportStatus({ ...pending, status: 'routed' }, task), 'open');
  assert.equal(reportStatus({ ...pending, status: 'routed' }, { ...task, done: true }), 'done');
  assert.equal(reportStatus({ ...pending, status: 'dismissed' }, { ...task, done: true, deleted_at: '2026-10-20T10:00:00Z' }), 'dismissed');
  assert.equal(reportStatus({ ...pending, status: 'routed' }, { ...task, done: true, deleted_at: '2026-10-20T10:00:00Z' }), 'deleted');
  // El lector no recibe las peticiones: con la tarea basta; sin nada, «No lo encuentro».
  assert.equal(reportStatus(null, task), 'open');
  assert.equal(reportStatus({ ...pending, status: 'routed' }, null), 'open');
  assert.equal(reportStatus(null, null), 'unknown');
  assert.deepEqual(['pending', 'open', 'done', 'dismissed', 'deleted', 'unknown'].map((s) => REPORT_TEXT[s]),
    ['Recibido', 'En marcha', 'Resuelto', 'No lo vamos a hacer', 'No lo vamos a hacer', 'No lo encuentro']);
  for (const s of ['dismissed', 'deleted', 'unknown']) assert.equal(reportStage(s), null, `${s} para el recorrido`);
  assert.deepEqual(REPORT_STAGES.map((s) => s.label), ['Recibido', 'En marcha', 'Resuelto']);
});

test('labelUsage y personUsage: solo las tareas abiertas, cada una una vez por etiqueta o persona', () => {
  const tasks = [
    { labels: ['obra', 'jardin'], owner: 'ana', ownerPerson: 'p1', people: ['p1', 'p2'], done: false },
    { labels: ['obra'], owner: null, ownerPerson: null, people: ['p2'], done: false },
    { labels: ['obra'], owner: 'ana', ownerPerson: 'p1', people: [], done: true },
    { labels: ['jardin'], deleted: true, done: false },
  ];
  assert.deepEqual(Object.fromEntries(labelUsage(tasks)), { obra: 2, jardin: 1, ana: 1 });
  assert.deepEqual(Object.fromEntries(personUsage(tasks)), { p1: 1, p2: 2 });
});
