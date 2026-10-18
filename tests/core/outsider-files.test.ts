/** Archivos y outsider (O1): solo imágenes pequeñas al subir y, al leer, la regla K3 de los portales (conocer el id no basta). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
let app: TestApp;
let outsider: string;
const OPEN = crypto.randomUUID();

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api', origins: [ORIGIN],
    uploads: { bucket: 'tasks-attachments', allowOutsiders: true },
    hooks: { visible: (_t, row, ctx) => ctx.membership.role !== 'outsider' || row.project_id === OPEN } }) });
  await app.t.db.exec(`create table public.test_photos (id uuid primary key, project_id uuid not null, file_id uuid, deleted_at timestamptz);
    select core.register_file_field('tasks', 'public', 'test_photos', 'file_id', 'operational');`);
  const user = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'outsider', null)`, [user]);
  outsider = app.supabase.tokenFor(user);
});
test.after(async () => { await app.close(); });

const ticket = (token: string, mime: string, size: number) => app.call('/api/v1/uploads', { token, body: { filename: 'f', mime, size, sha256: 'c'.repeat(64) } });

test('outsider · sube solo imágenes JPEG, PNG o WebP de hasta 10 MB; el editor, como siempre', async () => {
  assert.equal((await ticket(outsider, 'image/jpeg', 1000)).status, 200);
  assert.equal((await ticket(outsider, 'application/pdf', 1000)).status, 422);
  assert.equal((await ticket(outsider, 'image/png', 11 * 1024 * 1024)).status, 413);
  assert.equal((await ticket(app.tokens.editor, 'application/pdf', 11 * 1024 * 1024)).status, 200);
});

test('outsider · K3: no lee un archivo ajeno por su id salvo que vea una fila que lo referencia; el editor sí', async () => {
  const upload = async (project: string) => {
    const t = await ticket(app.tokens.editor, 'image/png', 10);
    assert.equal(t.status, 200, JSON.stringify(t.data));
    await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [t.data.id]);
    await app.t.db.query('insert into public.test_photos (id, project_id, file_id) values ($1, $2, $3)', [crypto.randomUUID(), project, t.data.id]);
    return t.data.id as string;
  };
  const visibleFile = await upload(OPEN);
  const hiddenFile = await upload(crypto.randomUUID());
  assert.equal((await app.call(`/api/v1/files/${hiddenFile}`, { token: outsider })).status, 404, 'proyecto no abierto');
  assert.notEqual((await app.call(`/api/v1/files/${visibleFile}`, { token: outsider })).status, 404, 'proyecto abierto');
  assert.notEqual((await app.call(`/api/v1/files/${hiddenFile}`, { token: app.tokens.editor })).status, 404, 'el editor no cambia');
  const own = await ticket(outsider, 'image/webp', 10);
  await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [own.data.id]);
  assert.notEqual((await app.call(`/api/v1/files/${own.data.id}`, { token: outsider })).status, 404, 'lo suyo, siempre');
});
