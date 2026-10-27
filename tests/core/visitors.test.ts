/** Visitantes anónimos (0096, C11): alta sin datos, X-Visitor resuelto por la Edge, lecturas de «lo mío» y escrituras públicas firmadas. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp, fail, messageFor } from '../../supabase/functions/_kit/mod.ts';

const GUESTS = 'https://guests.ikisai.com';

test('visitantes · alta, lectura con visitor_id del kit (nunca del cliente), escritura firmada y orígenes del proyecto', async () => {
  const app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: 'https://booking.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'booking', slug: 'booking-api', origins: ['https://booking.ikisai.com'], publicRoutes: [
      { method: 'POST', pattern: 'join', handler: async ({ visitor, apply, json }) => {
        if (!visitor) fail(401, 'VISITOR_REQUIRED', messageFor('VISITOR_REQUIRED'));
        const body = await json();
        const id = crypto.randomUUID();
        await apply([{ op: 'insert', table: 'booking.test_requests', id, fields: { body: String(body.body ?? ''), visitor_id: visitor.id } }]);
        return { id, eventCode: visitor.eventCode };
      } },
    ] }) });
  try {
    const db = app.t.db;
    const service = await app.t.createUser();
    await db.query(`select core.register_service_actor($1, 'booking')`, [service]);
    await db.exec(`create table booking.test_requests (id uuid primary key, body text, visitor_id uuid, revision bigint not null default 1,
        created_at timestamptz not null default now(), updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
      select core.register_table('booking', 'booking', 'test_requests', array['body','visitor_id']);
      create function booking.test_requests_guard() returns trigger language plpgsql as $$
        begin
          if not core.is_public_batch() or new.visitor_id is null or new.visitor_id is distinct from core.current_visitor() then
            perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'visitor mismatch'));
          end if;
          return new;
        end $$;
      create trigger test_requests_guard before insert on booking.test_requests for each row execute function booking.test_requests_guard();
      select core.allow_public_write('booking', 'booking.test_requests');
      create function booking.test_mine(p jsonb) returns jsonb language sql stable as $$ select p $$;
      select core.allow_public_read('test_mine', 'booking.test_mine', true);
      create function booking.test_edge_only(p jsonb) returns jsonb language sql stable as $$ select p $$;
      select core.allow_public_read('test_edge_only', 'booking.test_edge_only');`);

    // Alta desde el portal de Guests (otro origen del proyecto), sin sesión y sin datos.
    const created = await app.call('/api/v1/public/visitor', { token: null, origin: GUESTS, body: { eventCode: 'ABC123' } });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    assert.match(created.data.token, /^[0-9a-f]{64}$/);
    assert.equal(created.headers.get('access-control-allow-origin'), GUESTS);
    const visitorId: string = created.data.visitorId;
    const stored = await db.query<{ n: number }>(`select count(*)::int n from core.visitors where id = $1 and event_code = 'ABC123' and token_hash <> $2`, [visitorId, created.data.token]);
    assert.equal(stored.rows[0]?.n, 1, 'se guarda el resumen, no el token');

    // Lectura genérica: el visitor_id lo pone el kit y descarta el que venga en la consulta.
    const mine = await app.call('/api/v1/public/test_mine?visitor_id=00000000-0000-4000-8000-000000000000&event_code=ABC123', { token: null, origin: GUESTS, headers: { 'X-Visitor': created.data.token } });
    assert.equal(mine.status, 200, JSON.stringify(mine.data));
    assert.deepEqual(mine.data, { event_code: 'ABC123', visitor_id: visitorId });
    assert.equal(mine.headers.get('cache-control'), 'no-store', 'con visitante no se cachea');
    const anon = await app.call('/api/v1/public/test_mine?visitor_id=spoof&a=1', { token: null, origin: GUESTS });
    assert.deepEqual(anon.data, { a: '1' });
    assert.equal(anon.headers.get('cache-control'), 'public, max-age=30');
    const unknown = await app.call('/api/v1/public/no_existe', { token: null });
    assert.equal(unknown.status, 404);
    // Una lectura registrada sin exponer (la piden las Edges con sus argumentos) no se sirve al navegador.
    const edgeOnly = await app.call('/api/v1/public/test_edge_only?a=1', { token: null, origin: GUESTS });
    assert.equal(edgeOnly.status, 404);
    // Freno de altas: la 121.ª en un minuto se rechaza.
    for (let i = 0; i < 119; i++) await db.query(`select core.visitor_create($1, null)`, [i.toString(16).padStart(64, '0')]);
    const flood = await app.call('/api/v1/public/visitor', { token: null, origin: GUESTS, body: {} });
    assert.equal(flood.status, 429, JSON.stringify(flood.data));
    await db.exec(`update core.visitors set created_at = created_at - interval '2 minutes'`);

    // Escritura pública de la app dueña, firmada por el visitante; el disparador la ve con core.current_visitor().
    const noHeader = await app.call('/api/v1/public/join', { token: null, origin: GUESTS, body: { body: 'hola' } });
    assert.equal(noHeader.status, 401); assert.equal(noHeader.data.error.code, 'VISITOR_REQUIRED');
    const badHeader = await app.call('/api/v1/public/join', { token: null, origin: GUESTS, body: { body: 'hola' }, headers: { 'X-Visitor': 'f'.repeat(64) } });
    assert.equal(badHeader.status, 401); assert.equal(badHeader.data.error.code, 'VISITOR_INVALID');
    const joined = await app.call('/api/v1/public/join', { token: null, origin: GUESTS, body: { body: 'hola' }, headers: { 'X-Visitor': created.data.token } });
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
    assert.equal(joined.data.eventCode, 'ABC123');
    const row = await db.query<{ visitor_id: string; updated_by: string }>(`select visitor_id::text, updated_by::text from booking.test_requests where id = $1`, [joined.data.id]);
    assert.deepEqual(row.rows[0], { visitor_id: visitorId, updated_by: service });
    // Fuera del lote público nadie puede crear filas de visitante (el disparador lo impide).
    const own = await app.call('/api/v1/commands', { token: app.tokens.owner, body: { requestId: 'vis-1', operations: [{ op: 'insert', table: 'booking.test_requests', id: crypto.randomUUID(), fields: { body: 'x', visitor_id: visitorId } }] } });
    assert.equal(own.status, 403, JSON.stringify(own.data));

    // Revocado: la cabecera deja de valer.
    await db.query(`select core.visitor_revoke($1)`, [visitorId]);
    const revoked = await app.call('/api/v1/public/test_mine', { token: null, origin: GUESTS, headers: { 'X-Visitor': created.data.token } });
    assert.equal(revoked.status, 401); assert.equal(revoked.data.error.code, 'VISITOR_INVALID');

    // Orígenes: los del proyecto solo valen en public/*; fuera del proyecto, nunca.
    const privateFromGuests = await app.call('/api/v1/bootstrap', { origin: GUESTS });
    assert.equal(privateFromGuests.status, 403); assert.equal(privateFromGuests.data.error.code, 'ORIGIN_REJECTED');
    const foreign = await app.call('/api/v1/public/test_mine', { token: null, origin: 'https://otro.example.com' });
    assert.equal(foreign.status, 403);
    const preflight = await app.handler(new Request('https://x/booking-api/api/v1/public/join', { method: 'OPTIONS', headers: { Origin: GUESTS } }));
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /x-visitor/);
  } finally {
    await app.close();
  }
});
