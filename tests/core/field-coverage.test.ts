/** 0111: reads/writes por capacidad y cobertura de campos (indirecta, independiente, sin datos; duplicados por entity.prop). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

test('0111 · field_coverage: una capacidad con writes cubre el campo (indirect); uso propio sin capacidad es independent; sin entity.prop, unknown; duplicados por entity.prop', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'] }) });
  try {
    const db = app.t.db;
    await db.query(`select core.register_capability('{"id":"booking.test_notes","app":"booking","kind":"execute","title":"Notas","route":"POST test/notes","reads":["reservation.title"],"writes":["reservation.notes"]}')`);
    await db.query(`insert into core.field_inventory (field_id, app, screen, route, anchor_id, label, type, entity, prop, sensitivity, since, last_seen, raw) values
      ('booking.reserva.notas', 'booking', 'reserva', '#/r/:id', 'booking.reserva.notas', 'Notas', 'text', 'reservation', 'notes', 'internal', 'v1', 'v1', '{}'),
      ('booking.reserva.notas2', 'booking', 'ficha', '#/f/:id', 'booking.reserva.notas2', 'Notas (ficha)', 'text', 'reservation', 'notes', 'internal', 'v1', 'v1', '{}'),
      ('booking.reserva.color', 'booking', 'reserva', '#/r/:id', 'booking.reserva.color', 'Color', 'text', 'reservation', 'color', 'internal', 'v1', 'v1', '{}'),
      ('booking.reserva.misterio', 'booking', 'reserva', '#/r/:id', 'booking.reserva.misterio', 'Misterio', 'text', null, null, 'internal', 'v1', 'v1', '{}')`);
    await db.query(`insert into core.usage_features (feature_id, app, label, catalogued, active) values ('booking.reserva.color', 'booking', 'Color', true, true)`);
    const r = (await db.query<{ r: any }>(`select core.field_coverage($1, 'booking') r`, [app.users.editor])).rows[0]!.r;
    const by: Record<string, any> = {};
    for (const f of r.fields) by[f.fieldId] = f;
    assert.equal(by['booking.reserva.notas'].class, 'indirect');
    assert.deepEqual(by['booking.reserva.notas'].capabilities, [{ id: 'booking.test_notes', app: 'booking', kind: 'execute', how: 'writes' }]);
    assert.deepEqual(by['booking.reserva.notas'].duplicates, ['booking.reserva.notas2']);
    assert.equal(by['booking.reserva.color'].class, 'independent');
    assert.equal(by['booking.reserva.color'].used, true);
    assert.equal(by['booking.reserva.misterio'].class, 'unknown');
    assert.ok(!('raw' in by['booking.reserva.notas']), 'nunca raw');
    const cap = r.capabilities.find((c: any) => c.id === 'booking.test_notes');
    assert.deepEqual([cap.reads, cap.writes], [['reservation.title'], ['reservation.notes']]);
    assert.equal(r.declared.capabilitiesWithReadsWrites >= 1, true);
    const lab = (await db.query<{ r: any }>(`select core.field_coverage($1, 'booking', 'label') r`, [app.users.editor])).rows[0]!.r;
    assert.deepEqual(lab.fields.find((f: any) => f.fieldId === 'booking.reserva.notas').duplicates, ['booking.reserva.notas2'], 'modo label: etiqueta distinta, siguen solo los exactos');
    assert.equal((await db.query<{ r: any }>(`select core.service_grants('invoices') r`)).rows[0]!.r.displayName, 'Finance (sistema)');
    // 0114: utilidad heredada, uso real y candidatos
    await db.query(`insert into core.usage_features (feature_id, app, label, catalogued, active, frequency) values ('booking.reserva', 'booking', 'Reserva', true, true, 'frequent')`);
    await db.query(`insert into core.usage_daily (day, feature_id, generation, actor, context, device_id, activations) values (current_date - 3, 'booking.reserva.color', 1, 'internal', 'production', gen_random_uuid(), 3)`);
    const r2 = (await db.query<{ r: any }>(`select core.field_coverage($1, 'booking') r`, [app.users.editor])).rows[0]!.r;
    const by2: Record<string, any> = {}; for (const f of r2.fields) by2[f.fieldId] = f;
    assert.equal(by2['booking.reserva.color'].estimate.featureId, 'booking.reserva.color', 'la funcionalidad propia manda sobre la de la pantalla');
    assert.equal(by2['booking.reserva.misterio'].estimate.featureId, 'booking.reserva', 'hereda de la pantalla');
    assert.equal(by2['booking.reserva.misterio'].estimate.frequency, 'frequent');
    assert.equal(by2['booking.reserva.color'].activations30d, 3);
    assert.equal(by2['booking.reserva.misterio'].screenLabel, 'Reserva', 'nombre de la pantalla desde el catálogo de uso');
    assert.equal(by2['booking.reserva.color'].candidate, false, 'con uso no es candidato');
    assert.equal(by2['booking.reserva.misterio'].candidate, true, 'sin cobertura, sin uso y sin protección');
    assert.equal(by2['booking.reserva.notas'].candidate, false, 'lo cubre una capacidad');
    await assert.rejects(db.query(`select core.field_coverage($1, 'booking')`, [app.users.reader]), /FORBIDDEN/);
  } finally {
    await app.close();
  }
});
