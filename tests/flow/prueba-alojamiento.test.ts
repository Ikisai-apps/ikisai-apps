/**
 * Flow · recorrido «Prueba del alojamiento (finde)» (migración 0948), sobre PGlite: publicado; cada «Hacer» de pantalla es un
 * tramo anclado a Guests o Booking y cada «Debería pasar» un registro sí/no con nota; el Guiado de cada app ve sus pasos y su
 * confirmación cierra el tramo. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createFlowApp, FLOW_ORIGINS } from '../../supabase/functions/flow-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/flow/mod.ts';

const ORIGIN = FLOW_ORIGINS[0]!;
let app: TestApp;
let seq = 0;

test.before(async () => {
  app = await createTestApp({ app: 'flow', slug: 'flow-api', origin: ORIGIN, createHandler: (config) => createFlowApp({ ...config, origins: [ORIGIN] }) });
});
test.after(async () => { await app.close(); });

const commit = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pa-${++seq}-${crypto.randomUUID()}`, operations } });
async function ok(operations: unknown[]) { const r = await commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.results[0].result; }
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });

test('prueba del alojamiento · publicada (v2, 0956), 35 tramos: 15 a pantallas de Guests y Booking y 20 comprobaciones sí/no con nota', async () => {
  const def = (await app.t.db.query<any>(`select d.id, v.id as version, v.status from flow.definitions d join flow.definition_versions v on v.definition_id = d.id where d.key = 'prueba_alojamiento' order by v.version desc limit 1`)).rows[0];
  assert.equal(def.status, 'published');
  const stages = (await app.t.db.query<any>(`select position, kind, target_app, target_anchor from flow.definition_stages where version_id = $1 order by position`, [def.version])).rows;
  assert.equal(stages.length, 35);
  // v2: se entra por ven.ikisai.com (la página del evento) y la carta se abre desde allí.
  assert.equal(stages.find((s: any) => s.position === 6).target_anchor, 'guests.visitante');
  assert.ok(stages.some((s: any) => s.target_anchor === 'guests.visitante.recorrido.carta'));
  assert.equal(stages.filter((s: any) => s.kind === 'record').length, 20);
  assert.ok(stages.some((s: any) => s.target_anchor === 'booking.recepcion.cobrar') && stages.some((s: any) => s.target_anchor === 'guests.visitante.alojate.pagar'));
  const steps = (await app.t.db.query<any>(`select key, input_type, essential from flow.definition_steps where version_id = $1`, [def.version])).rows;
  assert.equal(steps.filter((s: any) => s.key === 'ok' && s.input_type === 'boolean' && s.essential).length, 20);
  assert.equal(steps.filter((s: any) => s.key === 'codigo').length, 1);
});

test('prueba del alojamiento · el Guiado de Guests ve sus pasos y su confirmación cierra el tramo', async () => {
  const version = (await app.t.db.query<any>(`select v.id from flow.definitions d join flow.definition_versions v on v.definition_id = d.id where d.key = 'prueba_alojamiento' order by v.version desc limit 1`)).rows[0].id;
  const ex = crypto.randomUUID();
  await ok([call(PROCEDURES.startExecution, { execution_id: ex, version_id: version, mode: 'run' })]);
  // Paso 1 (Booking: alta y confirmar): «Hecho»; su comprobación con el código del evento.
  for (const p of [1, 2]) { await ok([call(PROCEDURES.startStage, { execution_id: ex, position: p })]); await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: p, status: 'done' })]); }
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 3 })]);
  await ok([call(PROCEDURES.saveStageValues, { execution_id: ex, position: 3, values: { codigo: 'ABCD2345', ok: true } })]);
  await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: 3, status: 'done' })]);
  const read = await app.call('/api/v1/guide-read', { body: { execution_id: ex, app: 'guests' } });
  assert.equal(read.status, 200, JSON.stringify(read.data));
  const guests = read.data.steps.filter((s: any) => s.app === 'guests');
  assert.ok(guests.length >= 6, JSON.stringify(guests.map((s: any) => s.anchor)));
  assert.ok(read.data.steps.every((s: any) => s.app === 'guests' || s.app === null));
  // Tramos 4 y 5 (paso 2 de Booking y su comprobación) se cierran; el 6 es «Entrar sin sesión» en Guests: lo cierra su confirmación.
  for (const p of [4, 5]) { await ok([call(PROCEDURES.startStage, { execution_id: ex, position: p })]); await ok([call(PROCEDURES.finishStage, { execution_id: ex, position: p, status: 'done' })]); }
  await ok([call(PROCEDURES.startStage, { execution_id: ex, position: 6 })]);
  const entrar = guests.find((s: any) => s.anchor === 'guests.visitante');
  const c = await app.call('/api/v1/guide-confirm', { body: { requestId: `pa-${ex}`, execution_id: ex, step_id: entrar.id, how: 'event' } });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  const stages = (await app.t.db.query<any>(`select stages from flow.executions where id = $1`, [ex])).rows[0].stages;
  assert.equal(stages.find((s: any) => s.position === 6).status, 'done');
});
