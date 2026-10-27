/** Central · Revisión › Uso y cobertura (V0.2, 27-10): reglas puras y tabla de decisiones (`1517`). Datos ficticios. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  COVERAGE_DECISIONS_TABLE, coverageCounts, coverageRows, coverageState, inventorySources, screenOf, type CoverageSource,
} from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { body: { requestId: `coverage-${++seq}`, operations }, ...(token ? { token } : {}) });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('dominio · estado de cobertura: lo no instrumentado es desconocido, los recorridos mandan, y luego el uso', () => {
  const used: CoverageSource = { app: 'tasks', featureId: 'tasks.lista.filtro', label: 'Filtro', last30: { exposures: 9, activations: 4, people: 2, target: { activations: 3 }, others: { activations: 1 } } };
  const seen: CoverageSource = { app: 'tasks', featureId: 'tasks.lista.exportar', label: 'Exportar', last30: { exposures: 3, activations: 0 } };
  const none: CoverageSource = { app: 'tasks', featureId: 'tasks.ajustes.color', label: 'Color', last30: {} };
  const bare: CoverageSource = { app: 'tasks', featureId: 'tasks:src/x.ts:12', label: 'Nota', screen: 'tasks.ficha', instrumented: false };
  assert.equal(coverageState(used, []), 'usado_fuera');
  assert.equal(coverageState(used, ['Barra · v1']), 'requerido');
  assert.equal(coverageState(seen, []), 'se_ve_sin_uso');
  assert.equal(coverageState(none, []), 'nadie_llega');
  assert.equal(coverageState(bare, ['Barra · v1']), 'sin_instrumentar', 'sin medir no se sabe, aunque un recorrido lo nombre');
  assert.equal(screenOf(used), 'tasks.lista');
  assert.equal(screenOf(bare), 'tasks.ficha');

  const decisions = [
    { id: 'd1', revision: 1, feature_id: 'tasks.lista.exportar', app: 'tasks', decision: 'retirar' },
    { id: 'd2', revision: 2, feature_id: 'tasks.lista.filtro', app: 'tasks', decision: 'mantener', deleted_at: '2026-10-01T00:00:00Z' },
  ];
  const rows = coverageRows([used, seen, none, bare, { ...seen, instrumented: false }, { app: 'central', featureId: 'central.persona.x', label: 'X' }], (id) => (id === 'tasks.lista.filtro' ? ['Barra · v1'] : []), decisions, ['central', 'tasks']);
  // Central antes que Tasks; dentro, por estado (nadie llega, se ve sin uso, sin instrumentar, usado fuera, requerido).
  assert.deepEqual(rows.map((r) => [r.featureId, r.state]), [
    ['central.persona.x', 'nadie_llega'], ['tasks.ajustes.color', 'nadie_llega'], ['tasks.lista.exportar', 'se_ve_sin_uso'],
    ['tasks:src/x.ts:12', 'sin_instrumentar'], ['tasks.lista.filtro', 'requerido'],
  ]);
  assert.equal(rows.find((r) => r.featureId === 'tasks.lista.exportar')!.decision?.decision, 'retirar');
  assert.equal(rows.find((r) => r.featureId === 'tasks.lista.filtro')!.decision, null, 'la decisión borrada no cuenta');
  assert.deepEqual(rows.find((r) => r.featureId === 'tasks.lista.filtro')!.uses, { target: 3, others: 1, total: 4, people: 2, exposures: 9 });
  assert.deepEqual(coverageCounts(rows), { nadie_llega: 2, se_ve_sin_uso: 1, sin_instrumentar: 1, usado_fuera: 0, requerido: 1 });
});

test('dominio · inventario de UI-kit: lo inventariado cuenta como medido; lo demás, sin instrumentar', () => {
  assert.deepEqual(inventorySources(null), []);
  const out = inventorySources({
    fields: [{ fieldId: 'central.persona.iniciales', app: 'central', screen: 'persona', anchorId: 'central.persona.editar.iniciales', label: 'Iniciales' }],
    fieldsUninstrumented: [{ app: 'food', screen: null, file: 'src/ui/x.ts', line: 40, tag: 'input', label: null }],
  });
  assert.deepEqual(out.map((s) => [s.featureId, s.screen, s.instrumented, s.label]), [
    ['central.persona.editar.iniciales', 'central.persona', true, 'Iniciales'],
    ['food:src/ui/x.ts:40', 'food.(sin pantalla)', false, 'input'],
  ]);
});

test('decisiones de cobertura (1517): solo el owner, una viva por función y solo las cuatro', async () => {
  const id = crypto.randomUUID();
  const fields = { app: 'tasks', feature_id: 'tasks.lista.exportar', decision: 'retirar', note: 'Nadie la usa desde septiembre.' };
  const ok = await commit([{ op: 'insert', table: COVERAGE_DECISIONS_TABLE, id, fields }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await commit([{ op: 'insert', table: COVERAGE_DECISIONS_TABLE, id: crypto.randomUUID(), fields: { ...fields, feature_id: 'tasks.lista.otra' } }], app.tokens.editor)).status, 403);
  assert.notEqual((await commit([{ op: 'insert', table: COVERAGE_DECISIONS_TABLE, id: crypto.randomUUID(), fields }])).status, 200, 'una viva por función');
  const bad = await commit([{ op: 'insert', table: COVERAGE_DECISIONS_TABLE, id: crypto.randomUUID(), fields: { ...fields, feature_id: 'tasks.lista.tercera', decision: 'borrar' } }]);
  assert.equal(bad.status, 422, JSON.stringify(bad.data));
  // Cambiar de idea y quitarla: se puede; después, otra viva para la misma función.
  assert.equal((await commit([{ op: 'update', table: COVERAGE_DECISIONS_TABLE, id, expectedRevision: 1, fields: { decision: 'simplificar' } }])).status, 200);
  assert.equal((await commit([{ op: 'delete', table: COVERAGE_DECISIONS_TABLE, id, expectedRevision: 2 }])).status, 200);
  assert.equal((await commit([{ op: 'insert', table: COVERAGE_DECISIONS_TABLE, id: crypto.randomUUID(), fields: { ...fields, decision: 'mantener' } }])).status, 200);
  // Las lee solo el owner.
  const snap = await app.t.rpc('core_snapshot_table', { p_app: 'central', p_role: 'editor', p_table: COVERAGE_DECISIONS_TABLE, p_include_deleted: false, p_limit: 100, p_offset: 0 }).catch((e: unknown) => e);
  assert.ok(snap instanceof Error || !(snap as { rows: unknown[] }).rows.length, 'el editor no las ve');
});
