/** Tasks · intercambio: ZIP, CSV y copia portable (dominio) y sus rutas en `tasks-api` (filtros REST, CSV, portable, respaldo). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CSV_COLUMNS, DomainError, crc32, parseCSV, unzipStore, zipStore } from '../../packages/domain-tasks/src/index.ts';
import { startE2EServer, type E2EServer } from './e2e-server.ts';
import { seedDemo, type Aliases } from './e2e-helpers.ts';

let server: E2EServer;
let ID: Aliases;
test.before(async () => { server = await startE2EServer(); ID = await seedDemo(server); });
test.after(async () => { await server.close(); });

const raw = (path: string, init: { method?: string; token?: string; body?: BodyInit; type?: string } = {}) => server.app.handler(new Request(`http://localhost${path}`, {
  method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
  headers: { Origin: server.url, Authorization: 'Bearer ' + (init.token ?? server.app.tokens.owner), ...(init.type ? { 'Content-Type': init.type } : {}) },
  body: init.body,
}));
const json = async (path: string, init: Parameters<typeof raw>[1] = {}) => { const r = await raw(path, init); return { status: r.status, data: await r.json() as any }; };
const code = (fn: () => unknown) => { try { fn(); } catch (e) { assert.ok(e instanceof DomainError, String(e)); return e.code; } return 'OK'; };

test('zip: ida y vuelta sin compresión, CRC y rechazo de entradas alteradas o comprimidas', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  const entries = [{ path: 'manifest.json', bytes: new TextEncoder().encode('{"ñ":1}') }, { path: 'files/abc', bytes: new Uint8Array([0, 1, 2, 255]) }, { path: 'vacío.txt', bytes: new Uint8Array() }];
  const zip = zipStore(entries);
  assert.deepEqual([zip[0], zip[1]], [0x50, 0x4b]);
  assert.deepEqual(unzipStore(zip).map((e) => [e.path, [...e.bytes]]), entries.map((e) => [e.path, [...e.bytes]]));
  const tampered = zip.slice(); tampered[30 + 'manifest.json'.length + 2]! ^= 0xff;
  assert.equal(code(() => unzipStore(tampered)), 'INVALID_BUNDLE');
  assert.equal(code(() => unzipStore(new Uint8Array(40))), 'INVALID_BUNDLE');
  assert.equal(code(() => unzipStore(zipStore([{ path: '../fuera', bytes: new Uint8Array() }]))), 'INVALID_BUNDLE');
});

test('csv: análisis con comillas, punto y coma y cabeceras obligatorias', () => {
  assert.deepEqual(parseCSV('project,text,note\r\nObra,"Pintar, dos manos","dijo ""ya"""\n'), [{ project: 'Obra', text: 'Pintar, dos manos', note: 'dijo "ya"' }]);
  assert.deepEqual(parseCSV('﻿project;text\nObra;Lijar\n'), [{ project: 'Obra', text: 'Lijar' }]);
  assert.equal(code(() => parseCSV('text\nSin proyecto\n')), 'INVALID_CSV');
  assert.equal(code(() => parseCSV('project,text,otra\nA,B,C\n')), 'INVALID_CSV');
  assert.equal(code(() => parseCSV('project,text\nA,"sin cerrar\n')), 'INVALID_CSV');
  assert.ok(CSV_COLUMNS.includes('depends_on'));
});

test('[44] GET tabs/:tabId/tasks filtra por disponibilidad, estado, proyecto y texto', async () => {
  const dep = await server.commit([{ op: 'insert', table: 'tasks.task_dependencies', id: crypto.randomUUID(), fields: { tab_id: ID.ikisai, project_id: ID.p1, task_id: ID.t4, depends_on_id: ID.t2, position: 1024 } }]);
  assert.equal(dep.status, 200);
  const blocked = await json(`/api/v1/tabs/${ID.ikisai}/tasks?availability=blocked`);
  assert.equal(blocked.status, 200);
  assert.deepEqual(blocked.data.items.map((t: any) => t.id), [ID.t4]);
  assert.deepEqual(blocked.data.items[0].blockedBy, [ID.t2]);
  const ready = await json(`/api/v1/tabs/${ID.ikisai}/tasks?availability=ready&limit=500`);
  assert.equal(ready.data.items.some((t: any) => t.id === ID.t4 || t.done), false);
  assert.ok(ready.data.items.some((t: any) => t.id === ID.t2));
  const done = await json(`/api/v1/tabs/${ID.ikisai}/tasks?state=done&projectId=${ID.p2}`);
  assert.deepEqual(done.data.items.map((t: any) => t.id), [ID.t5]);
  assert.deepEqual((await json(`/api/v1/tabs/${ID.ikisai}/tasks?q=${encodeURIComponent('agua fría')}`)).data.items.map((t: any) => t.id), [ID.t2]);
  assert.equal((await json(`/api/v1/tabs/${ID.ikisai}/tasks?label=${ID.juan}`)).data.total > 0, true);
  assert.equal((await json(`/api/v1/tabs/${ID.ikisai}/tasks?availability=quizá`)).data.error.code, 'INVALID_FILTER');
  assert.equal((await json(`/api/v1/tabs/${crypto.randomUUID()}/tasks`)).status, 404);
});

test('[33] CSV: exportar, previsualizar sin escribir, confirmar por commands y volver a exportar', async () => {
  const exported = await raw(`/api/v1/csv?tabId=${ID.ikisai}`);
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename=Ikisai-tareas.csv');
  const exportedBytes = new Uint8Array(await exported.arrayBuffer());
  assert.deepEqual([...exportedBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'lleva BOM para que Excel lo abra como UTF-8');
  const text = new TextDecoder().decode(exportedBytes);
  assert.ok(text.startsWith(CSV_COLUMNS.join(',')));
  assert.ok(text.includes('Sustituir puerta dañada') && text.includes('{""family"":""person"",""text"":""Juan""}'));

  const source = 'project,task_id,parent_id,text,note,done,labels,owner,depends_on\nCSV navegador,1,,Padre CSV,Nota,0,"[{""family"":""trade"",""text"":""Fontanería""},{""family"":""Zona"",""text"":""Norte""}]","{""family"":""person"",""text"":""Juan""}",\nCSV navegador,2,1,Hija CSV,,1,,,\nCSV navegador,3,,=Suelta,,0,,,"[""1""]"\n';
  const before = (await server.rows('tasks.projects')).length;
  const preview = await json(`/api/v1/csv/preview?tabId=${ID.ikisai}`, { body: source, type: 'text/csv' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.summary, { tasks: 3, projects: 1, children: 1 });
  assert.equal((await server.rows('tasks.projects')).length, before, 'la previsualización no escribe');
  const applied = await server.commit(preview.data.operations);
  assert.equal(applied.status, 200, JSON.stringify(applied.data));
  const project = (await server.rows('tasks.projects')).find((r) => r.title === 'CSV navegador (CSV)');
  const tasks = (await server.rows('tasks.tasks')).filter((r) => r.project_id === project.id);
  const byTitle = (title: string) => tasks.find((t) => t.title === title);
  assert.equal(byTitle('Hija CSV').parent_id, byTitle('Padre CSV').id);
  assert.equal(byTitle('Padre CSV').owner_label_id, ID.juan);
  assert.equal(byTitle('=Suelta') !== undefined, true);
  assert.ok((await server.rows('tasks.task_dependencies')).some((d) => d.task_id === byTitle('=Suelta').id && d.depends_on_id === byTitle('Padre CSV').id));
  assert.ok((await server.rows('tasks.families')).some((f) => f.tab_id === ID.ikisai && f.name === 'Zona'));
  assert.ok((await server.rows('tasks.task_labels')).some((l) => l.task_id === byTitle('Padre CSV').id && l.label_id === ID.font));
  // Una celda que empieza por «=» se exporta protegida contra fórmulas y vuelve a entrar igual.
  assert.ok((await (await raw(`/api/v1/csv?tabId=${ID.ikisai}`)).text()).includes("'=Suelta"));

  const bad = await json(`/api/v1/csv/preview?tabId=${ID.ikisai}`, { body: 'project,text,depends_on\nA,B,"[""no-existe""]"\n', type: 'text/csv' });
  assert.equal(`${bad.status} ${bad.data.error.code}`, '422 INVALID_CSV');
  assert.equal((await json(`/api/v1/csv/preview?tabId=${ID.ikisai}`, { body: source, type: 'text/csv', token: server.app.tokens.reader })).status, 403);
});

test('[24][32] copia portable y respaldo: exportar con adjuntos, previsualizar, importar como áreas nuevas y reintentar sin duplicar', async () => {
  // Un adjunto real en el proyecto p1.
  const bytes = new TextEncoder().encode('%PDF-1.4 plano portable');
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const ticket = await json('/api/v1/uploads', { body: JSON.stringify({ filename: 'plano.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha }), type: 'application/json' });
  server.app.supabase.storage.set(ticket.data.path, bytes);
  assert.equal((await json(`/api/v1/uploads/${ticket.data.id}/verify`, { body: '{}', type: 'application/json' })).data.verified, true);
  const attached = await server.commit([{ op: 'insert', table: 'tasks.attachments', id: crypto.randomUUID(), fields: { tab_id: ID.ikisai, project_id: ID.p1, task_id: ID.t1, name: 'plano.pdf', mime: 'application/pdf', size: bytes.byteLength, sha256: sha, file_id: ticket.data.id } }]);
  assert.equal(attached.status, 200, JSON.stringify(attached.data));
  await server.commit([{ op: 'delete', table: 'tasks.tasks', id: ID.t9, expectedRevision: 1 }]);

  const exported = await raw('/api/v1/portable');
  assert.equal(exported.headers.get('content-disposition'), 'attachment; filename=Ikisai-portable.zip');
  const zip = new Uint8Array(await exported.arrayBuffer());
  const entries = unzipStore(zip);
  assert.deepEqual(entries.map((e) => e.path).slice(0, 2), ['manifest.json', 'data.json']);
  assert.ok(entries.some((e) => e.path === `files/${sha}`));

  const backup = await raw('/api/v1/backup');
  assert.equal(backup.headers.get('content-disposition'), 'attachment; filename=Ikisai-respaldo.zip');
  assert.deepEqual([...new Uint8Array(await backup.arrayBuffer()).subarray(0, 2)], [0x50, 0x4b]);
  assert.equal((await raw('/api/v1/backup', { token: server.app.tokens.editor })).status, 403);

  const tabsBefore = (await server.rows('tasks.tabs')).length, tasksBefore = (await server.rows('tasks.tasks')).length;
  assert.equal((await json('/api/v1/portable/preview', { body: zip, type: 'application/zip', token: server.app.tokens.editor })).status, 403);
  const preview = await json('/api/v1/portable/preview', { body: zip, type: 'application/zip' });
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.equal(preview.data.summary.tabs.length, tabsBefore);
  assert.equal(preview.data.summary.attachments, 1);
  assert.equal((await server.rows('tasks.tabs')).length, tabsBefore, 'la previsualización no escribe');

  const body = JSON.stringify({ ticket: preview.data.ticket, requestId: 'import-prueba-1' });
  const imported = await json('/api/v1/portable/import', { body, type: 'application/json' });
  assert.equal(imported.status, 200, JSON.stringify(imported.data));
  assert.equal(imported.data.inserted['tasks.tabs'], tabsBefore);
  const again = await json('/api/v1/portable/import', { body, type: 'application/json' });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.replayed, true);
  const tabs = await server.rows('tasks.tabs');
  assert.equal(tabs.length, tabsBefore * 2, 'una sola copia aunque se reintente');
  assert.equal((await server.rows('tasks.tasks')).length, tasksBefore * 2);
  const copy = tabs.find((t) => t.name === 'Ikisai (copia)');
  const copied = (await server.rows('tasks.tasks')).filter((t) => t.tab_id === copy.id);
  assert.ok(copied.find((t) => t.title === 'Ordenar herramientas de mango largo').deleted_at, 'lo que estaba en la papelera sigue en la papelera');
  assert.equal(copied.some((t) => t.id === ID.t1), false, 'ids independientes');
  const copiedAttachment = (await server.rows('tasks.attachments')).find((r) => r.tab_id === copy.id);
  assert.equal(copiedAttachment.sha256, sha);
  assert.equal(copiedAttachment.file_id, ticket.data.id, 'el archivo con la misma huella se reutiliza');
  const copiedDependencies = (await server.rows('tasks.task_dependencies')).filter((d) => d.tab_id === copy.id);
  assert.equal(copiedDependencies.length, (await server.rows('tasks.task_dependencies')).filter((d) => d.tab_id === ID.ikisai).length);
  assert.equal((await server.rows('tasks.projects')).filter((p) => p.tab_id === copy.id && p.system === 'inbox').length, 1);

  // Copias alteradas o caducadas.
  const tampered = zip.slice(); tampered[tampered.length - 200]! ^= 0x01;
  assert.equal((await json('/api/v1/portable/preview', { body: tampered, type: 'application/zip' })).data.error.code, 'INVALID_BUNDLE');
  const expired = await json('/api/v1/portable/import', { body: JSON.stringify({ ticket: `1000000000.${'a'.repeat(64)}`, requestId: 'import-prueba-2' }), type: 'application/json' });
  assert.equal(`${expired.status} ${expired.data.error.code}`, '409 IMPORT_UNAVAILABLE');
});
