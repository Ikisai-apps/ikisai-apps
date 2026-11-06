/**
 * Central · «También para todos los eventos» (VG, 06-11; central-U1): Booking pide a Central un uso para un espacio por
 * `worker/space-use`; Central lo escribe en Recursos como «Central (sistema)» con client_app central. Datos ficticios.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';
import { checkSpaceUseRequest, spaceUseRequestId } from '../../supabase/functions/_domain/central/mod.ts';

const WORKER_KEY = 'clave-de-worker-ficticia';
let app: TestApp;
const uuid = () => crypto.randomUUID();
const ask = (body: unknown, caller = 'booking', key = WORKER_KEY) =>
  app.call('/api/v1/worker/space-use', { token: null, body, headers: { 'X-Ikisai-Worker-Key': key, 'X-Ikisai-Caller': caller } });

test.before(async () => {
  app = await createTestApp({ app: 'central', slug: 'central-api', origin: CENTRAL_ORIGINS[0]!, createHandler: (c) => createCentralApp({ ...c, origins: [CENTRAL_ORIGINS[0]!], workerKey: WORKER_KEY }) });
});
test.after(async () => { await app.close(); });

test('usos · dominio: la petición y su rastro', () => {
  const id = uuid();
  const ok = checkSpaceUseRequest({ space_id: id, use: 'alojamiento', source_ref: `booking:reservation:${id}`, requested_by: id });
  assert.ok('request' in ok);
  assert.ok(spaceUseRequestId((ok as any).request).length <= 120);
  assert.deepEqual(checkSpaceUseRequest({ space_id: id, use: 'piscina', source_ref: `booking:reservation:${id}`, requested_by: id }), { field: 'use' });
  assert.deepEqual(checkSpaceUseRequest({ space_id: id, use: 'eventos', source_ref: 'tasks:x', requested_by: id }), { field: 'source_ref' });
  assert.deepEqual(checkSpaceUseRequest({ space_id: id, use: 'eventos', source_ref: `booking:reservation:${id}` }), { field: 'requested_by' });
});

test('usos · worker: solo Booking con la clave; añade una vez; 404 y 422; queda el rastro', async () => {
  const space = (await app.t.db.query<{ id: string }>(`insert into resources.spaces (kind, name) values ('exterior', 'Patio ficticio') returning id`)).rows[0]!.id;
  const body = { space_id: space, use: 'alojamiento', source_ref: `booking:reservation:${uuid()}`, requested_by: app.users.editor };

  assert.equal((await ask(body, 'booking', 'otra')).status, 401);
  assert.equal((await ask(body, 'tasks')).status, 403);
  const first = await ask(body);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.added, true);
  assert.ok(first.data.uses.includes('alojamiento'));
  const again = await ask(body);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.added, false);

  const [row] = (await app.t.db.query<{ uses: string[] }>(`select uses from resources.spaces where id = $1`, [space])).rows;
  assert.deepEqual(row!.uses.filter((u) => u === 'alojamiento'), ['alojamiento'], 'sin repetir');
  const [trace] = (await app.t.db.query<{ request_id: string }>(`select request_id from core.changes where app = 'resources' and row_id = $1 order by cursor desc limit 1`, [space])).rows;
  assert.match(trace!.request_id, new RegExp(`^space-use:b:reservation:.+:alojamiento:${app.users.editor}$`));

  assert.equal((await ask({ ...body, space_id: uuid() })).status, 404);
  const bad = await ask({ ...body, use: 'piscina' });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error.details.field, 'use');
});
