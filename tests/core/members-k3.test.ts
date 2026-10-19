/** K3 para miembros (`uploads.membersK3`): con la opción, un miembro que no es propietario no lee un archivo ajeno por su id
 *  salvo que vea una fila viva que lo referencia; el propietario y lo propio, siempre. Sin la opción, nada cambia. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const ORIGIN = 'https://tasks.ikisai.com';
const OPEN = crypto.randomUUID();

async function setup(membersK3: boolean) {
  const app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin: ORIGIN, createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api', origins: [ORIGIN],
    uploads: { bucket: 'tasks-attachments', membersK3 },
    hooks: { visible: (_t, row, ctx) => ctx.membership.role === 'owner' || row.project_id === OPEN } }) });
  await app.t.db.exec(`create table public.test_photos (id uuid primary key, project_id uuid not null, file_id uuid, deleted_at timestamptz);
    select core.register_file_field('tasks', 'public', 'test_photos', 'file_id', 'operational');`);
  return app;
}
const ticket = (app: TestApp, token: string) => app.call('/api/v1/uploads', { token, body: { filename: 'f', mime: 'image/png', size: 10, sha256: 'c'.repeat(64) } });
async function upload(app: TestApp, token: string, project: string | null) {
  const t = await ticket(app, token);
  assert.equal(t.status, 200, JSON.stringify(t.data));
  await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [t.data.id]);
  if (project) await app.t.db.query('insert into public.test_photos (id, project_id, file_id) values ($1, $2, $3)', [crypto.randomUUID(), project, t.data.id]);
  return t.data.id as string;
}
const status = async (app: TestApp, id: string, token: string) => (await app.call(`/api/v1/files/${id}`, { token })).status;

test('membersK3 · el editor no lee un archivo ajeno de lo que no ve; sí lo que ve, lo suyo, y el propietario todo', async () => {
  const app = await setup(true);
  try {
    const hidden = await upload(app, app.tokens.owner, crypto.randomUUID());
    const shown = await upload(app, app.tokens.owner, OPEN);
    const orphan = await upload(app, app.tokens.owner, null);
    const own = await upload(app, app.tokens.editor, null);
    assert.equal(await status(app, hidden, app.tokens.editor), 404, 'fila que no ve');
    assert.equal(await status(app, orphan, app.tokens.editor), 404, 'ajeno sin referencia');
    assert.notEqual(await status(app, shown, app.tokens.editor), 404, 'fila que ve');
    assert.notEqual(await status(app, own, app.tokens.editor), 404, 'lo suyo');
    for (const id of [hidden, orphan, own]) assert.notEqual(await status(app, id, app.tokens.owner), 404, 'propietario');
  } finally { await app.close(); }
});

test('membersK3 · sin la opción, el miembro lee como antes (ninguna app cambia hasta activarla)', async () => {
  const app = await setup(false);
  try {
    const hidden = await upload(app, app.tokens.owner, crypto.randomUUID());
    assert.notEqual(await status(app, hidden, app.tokens.editor), 404);
  } finally { await app.close(); }
});
