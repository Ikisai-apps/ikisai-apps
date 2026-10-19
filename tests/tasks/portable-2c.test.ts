/**
 * Tasks · 2c (R2/P2): la copia portable y el CSV con espacios de Recursos, oficios y personas de Central, responsable
 * persona o grupo y comentarios con foto (docs/tasks/API.md §6 y §30). De extremo a extremo sobre PGlite, con la
 * `tasks-api` real: exportar, revisar, importar y comparar; lo que ya no existe se quita y se avisa; una copia de antes de
 * la 2c se importa igual que siempre; y el CSV en modo etiquetas no cambia.
 * Nombres inventados: «Albergue Prueba», «Lucía Prueba», «Bruno Prueba».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CSV_COLUMNS, TABLES, compose, createTabOps, exportCSV, importCSV, importNotices, unzipStore, zipStore, type LegacyTab, type Operation,
} from '../../packages/domain-tasks/src/index.ts';
import { startE2EServer, type E2EServer } from './e2e-server.ts';

let server: E2EServer;
test.before(async () => { server = await startE2EServer(); });
test.after(async () => { await server.close(); });

const uuid = () => crypto.randomUUID();
const sql = (text: string, params: unknown[] = []) => server.app.t.db.query(text, params);
const raw = (path: string, init: { body?: BodyInit; type?: string } = {}) => server.app.handler(new Request(`http://localhost${path}`, {
  method: init.body === undefined ? 'GET' : 'POST',
  headers: { Origin: server.url, Authorization: 'Bearer ' + server.app.tokens.owner, ...(init.type ? { 'Content-Type': init.type } : {}) },
  body: init.body,
}));
const json = async (path: string, init: Parameters<typeof raw>[1] = {}) => { const r = await raw(path, init); return { status: r.status, data: await r.json() as any }; };
const ok = async (operations: Operation[]) => { const r = await server.commit(operations); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
const hex = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const setSource = async (key: string, value: string) => {
  await sql(`update tasks.settings set deleted_at = now() where key = $1 and deleted_at is null`, [key]);
  if (value !== 'labels') await sql(`insert into tasks.settings (key, value) values ($1, to_jsonb($2::text))`, [key, value]);
};

// Catálogo de pruebas: dos habitaciones de un edificio, dos oficios y dos personas.
const TAB = uuid(), INBOX = uuid(), OBRA = uuid(), PINTAR = uuid(), LIJAR = uuid(), VIEJA = uuid(), VIEW = uuid();
const FASE = uuid(), EDIFICIO = uuid(), HAB1 = uuid(), HAB2 = uuid(), FONTA = uuid(), PINTURA = uuid(), LUCIA = uuid(), BRUNO = uuid();
let photoSha = '', photoId = '', person = '';

async function seed() {
  const altura = (await sql(`select id from resources.spaces where name = 'Altura 3' and deleted_at is null`)).rows[0] as { id: string };
  await sql(`insert into resources.spaces (id, parent_id, kind, name, position) values ($1, $4, 'edificio', 'Albergue Prueba', 1), ($2, $1, 'habitacion', 'Hab 1', 1), ($3, $1, 'habitacion', 'Hab 2', 2)`, [EDIFICIO, HAB1, HAB2, altura.id]);
  await sql(`insert into central.trades (id, name) values ($1, 'Fontanería'), ($2, 'Pintura')`, [FONTA, PINTURA]);
  await sql(`insert into central.people (id, display_name, relation, house_level, initials, active) values ($1, 'Lucía Prueba', 'equipo', 'staff', 'LP', true), ($2, 'Bruno Prueba', 'equipo', 'outsider', 'BP', true)`, [LUCIA, BRUNO]);
  const tabOps = createTabOps({ id: TAB, name: 'Obra 2c', position: 90000, inboxId: INBOX });
  person = tabOps.find((o) => o.fields?.system_key === 'person')!.id!;
  const phase = tabOps.find((o) => o.fields?.system_key === 'phase')!.id!;
  await ok(tabOps);
  await ok([{ op: 'insert', table: 'tasks.labels', id: FASE, fields: { tab_id: TAB, family_id: phase, name: 'Fase 1' } }]);
  await ok([
    { op: 'insert', table: 'tasks.projects', id: OBRA, fields: { tab_id: TAB, title: 'Reforma albergue', position: 2048, owner_house_level: 'staff' } },
    { op: 'insert', table: 'tasks.tasks', id: PINTAR, fields: { tab_id: TAB, project_id: OBRA, title: 'Pintar habitaciones', position: 1024, owner_person_id: BRUNO } },
    { op: 'insert', table: 'tasks.tasks', id: LIJAR, fields: { tab_id: TAB, project_id: OBRA, title: 'Lijar puertas', position: 2048 } },
    { op: 'insert', table: 'tasks.tasks', id: VIEJA, fields: { tab_id: TAB, project_id: OBRA, title: 'Tarea en la papelera', position: 3072 } },
    { op: 'insert', table: 'tasks.task_labels', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, label_id: FASE } },
    { op: 'insert', table: 'tasks.task_dependencies', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: LIJAR, depends_on_id: PINTAR, position: 1024 } },
    { op: 'insert', table: 'tasks.project_spaces', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, space_id: EDIFICIO } },
    { op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, space_id: HAB1 } },
    { op: 'insert', table: 'tasks.task_spaces', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, space_id: HAB2 } },
    { op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, trade_id: PINTURA } },
    { op: 'insert', table: 'tasks.task_trades', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: LIJAR, trade_id: FONTA } },
    { op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, person_id: LUCIA } },
    { op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, person_id: BRUNO } },
    { op: 'insert', table: 'tasks.task_people', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: LIJAR, house_level: 'staff' } },
    { op: 'insert', table: 'tasks.saved_views', id: VIEW, fields: { tab_id: TAB, name: 'Pintura en el albergue', search: '', filters: { _space: [EDIFICIO], _trade: [PINTURA], _person: ['level:staff', BRUNO] }, group_by: '_space', position: 1024 } },
  ]);
  // Una foto (WebP) en un comentario, y un comentario en una tarea que después va a la papelera.
  const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 7, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0]);
  photoSha = await hex(bytes);
  const ticket = await json('/api/v1/uploads', { body: JSON.stringify({ filename: 'grieta.webp', mime: 'image/webp', size: bytes.byteLength, sha256: photoSha }), type: 'application/json' });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  server.app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await json(`/api/v1/uploads/${ticket.data.id}/verify`, { body: '{}', type: 'application/json' })).data.verified, true);
  photoId = ticket.data.id;
  await ok([
    { op: 'insert', table: 'tasks.task_comments', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, body: 'Hay una grieta junto a la ventana.', file_id: photoId } },
    { op: 'insert', table: 'tasks.task_comments', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: PINTAR, body: 'Ya está lijada.' } },
    { op: 'insert', table: 'tasks.task_comments', id: uuid(), fields: { tab_id: TAB, project_id: OBRA, task_id: VIEJA, body: 'Esta se queda en la papelera.' } },
  ]);
  await ok([{ op: 'delete', table: 'tasks.tasks', id: VIEJA, expectedRevision: 1 }]);
}

async function exportBundle() {
  const response = await raw('/api/v1/portable');
  assert.equal(response.status, 200);
  return new Uint8Array(await response.arrayBuffer());
}
/** Importa y devuelve también el área copiada de «Obra 2c» en esta importación (todas las copias nacen en la misma posición). */
async function importBundle(zip: Uint8Array, requestId: string) {
  const before = new Set((await server.rows('tasks.tabs')).map((t) => t.id));
  const preview = await json('/api/v1/portable/preview', { body: zip, type: 'application/zip' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const imported = await json('/api/v1/portable/import', { body: JSON.stringify({ ticket: preview.data.ticket, requestId }), type: 'application/json' });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  const copy = (await server.rows('tasks.tabs')).find((t) => !before.has(t.id) && t.name === 'Obra 2c (copia)')?.id as string;
  assert.ok(copy, 'la copia de «Obra 2c»');
  return { preview: preview.data, imported: imported.data, copy };
}
/** Lo que se compara de un área: por título, sus espacios, oficios, personas y responsables, y los comentarios. */
async function shape(tabId: string) {
  const all: Record<string, any[]> = {};
  for (const table of TABLES) all[table] = await server.rows(table);
  const tab = compose(all as any).find((t) => t.id === tabId)!;
  const comments = all['tasks.task_comments']!.filter((c) => c.tab_id === tabId && !c.deleted_at);
  const files = new Map((await sql(`select id, sha256 from core.files`)).rows.map((r: any) => [r.id, r.sha256]));
  const titleOf = new Map(tab.projects.flatMap((p) => p.tasks.map((t) => [t.id, t.text])));
  return {
    projects: tab.projects.filter((p) => !p.system).map((p) => ({
      title: p.title, ownSpaces: p.ownSpaces, ownTrades: p.ownTrades, ownPeople: p.ownPeople, ownerPerson: p.ownerPerson,
      tasks: p.tasks.map((t) => ({ text: t.text, deleted: t.deleted, spaces: t.spaces, trades: t.trades, people: t.people, ownerPerson: t.ownerPerson, labels: t.labels.length, deps: t.dependsOn.length })),
    })),
    views: tab.views.map((v) => ({ name: v.name, filters: v.filters, groupBy: v.groupBy })),
    comments: comments.map((c) => ({ task: titleOf.get(c.task_id), body: c.body, author: c.author_name, authorId: c.author_id, at: new Date(c.created_at).toISOString(), photo: c.file_id ? files.get(c.file_id) : null }))
      .sort((a, b) => (a.body < b.body ? -1 : 1)),
  };
}

test('2c · CSV en modo etiquetas: exactamente como antes; una columna «Espacio» se ignora con aviso', () => {
  const tab: LegacyTab = {
    id: TAB, name: 'Área', color: null, deleted: false, version: 1, updatedAt: '', views: [],
    families: [{ id: 'f1', name: 'Persona', color: '#000', archived: false, system: 'person', version: 1 }],
    labels: [{ id: 'l1', text: 'Juan', family: 'f1', parent: null, archived: false, version: 1 }],
    projects: [{ id: OBRA, title: 'Obra', note: '', status: 'active', priority: 'normal', due: '', ownLabels: [], owner: null, ownSpaces: [EDIFICIO], attachments: [], deleted: false, deletedAt: null, order: 1, color: null, budget: null, system: null, version: 1, updatedAt: '', tasks: [
      { id: PINTAR, text: 'Pintar', note: '', done: false, priority: 'normal', due: '', labels: ['l1'], owner: 'l1', parentId: null, spaces: [HAB1], trades: [FONTA], people: [LUCIA], order: 1, attachments: [], deleted: false, deletedAt: null, deleteBatch: null, dependsOn: [], cost: null, version: 1, updatedAt: '' },
    ] }],
  };
  const csv = exportCSV(tab);
  assert.equal(csv, exportCSV(tab, {}));
  assert.equal(csv.split('\r\n')[0], '﻿' + CSV_COLUMNS.join(','), 'sin fuentes activas, las cabeceras de siempre');
  assert.equal(csv.split('\r\n')[1], `Obra,${PINTAR},,Pintar,,0,normal,,"[{""family"":""person"",""text"":""Juan""}]","{""family"":""person"",""text"":""Juan""}",[]`);
  const target: LegacyTab = { ...structuredClone(tab), projects: [] };
  const result = importCSV(target, 'project,text,Espacio\nObra,Barrer,Albergue Prueba\n');
  assert.deepEqual(result.warnings, ['La columna «Espacio» se ignora: esta app usa zonas (etiquetas).']);
  assert.equal(target.projects[0]!.tasks[0]!.spaces, undefined, 'sin la fuente activa, no se tocan los espacios');
});

test('2c · avisos de la importación: lo quitado, en una frase; y otras fuentes en la copia que aquí no se verán', () => {
  const labels = { zoneSource: 'labels', tradeSource: 'labels', peopleSource: 'labels' } as const;
  assert.deepEqual(importNotices({ spaces: ['a', 'b', 'c'], trades: ['d'], people: ['e', 'f'] }, null, labels), ['3 espacios, 1 oficio y 2 personas que ya no existen se han quitado.']);
  assert.deepEqual(importNotices({ spaces: [], trades: ['d'], people: [] }, null, labels), ['1 oficio que ya no existe se ha quitado.']);
  assert.deepEqual(importNotices(null, { ...labels, zoneSource: 'spaces' }, labels), ['La copia usa espacios de Recursos y esta app usa zonas (etiquetas): los espacios de la copia se guardan, pero no se ven hasta cambiar de modo.']);
  assert.deepEqual(importNotices(null, labels, { ...labels, tradeSource: 'central' }), [], 'una copia en etiquetas no avisa: sus etiquetas se ven en cualquier modo');
});

test('2c · copia portable de ida y vuelta: espacios, oficios, personas, responsables y comentarios con foto', async () => {
  await seed();
  for (const [key, value] of [['zone_source', 'spaces'], ['trade_source', 'central'], ['people_source', 'central']]) await setSource(key!, value!);
  const zip = await exportBundle();
  const entries = new Map(unzipStore(zip).map((e) => [e.path, e.bytes]));
  assert.ok(entries.has(`files/${photoSha}`), 'la foto del comentario viaja como un adjunto');
  const data = JSON.parse(new TextDecoder().decode(entries.get('data.json')));
  assert.deepEqual(data.settings, { zoneSource: 'spaces', tradeSource: 'central', peopleSource: 'central' });
  assert.equal(data.comments.filter((c: any) => c.photo?.sha256 === photoSha).length, 1);

  const { preview, imported, copy } = await importBundle(zip, 'importar-2c-1');
  const summary = preview.summary;
  assert.deepEqual([summary.spaces, summary.trades, summary.people, summary.comments], [3, 2, 3, 3]);
  assert.deepEqual(preview.notices, [], 'mismas fuentes: sin avisos');
  assert.deepEqual(imported.dropped, { spaces: [], trades: [], people: [] });
  assert.deepEqual(imported.notices, []);
  assert.ok(imported.inserted['tasks.task_spaces'] >= 2 && imported.inserted['tasks.task_comments'] >= 3, JSON.stringify(imported.inserted));

  const before = await shape(TAB), after = await shape(copy);
  assert.deepEqual(after.projects, before.projects, 'mismos espacios, oficios, personas y responsables');
  assert.deepEqual(after.views, before.views, 'la vista guardada conserva sus filtros de espacio, oficio y persona');
  assert.deepEqual(after.comments, before.comments, 'mismos comentarios, autor, hora y foto (también el de la tarea en la papelera)');
  assert.equal(before.comments.length, 3);
  const copiedComment = (await server.rows('tasks.task_comments')).find((c) => c.tab_id === copy && c.file_id);
  assert.equal(copiedComment.file_id, photoId, 'la foto con la misma huella se reutiliza');
  assert.equal((await server.rows('tasks.tasks')).some((t) => t.tab_id === copy && t.id === PINTAR), false, 'ids independientes');
});

test('2c · importar con un espacio, un oficio y una persona que ya no están vivos: se quitan y se avisa', async () => {
  await sql(`update resources.spaces set active = false where id = $1`, [HAB2]);
  await sql(`update central.trades set active = false where id = $1`, [PINTURA]);
  await sql(`update central.people set active = false where id = $1`, [BRUNO]);
  const { imported, copy } = await importBundle(await exportBundle(), 'importar-2c-2');
  assert.deepEqual(imported.dropped, { spaces: [HAB2], trades: [PINTURA], people: [BRUNO] });
  assert.deepEqual(imported.notices, ['1 espacio, 1 oficio y 1 persona que ya no existen se han quitado.']);
  const after = await shape(copy);
  const pintar = after.projects[0]!.tasks.find((t) => t.text === 'Pintar habitaciones')!;
  assert.deepEqual([pintar.spaces, pintar.trades, pintar.people, pintar.ownerPerson], [[HAB1], undefined, [LUCIA], undefined], 'lo vivo se queda; el responsable que ya no existe se vacía');
  assert.equal(after.projects[0]!.ownerPerson, 'level:staff', 'un grupo nunca caduca');
  assert.deepEqual(after.views[0]!.filters, { _space: [EDIFICIO], _trade: [], _person: ['level:staff'] }, 'los filtros de la vista se limpian');
  await sql(`update resources.spaces set active = true where id = $1`, [HAB2]);
  await sql(`update central.trades set active = true where id = $1`, [PINTURA]);
  await sql(`update central.people set active = true where id = $1`, [BRUNO]);
});

test('2c · una copia de antes de la 2c (sin ajustes, comentarios ni espacios) se importa igual que siempre', async () => {
  const entries = unzipStore(await exportBundle());
  const data = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === 'data.json')!.bytes));
  // La forma antigua: solo `tabs`, sin los campos nuevos de tareas, proyectos y vistas.
  const strip = (o: any) => { for (const k of ['spaces', 'trades', 'people', 'ownerPerson', 'ownSpaces', 'ownTrades', 'ownPeople']) delete o[k]; };
  const tabs = data.tabs.filter((t: any) => t.id === TAB).map((t: any) => {
    t.views = [];
    for (const p of t.projects) { strip(p); for (const x of p.tasks) strip(x); }
    return t;
  });
  const dataBytes = new TextEncoder().encode(JSON.stringify({ tabs }));
  const manifest = JSON.parse(new TextDecoder().decode(entries.find((e) => e.path === 'manifest.json')!.bytes));
  manifest.data.sha256 = await hex(dataBytes);
  manifest.files = manifest.files.filter((f: any) => f.sha256 !== photoSha);
  const old = zipStore([{ path: 'manifest.json', bytes: new TextEncoder().encode(JSON.stringify(manifest)) }, { path: 'data.json', bytes: dataBytes },
    ...entries.filter((e) => e.path.startsWith('files/') && e.path !== `files/${photoSha}`)]);
  const { preview, imported, copy } = await importBundle(old, 'importar-antigua');
  assert.equal(preview.summary.settings, null);
  assert.deepEqual([preview.summary.spaces, preview.summary.comments], [0, 0]);
  assert.deepEqual(imported.dropped, { spaces: [], trades: [], people: [] });
  const before = await shape(TAB), after = await shape(copy);
  const plain = (s: Awaited<ReturnType<typeof shape>>) => s.projects.map((p) => ({ title: p.title, tasks: p.tasks.map((t) => ({ text: t.text, deleted: t.deleted, labels: t.labels, deps: t.deps })) }));
  assert.deepEqual(plain(after), plain(before), 'todo lo que traía la copia antigua queda igual');
  assert.ok(after.projects[0]!.tasks.every((t) => !t.spaces && !t.trades && !t.people && !t.ownerPerson), 'nada nuevo inventado: ' + JSON.stringify(after.projects));
  assert.deepEqual(after.comments, []);
});

