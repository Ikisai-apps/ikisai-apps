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
const textRow = async (key: string, lang = 'es') => (await app.call(`/api/v1/snapshot?tables=${TEXTS_TABLE}`)).data.tables[0].rows.find((r: any) => r.key === key && r.lang === lang && !r.deleted_at);

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

test('textos · semilla idempotente: textos de los portales en español y en inglés, en v1', async () => {
  const first = await app.t.db.query<{ n: number }>(`select central.seed_texts() as n`);
  assert.equal(first.rows[0]!.n, 22);
  const again = await app.t.db.query<{ n: number }>(`select central.seed_texts() as n`);
  assert.equal(again.rows[0]!.n, 0);
  const rows = (await app.t.db.query<{ key: string; lang: string; version: string; kind: string }>(`select key, lang, version, kind from central.texts order by key, lang desc`)).rows;
  const byKey = new Map<string, string[]>();
  for (const r of rows) { assert.equal(r.version, 'v1'); byKey.set(r.key, [...(byKey.get(r.key) ?? []), `${r.lang}:${r.kind}`]); }
  assert.deepEqual(Object.fromEntries(byKey), {
    'contact.email': ['es:contacto'], 'contact.phone': ['es:contacto'],
    'guests.allergies_notice': ['es:mensaje', 'en:mensaje'], 'guests.data_why': ['es:mensaje', 'en:mensaje'], 'guests.signature_statement': ['es:legal', 'en:legal'],
    'info.arrival': ['es:info', 'en:info'], 'info.bring': ['es:info', 'en:info'], 'info.facilities': ['es:info', 'en:info'], 'info.parking': ['es:info', 'en:info'], 'info.rules': ['es:info', 'en:info'],
    'organizers.declaration': ['es:legal', 'en:legal'], 'portal.privacy': ['es:legal', 'en:legal'],
  });
  // Los párrafos se conservan y los marcadores se sustituyen al leer.
  const arrival = (await app.t.db.query<{ body: string }>(`select body from central.common_texts_projection where key = 'info.arrival' and lang = 'es'`)).rows[0]!.body;
  assert.match(arrival, /614 76 57 96\.\n\nDirección: —\./);
  // La semilla llega a los dispositivos: está en core.changes.
  const changes = await app.call('/api/v1/changes?after=0');
  assert.ok(changes.data.items.some((c: any) => c.table === TEXTS_TABLE));
});

