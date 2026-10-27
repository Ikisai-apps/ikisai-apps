/**
 * Central · Revisor › cobertura de campos (VG 27-10): clases del núcleo más «directo» (paso de Flow) y «automático» (regla de
 * Flow); la utilidad la declara Dirección (owner o editor con ámbito `direccion`). Solo metadatos. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { FIELD_UTILITY_TABLE, canDeclareUtility, fieldLinks, utilityText, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `fc-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('campos · dominio: directo por anclaje, indirecto por capacidad, automático por regla de su app; utilidad en una línea', () => {
  const fields = [
    { fieldId: 'food.carta.expected_units', app: 'food', anchorId: 'food.carta.unidades', entity: 'carta_line', prop: 'expected_units', capabilities: [{ id: 'food.carta.read' }] },
    { fieldId: 'booking.ficha.notes', app: 'booking', entity: 'reservation', prop: 'notes' },
    { fieldId: 'flow.unidad.qty', app: 'flow', entity: 'carta_line', prop: 'expected_units' },
  ];
  const anchors = [{ anchor_id: 'food.carta.unidades', uses: [{ flow_key: 'cocina', flow_name: 'Cocina del día' }, { flow_key: 'cocina', flow_name: 'Cocina del día' }] }];
  const rules = [{ id: 'flow.prevision', name: 'Previsión de ingredientes', observes: [{ app: 'food', entity: 'carta_line', prop: 'expected_units' }] }];
  const links = fieldLinks(fields, anchors, rules);
  assert.deepEqual(links.filter((l) => l.fieldId === 'food.carta.expected_units').map((l) => l.via), ['direct', 'indirect', 'automatic']);
  assert.deepEqual(links.find((l) => l.via === 'direct')!.flows, [{ id: 'cocina', name: 'Cocina del día' }], 'un recorrido una vez');
  assert.deepEqual(links.filter((l) => l.fieldId === 'flow.unidad.qty'), [], 'la regla observa ese dato en Food, no en Flow');
  assert.deepEqual(links.filter((l) => l.fieldId === 'booking.ficha.notes'), [], 'sin vínculos: lo que diga el núcleo (uso propio o sin datos)');
  assert.equal(utilityText({ app: 'food', field_id: 'x', audience: 'Cocina', frequency: 'diaria', impact: 'alto' }), 'Cocina · diaria · impacto alto');
  assert.equal(utilityText({ app: 'food', field_id: 'x' }), null);
  assert.equal(canDeclareUtility({ role: 'editor' }), false);
  assert.equal(canDeclareUtility({ role: 'editor', scopes: { direccion: true } }), true);
  assert.equal(validateOperations([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: 'u', fields: { app: 'food', field_id: 'food.x.y' } }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: 'u', fields: { app: 'food', field_id: 'food.x.y', impact: 'enorme' } }], { role: 'owner' })?.details.field, 'impact');
});

test('campos · GET coverage/fields para Dirección: lo del núcleo y lo de Flow; el editor sin ámbito, no', async () => {
  const out = await app.call('/api/v1/coverage/fields');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.ok(Array.isArray(out.data.fields) && Array.isArray(out.data.anchors) && Array.isArray(out.data.rules));
  assert.equal(typeof out.data.flowAvailable, 'boolean');
  assert.equal((await app.call('/api/v1/coverage/fields', { token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/coverage/fields?app=Food;drop', {})).status, 422);
});

test('campos · utilidad: la declara el owner; el editor solo con el ámbito de Dirección (Edge y base)', async () => {
  const byOwner = await commit([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: uuid(), fields: { app: 'food', field_id: 'food.carta.expected_units', audience: 'Cocina', frequency: 'diaria', impact: 'alto', critical: true } }]);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.data));
  const byEditor = await commit([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: uuid(), fields: { app: 'booking', field_id: 'booking.ficha.notes' } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.data));
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.editor, p_request_id: `fc-direct-${uuid()}`, p_digest: 'fc', p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: FIELD_UTILITY_TABLE, id: uuid(), fields: { app: 'booking', field_id: 'booking.ficha.notes' } }] }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  await app.t.db.query(`update core.memberships set scopes = coalesce(scopes, '{}'::jsonb) || '{"direccion": true}'::jsonb where app = 'central' and user_id = $1`, [app.users.editor]);
  const withScope = await commit([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: uuid(), fields: { app: 'booking', field_id: 'booking.ficha.notes', frequency: 'semanal' } }], app.tokens.editor);
  assert.equal(withScope.status, 200, JSON.stringify(withScope.data));
  // Una por campo.
  const twice = await commit([{ op: 'insert', table: FIELD_UTILITY_TABLE, id: uuid(), fields: { app: 'food', field_id: 'food.carta.expected_units' } }]);
  assert.notEqual(twice.status, 200);
});