test('2c · CSV con «Espacio», «Oficio» y «Personas»: ida y vuelta, y un nombre que no casa va a los avisos', async () => {
  const exported = await (await raw(`/api/v1/csv?tabId=${TAB}`)).text();
  const [header, ...lines] = exported.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(header, [...CSV_COLUMNS, 'Espacio', 'Oficio', 'Personas'].join(','));
  const pintar = lines.find((l) => l.includes('Pintar habitaciones'))!;
  const [where, trade, who] = pintar.split(',').slice(-3).map((c) => c.split(' | ').sort());
  assert.deepEqual([where, trade, who], [['Albergue Prueba › Hab 1', 'Albergue Prueba › Hab 2'], ['Pintura'], ['Bruno Prueba (BP)', 'Lucía Prueba (LP)']], pintar);
  assert.ok(pintar.includes(',Bruno Prueba (BP),'), 'el responsable persona va en owner como texto');
  assert.ok(lines.find((l) => l.includes('Lijar puertas'))!.endsWith(',,Fontanería,Todo el staff'));

  // Vuelta: el mismo CSV y una fila escrita a mano, sin tildes ni mayúsculas, con un oficio que no existe.
  const source = exported + 'Reforma albergue,,,Revisar grifos,,0,normal,,[],lucia prueba,[],albergue prueba > hab 2,FONTANERIA | Carpintería inventada,LP | todo el staff\r\n';
  const preview = await json(`/api/v1/csv/preview?tabId=${TAB}`, { body: source, type: 'text/csv' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.warnings, ['Fila 4 · Oficio: «Carpintería inventada» no casa con ningún oficio de Central; se deja fuera.']);
  await ok(preview.data.operations);
  const project = (await server.rows('tasks.projects')).find((p) => p.title === 'Reforma albergue (CSV)' && p.tab_id === TAB);
  const tasks = (await server.rows('tasks.tasks')).filter((t) => t.project_id === project.id);
  const of = (title: string) => tasks.find((t) => t.title === title);
  const spaces = async (id: string) => (await server.rows('tasks.task_spaces')).filter((r) => r.task_id === id && !r.deleted_at).map((r) => r.space_id).sort();
  const trades = async (id: string) => (await server.rows('tasks.task_trades')).filter((r) => r.task_id === id && !r.deleted_at).map((r) => r.trade_id).sort();
  const people = async (id: string) => (await server.rows('tasks.task_people')).filter((r) => r.task_id === id && !r.deleted_at).map((r) => r.person_id ?? `level:${r.house_level}`).sort();
  assert.deepEqual(await spaces(of('Pintar habitaciones').id), [HAB1, HAB2].sort());
  assert.deepEqual(await trades(of('Pintar habitaciones').id), [PINTURA]);
  assert.deepEqual(await people(of('Pintar habitaciones').id), [BRUNO, LUCIA].sort());
  assert.equal(of('Pintar habitaciones').owner_person_id, BRUNO);
  assert.deepEqual(await people(of('Lijar puertas').id), ['level:staff']);
  assert.deepEqual(await spaces(of('Revisar grifos').id), [HAB2]);
  assert.deepEqual(await trades(of('Revisar grifos').id), [FONTA]);
  assert.deepEqual(await people(of('Revisar grifos').id), [LUCIA, 'level:staff'].sort());
  assert.equal(of('Revisar grifos').owner_person_id, LUCIA);
  void person;
});
