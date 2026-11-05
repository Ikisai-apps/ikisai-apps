/**
 * Central · OKR de Dirección (X5, 1527): objetivos del trimestre con indicadores del panel como resultados clave. Los preparan
 * el owner y el editor con ámbito `direccion`; la revisión semanal enseña cómo va cada uno. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { OBJECTIVES_TABLE, objectiveProgress, quarterOf, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `okr-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('okr · dominio: trimestre, cómo va y validación', () => {
  assert.equal(quarterOf('2026-11-05'), '2026T4');
  assert.equal(quarterOf('2027-01-01'), '2027T1');
  const kpi = (k: string, state: string | null) => ({ kpi: k, state, label: k });
  assert.equal(objectiveProgress(['a.b', 'c.d'], [kpi('a.b', 'ok'), kpi('c.d', 'ok')]).status, 'bien');
  assert.equal(objectiveProgress(['a.b', 'c.d'], [kpi('a.b', 'ok'), kpi('c.d', 'atencion')]).status, 'en_riesgo');
  assert.equal(objectiveProgress(['a.b', 'c.d'], [kpi('a.b', 'critico'), kpi('c.d', 'atencion')]).status, 'mal');
  assert.equal(objectiveProgress(['a.b', 'x.y'], [kpi('a.b', 'ok')]).status, 'sin_datos');
  assert.equal(objectiveProgress([], []).status, 'sin_datos');
  const ok = { quarter: '2026T4', title: 'Ocupación de otoño', kpis: ['booking.occupancy'] };
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: ok }], { role: 'owner' }), null);
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: ok }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: ok }], { role: 'editor', scopes: { direccion: true } }), null);
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: { ...ok, quarter: '2026Q4' } }], { role: 'owner' })?.details.field, 'quarter');
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: { ...ok, kpis: ['Mal'] } }], { role: 'owner' })?.details.field, 'kpis');
  assert.equal(validateOperations([{ op: 'insert', table: OBJECTIVES_TABLE, id: 'o', fields: { ...ok, kpis: Array.from({ length: 11 }, (_, n) => `a.k${n}`) } }], { role: 'owner' })?.details.field, 'kpis');
});

test('okr · base: el owner crea con código OKR; el editor sin ámbito no, ni saltándose la Edge; con ámbito sí', async () => {
  const id = uuid();
  const created = await commit([{ op: 'insert', table: OBJECTIVES_TABLE, id, fields: { quarter: '2026T4', title: 'Ocupación de otoño', kpis: ['central.legal_overdue'], position: 0 } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const [row] = (await app.t.db.query<{ code: string; revision: string }>(`select code, revision from central.objectives where id = $1`, [id])).rows;
  assert.match(row!.code, /^OKR_\d{4}_\d{3}$/);

  const byEditor = await commit([{ op: 'update', table: OBJECTIVES_TABLE, id, expectedRevision: Number(row!.revision), fields: { title: 'Del editor' } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.data));
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.editor, p_request_id: `okr-direct-${uuid()}`, p_digest: 'okr', p_expected_cursor: null,
      p_operations: [{ op: 'update', table: OBJECTIVES_TABLE, id, expectedRevision: Number(row!.revision), fields: { title: 'Directo' } }] }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  await app.t.db.query(`update core.memberships set scopes = coalesce(scopes, '{}'::jsonb) || '{"direccion": true}'::jsonb where app = 'central' and user_id = $1`, [app.users.editor]);
  const withScope = await commit([{ op: 'update', table: OBJECTIVES_TABLE, id, expectedRevision: Number(row!.revision), fields: { title: 'Ocupación de otoño y Navidad' } }], app.tokens.editor);
  assert.equal(withScope.status, 200, JSON.stringify(withScope.data));
  // Más de 10 indicadores: lo para también la base.
  await assert.rejects(app.t.db.query(`update central.objectives set kpis = array_fill('a.b'::text, array[11]) where id = $1`, [id]));
});
