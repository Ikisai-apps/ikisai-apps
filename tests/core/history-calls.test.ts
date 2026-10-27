/** FL3 (auditoría, 27-10-2026): en `GET history`, un `call` lleva argumentos (`before`) y resultado (`after`). Entero solo lo
 *  ven el owner de la app y quien lo hizo; los demás (editor, lector, outsider) ven la entrada con el procedimiento y sin
 *  argumentos ni resultado, con el mismo cursor. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const SECRET = 'Proyecto secreto de Marta';
let app: TestApp;
let seq = 0;
const rid = () => `fl3-${++seq}`;
const q = (sql: string, params: unknown[] = []) => app.t.db.query(sql, params);

test.before(async () => {
  app = await createTestApp({
    app: 'tasks', slug: 'tasks-api', origin: 'https://tasks.ikisai.com',
    createHandler: (config) => createApp({ ...config, app: 'tasks', slug: 'tasks-api' }),
  });
  await q(`create function tasks.fl3_echo(p jsonb) returns jsonb language sql as 'select jsonb_build_object(''echo'', p)'`);
  await q(`select core.allow_procedure('tasks', 'tasks.fl3_echo')`);
  await q(`select core.allow_outsider_procedure('tasks', 'tasks.fl3_echo')`);
});
test.after(async () => { await app.close(); });

const call = async (token: string, name: string) => {
  const res = await app.call('/api/v1/commands', { token, body: { requestId: rid(), operations: [{ op: 'call', procedure: 'tasks.fl3_echo', args: { name } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.cursor as number;
};
const entry = async (token: string, cursor: number) => {
  const res = await app.call('/api/v1/history?limit=50', { token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const item = res.data.items.find((i: any) => i.cursor === cursor);
  assert.ok(item, `el lote ${cursor} sigue en el historial`);
  assert.equal(item.changes.length, 1);
  return item.changes[0];
};

test('FL3 · history: el call entero al owner y a quien lo hizo; al editor, al lector y al outsider, sin argumentos ni resultado', async () => {
  const outsider = await app.t.createUser();
  await q(`select core.apply_house_level($1, 'outsider')`, [outsider]);
  const outsiderToken = app.supabase.tokenFor(outsider);
  const otherEditor = await app.t.createUser();
  await q(`insert into core.memberships (app, user_id, role) values ('tasks', $1, 'editor')`, [otherEditor]);
  const otherEditorToken = app.supabase.tokenFor(otherEditor);

  const cursor = await call(app.tokens.editor, SECRET);

  for (const [who, token] of [['quien lo hizo', app.tokens.editor], ['owner', app.tokens.owner]] as const) {
    const c = await entry(token, cursor);
    assert.equal(c.op, 'call', who);
    assert.equal(c.before.name, SECRET, `${who}: argumentos`);
    assert.equal(c.after.echo.name, SECRET, `${who}: resultado`);
    assert.equal(c.redacted, undefined, who);
  }
  for (const [who, token] of [['otro editor', otherEditorToken], ['lector', app.tokens.reader], ['outsider', outsiderToken]] as const) {
    const c = await entry(token, cursor);
    assert.deepEqual([c.op, c.table, c.before, c.after, c.redacted], ['call', 'tasks.fl3_echo', null, null, true], who);
    assert.equal(JSON.stringify(c).includes(SECRET), false, `${who}: nada del nombre`);
  }

  // El outsider ve entero lo suyo; el editor que hizo el primero ya no ve lo del outsider.
  const own = await call(outsiderToken, 'Lo mío');
  assert.equal((await entry(outsiderToken, own)).before.name, 'Lo mío');
  assert.equal((await entry(app.tokens.editor, own)).before, null);

  // El cursor y la paginación no cambian: el mismo número de lotes para el owner y para el outsider.
  const page = async (token: string) => (await app.call('/api/v1/history?limit=1', { token })).data;
  const [ownerPage, outsiderPage] = [await page(app.tokens.owner), await page(outsiderToken)];
  assert.deepEqual([outsiderPage.items[0].cursor, outsiderPage.nextBefore, outsiderPage.hasMore], [ownerPage.items[0].cursor, ownerPage.nextBefore, ownerPage.hasMore]);
});