test('textos · versión al cambiar el contenido, versiones guardadas tal como se aceptaron y proyección con marcadores', async () => {
  // Sin Entidad: los marcadores de la entidad salen «—»; el contacto sale de los textos de contacto.
  const read = async (appId: string) => {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [appId, user]);
    return (await app.t.rpc('core_read', { p_app: appId, p_actor: user, p_name: TEXTS_PROJECTION, p_args: { where: { key: 'portal.privacy', lang: 'es' } } }) as { rows: any[] }).rows[0];
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

test('textos · idiomas: el inglés que falta cae al español; una traducción necesita su español; versiones por idioma', async () => {
  const owner = app.users.owner;
  const proj = async (key: string, lang: string) => (await app.t.rpc('core_read', { p_app: 'central', p_actor: owner, p_name: TEXTS_PROJECTION, p_args: { where: { key, lang } } }) as { rows: any[] }).rows[0];
  const declEn = await proj('organizers.declaration', 'en');
  assert.equal(declEn.fallback, false); assert.equal(declEn.source_lang, 'en'); assert.match(declEn.body, /^I am providing this information/);
  const mailEn = await proj('contact.email', 'en');
  assert.equal(mailEn.fallback, true); assert.equal(mailEn.source_lang, 'es'); assert.equal(mailEn.body, 'organiza@ikisai.com');
  const privacyEn = await proj('portal.privacy', 'en');
  assert.match(privacyEn.body, /\*\*Controller:\*\* Entidad de Prueba S\.L\. \(Tax ID B12345674\)/);
  assert.match(privacyEn.body, /Contact: organiza@ikisai\.com · 614 76 57 96\./);

  // La versión inglesa va por su cuenta; sin traducción, `text_version` da la del español.
  const enV1 = await app.t.rpc('core_read', { p_app: 'guests', p_actor: owner, p_name: 'central.text_version', p_args: { key: 'organizers.declaration', lang: 'en' } }).catch(() => null);
  assert.equal(enV1, null); // el owner de central no es miembro de guests
  const guest = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('guests', $1, 'reader')`, [guest]);
  const en = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'central.text_version', p_args: { key: 'organizers.declaration', lang: 'en' } }) as any;
  assert.equal(en.lang, 'en'); assert.equal(en.version, 'v1'); assert.match(en.body, /^I am providing/);
  const fallback = await app.t.rpc('core_read', { p_app: 'guests', p_actor: guest, p_name: 'central.text_version', p_args: { key: 'contact.phone', lang: 'en' } }) as any;
  assert.equal(fallback.lang, 'es'); assert.equal(fallback.body, '614 76 57 96');

  // Un texto en inglés sin su español no vale; borrar el español con la traducción viva, tampoco.
  const orphan = await commit([{ op: 'insert', table: TEXTS_TABLE, id: uuid(), fields: { key: 'portal.only_en', lang: 'en', title: 'Only', body: 'x', kind: 'mensaje' } }]);
  assert.equal(orphan.status, 422); assert.equal(orphan.data.error.code, 'MISSING_BASE_LANGUAGE');
  const decl = await textRow('organizers.declaration');
  const dropBase = await commit([{ op: 'delete', table: TEXTS_TABLE, id: decl.id, expectedRevision: decl.revision }]);
  assert.equal(dropBase.data.error.code, 'MISSING_BASE_LANGUAGE');
  const relang = await commit([{ op: 'update', table: TEXTS_TABLE, id: decl.id, expectedRevision: decl.revision, fields: { lang: 'en' } }]);
  assert.equal(relang.data.error.code, 'IMMUTABLE_FIELD');
  const mismatch = await commit([{ op: 'insert', table: TEXTS_TABLE, id: uuid(), fields: { key: 'contact.email', lang: 'en', title: 'Email', body: 'x@y.es', kind: 'legal' } }]);
  assert.equal(mismatch.data.error.code, 'KIND_MISMATCH');
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

test('textos · contacto público sin sesión (C1): solo los textos de contacto, por idioma y en su orden', async () => {
  const contact = async (lang: string | null) => (await app.t.db.query<{ out: any[] }>(`select central.public_contact($1) as out`, [lang])).rows[0]!.out;
  const es = await contact('es');
  assert.deepEqual(es.map((c) => c.key), ['contact.email', 'contact.phone']);
  assert.equal(es[0].body, 'organiza@ikisai.com'); assert.equal(es[0].version, 'v1'); assert.ok(es[0].title);
  assert.deepEqual(Object.keys(es[0]).sort(), ['body', 'key', 'title', 'version']);
  // Inglés: el que falta cae al español; un idioma desconocido o nulo, español.
  assert.deepEqual((await contact('en')).map((c) => c.body), ['organiza@ikisai.com', '614 76 57 96']);
  assert.deepEqual(await contact('fr'), es);
  assert.deepEqual(await contact(null), es);
  // Ningún texto legal ni de otro tipo.
  assert.equal(JSON.stringify(es).includes('Protección de datos'), false);
  // Solo para la clave de servicio.
  const grants = await app.t.db.query<{ role: string; ok: boolean }>(
    `select r as role, has_function_privilege(r, 'central.public_contact(text)', 'execute') as ok from unnest(array['anon','authenticated','service_role']) r
      where exists (select 1 from pg_roles where rolname = r)`);
  for (const g of grants.rows) assert.equal(g.ok, g.role === 'service_role', g.role);
});
