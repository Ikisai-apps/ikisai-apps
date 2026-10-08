/** Central · datos de la entidad: fila única, solo owner, NIF/CIF válido, logotipo y proyección para Booking y Finance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { ENTITY_PROJECTION, ENTITY_TABLE, normalizeTaxId, taxIdProblem, validateOperations } from '../../supabase/functions/_domain/central/mod.ts';

const uuid = () => crypto.randomUUID();
// Datos ficticios: el repositorio es público y los reales los escribe el owner en la app.
const ENTITY = { legal_name: 'Entidad de Prueba S.L.', tax_id: 'B12345674', address_line: 'Calle Falsa 1', postal_code: '28000', city: 'Madrid' };

let app: TestApp;
let seq = 0;
const commit = (operations: unknown[], token?: string) => app.call('/api/v1/commands', { token, body: { requestId: `entity-${++seq}`, operations } });

async function upload(mime: string, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await app.call('/api/v1/uploads', { body: { filename: mime === 'application/pdf' ? 'a.pdf' : 'logo.png', mime, size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await app.call(`/api/v1/uploads/${ticket.data.id}/verify`, { body: {} })).status, 200);
  return ticket.data.id;
}

test.before(async () => {
  app = await createTestApp({
    app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!,
    createHandler: (config) => createCentralApp({ ...config, origins: [CENTRAL_ORIGINS[0]!] }),
  });
});
test.after(async () => { await app.close(); });

test('entidad · dominio: NIF, NIE y CIF con su control', () => {
  assert.equal(taxIdProblem('12345678Z'), null);
  assert.equal(taxIdProblem('12345678-z'), null);
  assert.match(taxIdProblem('12345678A') ?? '', /letra del NIF/);
  assert.equal(taxIdProblem('X1234567L'), null);
  assert.equal(taxIdProblem('B12345674'), null);
  assert.match(taxIdProblem('B12345675') ?? '', /control del CIF/);
  assert.equal(taxIdProblem('P1234567D'), null); // tipo P: control con letra
  assert.match(taxIdProblem('HOLA') ?? '', /forma/);
  assert.equal(normalizeTaxId(' b-12.345.674 '), 'B12345674');
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: { ...ENTITY, logo_file_id: { $blob: 'a'.repeat(64) } } }], { role: 'owner' }), null);
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: ENTITY }], { role: 'editor' })?.code, 'FORBIDDEN');
  assert.equal(validateOperations([{ op: 'insert', table: ENTITY_TABLE, id: 'x', fields: { ...ENTITY, website: 'http://x' } }], { role: 'owner' })?.details.field, 'website');
});

test('entidad · solo el owner la escribe; una sola viva; NIF/CIF comprobado', async () => {
  assert.equal((await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: ENTITY }], app.tokens.editor)).status, 403);
  const bad = await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: { ...ENTITY, tax_id: 'B12345675' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'tax_id');
  const id = uuid();
  const ok = await commit([{ op: 'insert', table: ENTITY_TABLE, id, fields: ENTITY }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.changes[0].after.country, 'ES');
  const second = await commit([{ op: 'insert', table: ENTITY_TABLE, id: uuid(), fields: ENTITY }]);
  assert.equal(second.status, 422); assert.equal(second.data.error.code, 'CONSTRAINT_VIOLATION');
  const snap = await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`, { token: app.tokens.reader });
  assert.equal(snap.data.tables[0].rows[0].legal_name, ENTITY.legal_name);
});

test('entidad · logotipo: imagen verificada; un PDF no vale', async () => {
  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const pdf = await upload('application/pdf', '%PDF-1.4 no es un logo');
  const rejected = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { logo_file_id: pdf } }]);
  assert.equal(rejected.status, 422); assert.equal(rejected.data.error.code, 'INVALID_FILE');
  const logo = await upload('image/png', 'PNG de prueba');
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { logo_file_id: logo } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
});

test('entidad · proyección de solo lectura para Booking y Finance, con el logotipo para firmar', async () => {
  for (const reader of ['booking', 'invoices']) {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [reader, user]);
    const out = await app.t.rpc('core_read', { p_app: reader, p_actor: user, p_name: ENTITY_PROJECTION, p_args: {} }) as { rows: any[] };
    assert.equal(out.rows.length, 1, reader);
    const e = out.rows[0];
    assert.equal(e.legal_name, ENTITY.legal_name); assert.equal(e.tax_id, ENTITY.tax_id);
    assert.equal(e.logo_bucket, 'central-documents'); assert.equal(e.logo_mime, 'image/png'); assert.ok(e.logo_path);
    assert.equal(e.logo_provider, 'supabase');
    assert.ok(e.entity_revision >= 2);
  }
  // Una app sin permiso registrado no la lee.
  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: ENTITY_PROJECTION, p_args: {} }));
});

test('archivos · Central declara sus campos de archivo con su retención y activa la recogida de huérfanos', async () => {
  const fields = (await app.t.db.query<{ col: string; retention: string }>(
    `select table_name || '.' || column_name as col, retention from core.file_fields where app = 'central' order by 1`)).rows;
  assert.deepEqual(fields.map((f) => [f.col, f.retention]), [
    ['entity.logo_file_id', 'permanent'], ['entity.site_plan_file_id', 'permanent'], ['key_documents.file_id', 'legal'], ['person_records.file_id', 'legal'],
  ]);
  const gc = await app.t.db.query(`select 1 from core.file_gc_apps where app = 'central'`);
  assert.equal(gc.rows.length, 1);
});

test('entidad · IBAN y Bizum (F3): dígito de control, formato, proyección y las instrucciones de pago', async () => {
  const { ibanProblem, formatIban, renderMarkers } = await import('../../supabase/functions/_domain/central/mod.ts');
  const IBAN = 'ES9121000418450200051332'; // IBAN de ejemplo con el control correcto, no una cuenta real de Ikisai
  assert.equal(ibanProblem(IBAN), null);
  assert.equal(ibanProblem('es91 2100 0418 4502 0005 1332'), null);
  assert.match(ibanProblem('ES9121000418450200051333') ?? '', /control/);
  assert.match(ibanProblem('ES912100041845') ?? '', /24 caracteres|forma/);
  assert.equal(formatIban(IBAN), 'ES91 2100 0418 4502 0005 1332');
  assert.equal(renderMarkers('{{entidad.iban}} · {{entidad.bizum}}', { entity: { iban: IBAN, bizum: '600 000 000' } }), 'ES91 2100 0418 4502 0005 1332 · 600 000 000');
  assert.equal(renderMarkers('{{entidad.iban}}', {}), '—');

  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const bad = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: 'ES9121000418450200051333' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'iban');
  const spaced = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: 'ES91 2100 0418 4502 0005 1332' } }]);
  assert.equal(spaced.data.error.details.field, 'iban'); // se guarda sin espacios: la app lo normaliza antes
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { iban: IBAN, bizum: '600 000 000' } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision + 1, fields: { bizum: 'abc' } }])).data.error.details.field, 'bizum');

  const projection = (await app.t.db.query<{ iban: string; bizum: string }>(`select iban, bizum from central.common_entity_projection`)).rows[0]!;
  assert.deepEqual(projection, { iban: IBAN, bizum: '600 000 000' });

  // El texto de pago, en los dos idiomas, con la cuenta en grupos de cuatro.
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_payment() as n`)).rows[0]!.n, 2);
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_payment() as n`)).rows[0]!.n, 0);
  const texts = (await app.t.db.query<{ lang: string; body: string; kind: string }>(`select lang, body, kind from central.common_texts_projection where key = 'payment.instructions' order by lang desc`)).rows;
  assert.deepEqual(texts.map((t) => [t.lang, t.kind]), [['es', 'mensaje'], ['en', 'mensaje']]);
  assert.match(texts[0]!.body, /cuenta ES91 2100 0418 4502 0005 1332, a nombre de Entidad de Prueba S\.L\./);
  assert.match(texts[0]!.body, /Bizum\*\* al 600 000 000/);
  assert.match(texts[1]!.body, /account ES91 2100 0418 4502 0005 1332/);
});

test('entidad · el lugar para los portales (X3 y CE3): dirección del lugar (nunca la fiscal), mapa, plano y textos', async () => {
  const { mapUrl, renderMarkers, PORTAL_PLACE_PROJECTION } = await import('../../supabase/functions/_domain/central/mod.ts');
  // Lugar ficticio, distinto del domicilio fiscal de ENTITY.
  const VENUE = 'Camino del Retiro 5, 28400 Collado';
  const MAP = 'https://www.google.com/maps/search/?api=1&query=Camino+del+Retiro+5%2C+28400+Collado';
  assert.equal(mapUrl(VENUE), MAP);
  assert.equal(mapUrl('  '), null);
  assert.equal(mapUrl('C/ Sol 3 #2 & 50%'), 'https://www.google.com/maps/search/?api=1&query=C%2F+Sol+3+%232+%26+50%25');
  assert.equal(renderMarkers('{{entidad.lugar}} {{entidad.mapa}}', { entity: { ...ENTITY, venue_address: VENUE } }), `${VENUE} ${MAP}`);
  assert.equal(renderMarkers('{{entidad.lugar}} {{entidad.mapa}}', { entity: ENTITY }), '— —'); // sin lugar, nunca la fiscal
  assert.equal((await app.t.db.query<{ u: string }>(`select central.map_url('C/ Sol 3 #2 & 50%') as u`)).rows[0]!.u, mapUrl('C/ Sol 3 #2 & 50%'));

  // Textos: siete borradores, y `info.arrival` (0570) pasa del domicilio fiscal al lugar; una sola vez.
  await app.t.db.query(`select central.seed_texts()`);
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_portal_place() as n`)).rows[0]!.n, 9);
  assert.equal((await app.t.db.query<{ n: number }>(`select central.seed_texts_portal_place() as n`)).rows[0]!.n, 0);
  const keys = (await app.t.db.query<{ k: string }>(`select key || ':' || lang as k from central.texts where position in (36, 37, 75, 99) and deleted_at is null order by 1`)).rows.map((r) => r.k);
  assert.deepEqual(keys, ['guests.menu_notice:en', 'guests.menu_notice:es', 'info.map_link:es', 'portal.menu_note:en', 'portal.menu_note:es', 'portal.practical:en', 'portal.practical:es']);
  const arrival = (await app.t.db.query<{ body: string }>(`select body from central.texts where key = 'info.arrival' order by lang`)).rows;
  assert.equal(arrival.length, 2);
  for (const a of arrival) { assert.match(a.body, /\{\{entidad\.lugar\}\}/); assert.doesNotMatch(a.body, /entidad\.domicilio/); }

  // Sin dirección del lugar: ni dirección ni mapa en los portales ni en los textos, aunque haya domicilio fiscal.
  const portalTexts = `select string_agg(body, ' ') as b from central.common_texts_projection where key in ('portal.practical', 'info.arrival', 'info.map_link')`;
  let place = (await app.t.db.query<any>(`select address, map_url from central.portal_place_projection`)).rows[0];
  assert.deepEqual(place, { address: null, map_url: null });
  assert.doesNotMatch((await app.t.db.query<{ b: string }>(portalTexts)).rows[0]!.b, /Calle Falsa/);

  // El owner escribe el lugar y sube el plano (imagen o PDF verificado de Central; un id que no existe no vale).
  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const rejected = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { site_plan_file_id: uuid() } }]);
  assert.equal(rejected.status, 422); assert.equal(rejected.data.error.details.field, 'site_plan_file_id');
  const plan = await upload('application/pdf', '%PDF-1.4 plano de prueba');
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { site_plan_file_id: plan, venue_address: VENUE } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const body = (await app.t.db.query<{ b: string }>(portalTexts)).rows[0]!.b;
  assert.match(body, /Camino del Retiro 5/); assert.doesNotMatch(body, /Calle Falsa/);

  // Organizers y Guests leen el lugar (sin domicilio fiscal ni datos bancarios) y abren el plano con C8; otra app no.
  for (const reader of ['organizers', 'guests']) {
    const user = await app.t.createUser();
    await app.t.db.query(`insert into core.memberships (app, user_id, role) values ($1, $2, 'reader')`, [reader, user]);
    const out = await app.t.rpc('core_read', { p_app: reader, p_actor: user, p_name: PORTAL_PLACE_PROJECTION, p_args: {} }) as { rows: any[] };
    assert.equal(out.rows.length, 1, reader);
    const p = out.rows[0];
    assert.equal(p.name, ENTITY.legal_name); assert.equal(p.address, VENUE); assert.equal(p.map_url, MAP);
    assert.equal(p.site_plan_file_id, plan); assert.equal(p.site_plan_mime, 'application/pdf');
    assert.equal(p.tax_id, undefined); assert.equal(p.iban, undefined); assert.equal(p.address_line, undefined);
    const file = await app.t.rpc('core_portal_file_get', { p_portal: reader, p_actor: user, p_file: plan }) as { id: string; mime: string };
    assert.equal(file.id, plan); assert.equal(file.mime, 'application/pdf');
    // Otro archivo de Central (el logotipo) no se publica al portal.
    const logo = (await app.t.db.query<{ id: string }>(`select logo_file_id as id from central.entity`)).rows[0]!.id;
    await assert.rejects(app.t.rpc('core_portal_file_get', { p_portal: reader, p_actor: user, p_file: logo }), /FILE_NOT_FOUND/);
  }
  const foodUser = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('food', $1, 'reader')`, [foodUser]);
  await assert.rejects(app.t.rpc('core_read', { p_app: 'food', p_actor: foodUser, p_name: PORTAL_PLACE_PROJECTION, p_args: {} }));

  // El owner puede poner el enlace exacto en `info.map_link`.
  const exact = 'https://maps.example/ikisai';
  await app.t.db.query(`update central.texts set body = $1 where key = 'info.map_link' and lang = 'es'`, [exact]);
  place = (await app.t.db.query<any>(`select map_url from central.portal_place_projection`)).rows[0];
  assert.equal(place.map_url, exact);
});

test('entidad · enlace exacto del mapa (FB_2026_010): solo mapas conocidos; manda sobre la búsqueda por dirección', async () => {
  const { VENUE_MAP_URL, renderMarkers } = await import('../../supabase/functions/_domain/central/mod.ts');
  const EXACT = 'https://maps.app.goo.gl/AbCdEf123';
  for (const ok of [EXACT, 'https://www.google.com/maps/place/Ikisai/@40.1,-3.9,17z', 'https://www.google.es/maps?q=40.1,-3.9', 'https://www.openstreetmap.org/#map=17/40.1/-3.9']) assert.ok(VENUE_MAP_URL.test(ok), ok);
  for (const bad of ['http://maps.app.goo.gl/x', 'https://maps.app.goo.gl.evil.example/x', 'https://example.com/maps', 'https://maps.app.goo.gl/a b', 'javascript:alert(1)']) assert.ok(!VENUE_MAP_URL.test(bad), bad);
  assert.equal(renderMarkers('{{entidad.mapa}}', { entity: { venue_address: 'Camino 5', venue_map_url: EXACT } }), EXACT);

  // `info.map_link` vuelve al marcador (la prueba anterior lo dejó con un enlace propio).
  await app.t.db.query(`update central.texts set body = '{{entidad.mapa}}' where key = 'info.map_link' and lang = 'es'`);
  const before = (await app.t.db.query<{ u: string }>(`select map_url as u from central.portal_place_projection`)).rows[0]!.u;
  assert.match(before, /^https:\/\/www\.google\.com\/maps\/search\//);

  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  const bad = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { venue_map_url: 'https://example.com/maps' } }]);
  assert.equal(bad.status, 422); assert.equal(bad.data.error.details.field, 'venue_map_url');
  await assert.rejects(app.t.db.query(`update central.entity set venue_map_url = 'https://example.com/maps'`)); // también lo para la base
  const ok = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { venue_map_url: EXACT } }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await app.t.db.query<{ u: string }>(`select map_url as u from central.portal_place_projection`)).rows[0]!.u, EXACT);
  assert.equal((await app.t.db.query<{ b: string }>(`select central.render_text('{{entidad.mapa}}') as b`)).rows[0]!.b, EXACT);

  // Sin dirección del lugar, el enlace exacto sigue valiendo; sin los dos, no hay mapa (nunca la fiscal).
  const r2 = ok.data.changes[0].after;
  const noVenue = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: r2.revision, fields: { venue_address: null } }]);
  assert.equal(noVenue.status, 200, JSON.stringify(noVenue.data));
  assert.equal((await app.t.db.query<{ u: string }>(`select map_url as u from central.portal_place_projection`)).rows[0]!.u, EXACT);
  const none = await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: r2.revision + 1, fields: { venue_map_url: null } }]);
  assert.equal(none.status, 200, JSON.stringify(none.data));
  assert.deepEqual((await app.t.db.query(`select address, map_url from central.portal_place_projection`)).rows[0], { address: null, map_url: null });
});

test('textos · bloque condicional de Bizum: con Bizum se ve, sin Bizum desaparece entero; igual en SQL y en el dominio', async () => {
  const { renderBlocks, renderMarkers, unknownMarkers } = await import('../../supabase/functions/_domain/central/mod.ts');
  const q = async <T = any>(sql: string, args: unknown[] = []) => (await app.t.db.query<T>(sql, args)).rows;
  const B = (s: string) => `{{#entidad.bizum}}${s}{{/entidad.bizum}}`;
  const cases: Array<[string, string, string]> = [
    [`A\n\n${B('Por Bizum: {{entidad.bizum}}')}\n\nC`, 'A\n\nPor Bizum: {{entidad.bizum}}\n\nC', 'A\n\nC'],
    [`${B('Primero')}\n\nC`, 'Primero\n\nC', 'C'],
    [`A\n\n${B('Último')}`, 'A\n\nÚltimo', 'A'],
    [`Paga${B(' o por Bizum')}.`, 'Paga o por Bizum.', 'Paga.'],
    [`${B('uno')} y ${B('dos')}`, 'uno y dos', ' y '],
    ['Sin bloque', 'Sin bloque', 'Sin bloque'],
  ];
  for (const [body, withIt, without] of cases) {
    assert.equal(renderBlocks(body, true), withIt, body); assert.equal(renderBlocks(body, false), without, body);
    const sql = (await q<{ y: string; n: string }>(`select central.render_blocks($1, true) as y, central.render_blocks($1, false) as n`, [body]))[0]!;
    assert.deepEqual([sql.y, sql.n], [withIt, without], `SQL: ${body}`);
  }
  assert.deepEqual(unknownMarkers(B('x')), []);
  assert.equal(renderMarkers(B('Bizum {{entidad.bizum}}'), { entity: { bizum: '600 000 000' } }), 'Bizum 600 000 000');
  assert.equal(renderMarkers(`A\n\n${B('Bizum {{entidad.bizum}}')}`, { entity: {} }), 'A');

  // `payment.instructions` vuelve a llevar el Bizum, dentro del bloque (después de los textos v2), una sola vez.
  await q(`select central.seed_contact_audiences()`);
  await q(`select central.apply_texts_es_v2()`);
  const out = (await q<{ r: { applied: number; skipped: string[] } }>(`select central.apply_payment_bizum_block() as r`))[0]!.r;
  assert.deepEqual(out, { applied: 2, skipped: [] });
  assert.equal((await q<{ r: { applied: number } }>(`select central.apply_payment_bizum_block() as r`))[0]!.r.applied, 0);
  const pay = async () => Object.fromEntries((await q<{ lang: string; body: string }>(`select lang, body from central.common_texts_projection where key = 'payment.instructions'`)).map((r) => [r.lang, r.body]));
  let p = await pay();
  assert.match(p.es!, /\*\*Por Bizum:\*\* al 600 000 000, con el mismo concepto\.\n\nSi tienes cualquier duda/);
  assert.match(p.en!, /\*\*By Bizum\*\* \(Spanish mobile payments\) to 600 000 000/);
  // Sin Bizum en la Entidad, el bloque desaparece sin dejar líneas vacías.
  const [row] = (await app.call(`/api/v1/snapshot?tables=${ENTITY_TABLE}`)).data.tables[0].rows;
  assert.equal((await commit([{ op: 'update', table: ENTITY_TABLE, id: row.id, expectedRevision: row.revision, fields: { bizum: null } }])).status, 200);
  p = await pay();
  for (const lang of ['es', 'en']) { assert.doesNotMatch(p[lang]!, /Bizum|—|\{\{|\n\n\n/, lang); }
  assert.match(p.es!, /«RSV_2026_012 Ana López»\.\n\nSi tienes cualquier duda/);
});

test('textos · protección de datos de los huéspedes sin NIF ni domicilio fiscal (decisión del usuario)', async () => {
  const q = async <T = any>(sql: string, args: unknown[] = []) => (await app.t.db.query<T>(sql, args)).rows;
  const before = Object.fromEntries((await q<{ lang: string; version: string }>(`select lang, version from central.texts where key = 'portal.privacy' and deleted_at is null`)).map((r) => [r.lang, r.version]));
  const out = (await q<{ r: { applied: number; skipped: string[]; others: string[] } }>(`select central.apply_privacy_controller() as r`))[0]!.r;
  assert.deepEqual(out, { applied: 2, skipped: [], others: [] });
  assert.equal((await q<{ r: { applied: number } }>(`select central.apply_privacy_controller() as r`))[0]!.r.applied, 0);
  const rows = await q<{ lang: string; version: string; body: string; rendered: string }>(
    `select t.lang, t.version, t.body, p.body as rendered from central.texts t join central.common_texts_projection p on p.key = t.key and p.lang = t.lang
      where t.key = 'portal.privacy' and t.deleted_at is null order by t.lang desc`);
  assert.match(rows[0]!.body, /^\*\*Responsable:\*\* \{\{entidad\.razon_social\}\}\. Contacto: \{\{contacto\.huespedes\}\} · \{\{contacto\.telefono\}\}\.$/m);
  assert.match(rows[1]!.body, /^\*\*Controller:\*\* \{\{entidad\.razon_social\}\}\. Contact: \{\{contacto\.huespedes\}\} · \{\{contacto\.telefono\}\}\.$/m);
  for (const r of rows) {
    assert.notEqual(r.version, before[r.lang], `${r.lang} sube de versión`);
    assert.doesNotMatch(r.body, /entidad\.(nif|domicilio)/);
    assert.doesNotMatch(r.rendered, new RegExp(`${ENTITY.tax_id}|${ENTITY.address_line}`));
  }
  // Ningún texto vivo lleva ya NIF ni domicilio fiscal; los marcadores siguen existiendo para los documentos fiscales.
  assert.equal((await q(`select 1 from central.texts where deleted_at is null and (body like '%{{entidad.nif}}%' or body like '%{{entidad.domicilio}}%')`)).length, 0);
  assert.equal((await q<{ b: string }>(`select central.render_text('{{entidad.nif}}') as b`))[0]!.b, ENTITY.tax_id);
});
