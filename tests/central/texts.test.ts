/** Central · «Textos y contacto»: semilla, versiones, marcadores, proyección para los portales y permisos. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import {
  ENTITY_TABLE, TEXTS_PROJECTION, TEXTS_TABLE, entityAddress, nextVersion, parseSimpleMarkdown, renderMarkers, unknownMarkers, validateOperations,
} from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `txt-${++seq}`, operations } });
const textRow = async (key: string) => (await app.call(`/api/v1/snapshot?tables=${TEXTS_TABLE}`)).data.tables[0].rows.find((r: any) => r.key === key);

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('textos · dominio: marcadores, domicilio, versión, marcadores desconocidos y Markdown sencillo', () => {
  const entity = { legal_name: 'Entidad S.L.', tax_id: 'B12345674', address_line: 'Calle 1', postal_code: '28000', city: 'Madrid', province: null, country: 'ES' };
  assert.equal(entityAddress(entity), 'Calle 1, 28000 Madrid');
  assert.equal(renderMarkers('{{entidad.razon_social}} ({{entidad.nif}}), {{entidad.domicilio}} · {{contacto.correo}} · {{contacto.telefono}}', { entity, email: 'a@b.es', phone: '600' }),
    'Entidad S.L. (B12345674), Calle 1, 28000 Madrid · a@b.es · 600');
  assert.equal(renderMarkers('{{entidad.nif}} {{contacto.correo}}', {}), '— —');
  assert.equal(nextVersion('v1'), 'v2'); assert.equal(nextVersion('v9'), 'v10'); assert.equal(nextVersion(null), 'v1');
  assert.deepEqual(unknownMarkers('{{entidad.nif}} {{entidad.cif}}'), ['{{entidad.cif}}']);
  assert.deepEqual(parseSimpleMarkdown('**Hola** mundo\nsegunda\n\nOtro **párrafo**'), [
    [[{ text: 'Hola', bold: true }, { text: ' mundo', bold: false }], [{ text: 'segunda', bold: false }]],
    [[{ text: 'Otro ', bold: false }, { text: 'párrafo', bold: true }]],
  ]);
  assert.equal(validateOperations([{ op: 'insert', table: TEXTS_TABLE, id: 'x', fields: { key: 'Portal Privacy', title: 'x', body: 'x', kind: 'legal' } }], { role: 'owner' })?.details.field, 'key');
  assert.equal(validateOperations([{ op: 'insert', table: TEXTS_TABLE, id: 'x', fields: { key: 'a.b', title: 'x', body: 'x', kind: 'legal' } }], { role: 'editor' })?.code, 'FORBIDDEN');
});

test('textos · semilla idempotente con los cuatro textos del usuario en v1', async () => {
  const first = await app.t.db.query<{ n: number }>(`select central.seed_texts() as n`);
  assert.equal(first.rows[0]!.n, 4);
  const again = await app.t.db.query<{ n: number }>(`select central.seed_texts() as n`);
  assert.equal(again.rows[0]!.n, 0);
  const rows = (await app.t.db.query<{ key: string; version: string; kind: string }>(`select key, version, kind from central.texts order by position`)).rows;
  assert.deepEqual(rows.map((r) => [r.key, r.version, r.kind]), [
    ['contact.email', 'v1', 'contacto'], ['contact.phone', 'v1', 'contacto'], ['organizers.declaration', 'v1', 'legal'], ['portal.privacy', 'v1', 'legal'],
  ]);
  // La semilla llega a los dispositivos: está en core.changes.
  const changes = await app.call('/api/v1/changes?after=0');
  assert.ok(changes.data.items.some((c: any) => c.table === TEXTS_TABLE));
});

test('textos · versión al cambiar el contenido, versiones guardadas tal como se aceptaron y proyección con marcadores', async () => {
  // Sin Entidad: los marcadores de la entidad salen «—»; el contacto sale de los textos de contacto.
  const read = async (appId: string) => {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [appId, user]);
    return (await app.t.rpc('core_read', { p_app: appId, p_actor: user, p_name: TEXTS_PROJECTION, p_args: { where: { key: 'portal.privacy' } } }) as { rows: any[] }).rows[0];
  };
  const before = await read('organizers');
  assert.match(before.body, /\*\*Responsable:\*\* — \(NIF —\), —\. Contacto: organiza@ikisai\.com · 614 76 57 96\./);
  assert.equal(before.version, 'v1');

  // Con Entidad: la proyección sustituye al leer, sin cambiar la versión.
  await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: { legal_name: 'Entidad de Prueba S.L.', tax_id: 'B12345674', address_line: 'Calle Falsa 1', postal_code: '28000', city: 'Madrid' } }]);
  for (const appId of ['guests', 'booking']) {
    const row = await read(appId);
    assert.match(row.body, /Entidad de Prueba S\.L\. \(NIF B12345674\), Calle Falsa 1, 28000 Madrid/);
    assert.equal(row.version, 'v1');
  }

  // Cambiar el cuerpo sube a v2; cambiar solo el orden no.
  const privacy = await textRow('portal.privacy');
  const edit = await commit([{ op: 'update', table: TEXTS_TABLE, id: privacy.id, expectedRevision: privacy.revision, fields: { body: privacy.body + '\n\nÚltima revisión: octubre de 2026.' } }]);
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  assert.equal(edit.data.changes[0].after.version, 'v2');
  const moved = await textRow('portal.privacy');
  const reorder = await commit([{ op: 'update', table: TEXTS_TABLE, id: moved.id, expectedRevision: moved.revision, fields: { position: 99 } }]);
  assert.equal(reorder.data.changes[0].after.version, 'v2');

  // La v1 se muestra tal como era (con los marcadores de cuando se guardó: aún sin Entidad).
  const owner = app.users.owner;
  const v1 = await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: 'central.text_version', p_args: { key: 'portal.privacy', version: 'v1' } }) as any;
  assert.equal(v1.version, 'v1'); assert.match(v1.body, /\(NIF —\)/); assert.equal(v1.body.includes('Última revisión'), false);
  const current = await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: 'central.text_version', p_args: { key: 'portal.privacy' } }) as any;
  assert.equal(current.version, 'v2'); assert.match(current.body, /B12345674/); assert.match(current.body, /Última revisión/);
  const history = await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: 'central.text_history', p_args: { key: 'portal.privacy' } }) as any;
  assert.deepEqual(history.items.map((i: any) => i.version), ['v2', 'v1']);

  // Una app sin permiso registrado no lee los textos.
  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: TEXTS_PROJECTION, p_args: {} }));
});

test('textos · solo el owner escribe; la clave no cambia; claves únicas; el lector lee', async () => {
  assert.equal((await commit([{ op: 'insert', table: TEXTS_TABLE, id: uuid(), fields: { key: 'portal.welcome', title: 'Bienvenida', body: 'Hola', kind: 'mensaje' } }], app.tokens.editor)).status, 403);
  const created = await commit([{ op: 'insert', table: TEXTS_TABLE, id: uuid(), fields: { key: 'portal.welcome', title: 'Bienvenida', body: 'Hola', kind: 'mensaje' } }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.changes[0].after.version, 'v1');
  const dup = await commit([{ op: 'insert', table: TEXTS_TABLE, id: uuid(), fields: { key: 'portal.welcome', title: 'Otra', body: 'x', kind: 'mensaje' } }]);
  assert.equal(dup.data.error.code, 'CONSTRAINT_VIOLATION');
  const row = await textRow('portal.welcome');
  const rekey = await commit([{ op: 'update', table: TEXTS_TABLE, id: row.id, expectedRevision: row.revision, fields: { key: 'portal.hola' } }]);
  assert.equal(rekey.data.error.code, 'IMMUTABLE_FIELD');
  const version = await commit([{ op: 'update', table: TEXTS_TABLE, id: row.id, expectedRevision: row.revision, fields: { version: 'v9' } }]);
  assert.equal(version.data.error.code, 'INVALID_FIELDS');
  const snap = await app.call(`/api/v1/snapshot?tables=${TEXTS_TABLE}`, { token: app.tokens.reader });
  assert.ok(snap.data.tables[0].rows.length >= 5);
  // La tabla de versiones es cerrada: ni se lee ni se escribe por el núcleo.
  assert.notEqual((await app.call('/api/v1/snapshot?tables=central.text_versions')).status, 200);
});
