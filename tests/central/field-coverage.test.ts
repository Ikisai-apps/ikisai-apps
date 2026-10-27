/**
 * Central · Revisor › cobertura de campos por pantalla (VG 27-10): solo candidatos, agrupados por app y pantalla; utilidad
 * heredada del estimado de la app y del uso; decisión por grupo («dejar», «revisar más tarde», «retirar») que guarda
 * Dirección (owner o editor con ámbito `direccion`). Solo metadatos. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  DECISION_TO_KIT, FIELD_GROUP_REVIEWS_TABLE, KIT_TO_DECISION, candidateGroups, flowSteps, candidatesSummary, canDeclareUtility, fieldLinks, inheritedUtility, isCandidate, screenName, validateOperations,
} from '../../supabase/functions/_domain/central/mod.ts';

let app: TestApp;
let seq = 0;
const uuid = () => crypto.randomUUID();
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `fc-${++seq}`, operations } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!] }) });
});
test.after(async () => { await app.close(); });

test('campos · dominio: vínculos de Flow, candidatos por pantalla, resumen y utilidad heredada', () => {
  const fields = [
    { fieldId: 'food.carta.expected_units', app: 'food', screen: 'food.carta', anchorId: 'food.carta.unidades', entity: 'carta_line', prop: 'expected_units' },
    { fieldId: 'booking.ficha.notes', app: 'booking', screen: 'booking.ficha_reserva', activations30d: 0 },
    { fieldId: 'booking.ficha.color', app: 'booking', screen: 'booking.ficha_reserva', activations30d: 0 },
    { fieldId: 'booking.ficha.tag', app: 'booking', screen: 'booking.ficha_reserva', estimate: { frequency: 'semanal', audience: 'Recepción' } },
    { fieldId: 'booking.lista.extra', app: 'booking', screen: 'booking.lista', screenLabel: 'Lista de reservas', candidate: true },
    { fieldId: 'food.carta.price', app: 'food', screen: 'food.carta', candidate: false },
  ];
  const anchors = [{ anchor_id: 'food.carta.unidades', uses: [{ flow_key: 'cocina', flow_name: 'Cocina del día' }] }];
  const rules = [{ id: 'flow.prevision', name: 'Previsión', observes: [{ app: 'food', entity: 'carta_line', prop: 'expected_units' }] }];
  const links = fieldLinks(fields, anchors, rules);
  assert.deepEqual(links.filter((l) => l.fieldId === 'food.carta.expected_units').map((l) => l.via), ['direct', 'automatic']);
  // Candidatos: lo dice el núcleo; si no, sin Flow, sin uso y sin estimado.
  const linked = new Set(links.map((l) => l.fieldId));
  assert.equal(isCandidate(fields[1]!, linked), true);
  assert.equal(isCandidate(fields[3]!, linked), false, 'el estimado de la app lo protege');
  assert.equal(isCandidate(fields[0]!, linked), false, 'lo usa un recorrido');
  assert.equal(isCandidate(fields[5]!, linked), false, 'el núcleo manda');
  const groups = candidateGroups(fields, links);
  assert.deepEqual(groups.map((g) => [g.app, g.label, g.fields.length]), [['booking', 'Ficha reserva', 2], ['booking', 'Lista de reservas', 1]]);
  assert.equal(candidatesSummary(groups), '3 campos en 2 pantallas');
  assert.equal(screenName({ fieldId: 'x.y.z', screen: null }), 'Y');
  assert.equal(inheritedUtility(fields[3]!), 'Recepción · semanal');
  assert.equal(inheritedUtility(fields[1]!, { app: 'booking', screen: 'booking.ficha_reserva', audience: 'Dirección', frequency: 'mensual' }), 'Dirección · mensual · 0 usos en 30 días');
  // Lo de Flow en la forma del kit: un paso por recorrido con el anclaje del campo, y una regla por regla que observa su dato.
  assert.deepEqual(flowSteps(fields, anchors, rules).map((x) => [x.kind, x.flowId, x.anchor]), [['step', 'cocina', 'food.carta.expected_units'], ['rule', 'flow.prevision', 'food.carta.expected_units']]);
  assert.equal(KIT_TO_DECISION.later, 'revisar_mas_tarde');
  assert.equal(DECISION_TO_KIT.retirar, 'retire');
  assert.equal(canDeclareUtility({ role: 'editor', scopes: { direccion: true } }), true);
  assert.equal(validateOperations([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: 'g', fields: { app: 'booking', screen: 'booking.ficha_reserva', decision: 'dejar' } }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: 'g', fields: { app: 'booking', screen: 'booking.ficha_reserva', decision: 'borrar' } }], { role: 'owner' })?.details.field, 'decision');
});

test('campos · GET coverage/fields para Dirección: lo del núcleo y lo de Flow; el editor sin ámbito, no', async () => {
  const out = await app.call('/api/v1/coverage/fields');
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.ok(Array.isArray(out.data.fields) && Array.isArray(out.data.anchors) && Array.isArray(out.data.rules));
  assert.equal(typeof out.data.flowAvailable, 'boolean');
  assert.equal((await app.call('/api/v1/coverage/fields', { token: app.tokens.editor })).status, 403);
  assert.equal((await app.call('/api/v1/coverage/fields?app=Food;drop')).status, 422);
});

test('campos · decisión por pantalla: la toma el owner; el editor solo con el ámbito de Dirección (Edge y base); una por pantalla', async () => {
  const byOwner = await commit([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: uuid(), fields: { app: 'booking', screen: 'booking.ficha_reserva', decision: 'revisar_mas_tarde', fields_count: 2 } }]);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.data));
  const byEditor = await commit([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: uuid(), fields: { app: 'booking', screen: 'booking.lista', decision: 'dejar' } }], app.tokens.editor);
  assert.equal(byEditor.status, 403, JSON.stringify(byEditor.data));
  await assert.rejects(
    app.t.rpc('core_commit', { p_app: 'central', p_actor: app.users.editor, p_request_id: `fc-direct-${uuid()}`, p_digest: 'fc', p_expected_cursor: null,
      p_operations: [{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: uuid(), fields: { app: 'booking', screen: 'booking.lista', decision: 'dejar' } }] }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  await app.t.db.query(`update core.memberships set scopes = coalesce(scopes, '{}'::jsonb) || '{"direccion": true}'::jsonb where app = 'central' and user_id = $1`, [app.users.editor]);
  const withScope = await commit([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: uuid(), fields: { app: 'booking', screen: 'booking.lista', decision: 'retirar', fields_count: 1 } }], app.tokens.editor);
  assert.equal(withScope.status, 200, JSON.stringify(withScope.data));
  const twice = await commit([{ op: 'insert', table: FIELD_GROUP_REVIEWS_TABLE, id: uuid(), fields: { app: 'booking', screen: 'booking.ficha_reserva', decision: 'dejar' } }]);
  assert.notEqual(twice.status, 200);
});
