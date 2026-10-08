/** Enlaces personales de los portales (contrato §3.6): emisión desde Booking y Organizers, canje, caducidad dinámica. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;
let organizers: (r: Request) => Promise<Response>;
let guests: (r: Request) => Promise<Response>;
const R1 = crypto.randomUUID();
const R2 = crypto.randomUUID();
const G1 = crypto.randomUUID();

async function callPortal(handler: (r: Request) => Promise<Response>, portal: string, path: string, init: { body?: unknown; token?: string; method?: string } = {}) {
  const origin = `https://${portal}.ikisai.com`;
  const res = await handler(new Request(`${app.supabase.url}/functions/v1/${portal}-api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null), headers: res.headers };
}
const tokenOf = (url: string) => url.split('/i/')[1]!;
const setUntil = (reservation: string, days: number) => app.t.db.query(`insert into public.test_until (reservation_id, until) values ($1, now() + make_interval(days => $2))
  on conflict (reservation_id) do update set until = excluded.until`, [reservation, days]);

test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [BOOKING], portalIssuer: true }) });
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  organizers = createApp({ ...base, app: 'organizers', slug: 'organizers-api', origins: ['https://organizers.ikisai.com'], portalIssuer: true });
  guests = createApp({ ...base, app: 'guests', slug: 'guests-api', origins: ['https://guests.ikisai.com'] });
  // Resolvedor de prueba en lugar del de Booking: la validez sale de una tabla que la prueba mueve.
  await app.t.db.exec(`create table public.test_until (reservation_id uuid primary key, until timestamptz);
    create function public.test_portal_until(p_scope jsonb) returns timestamptz language sql stable as $$ select until from public.test_until where reservation_id = (p_scope->>'reservation_id')::uuid $$;
    select core.allow_portal_resolver('organizers', 'public.test_portal_until'); select core.allow_portal_resolver('guests', 'public.test_portal_until');`);
  await setUntil(R1, 30); await setUntil(R2, 30);
});
test.after(async () => { await app.close(); });

let orgToken: string;
let orgSession: string;
let orgLinkId: string;

test('portales · el personal de Booking emite el enlace del organizador (lector no); mismo correo = misma cuenta', async () => {
  assert.equal((await app.call('/api/v1/portal-links', { token: app.tokens.reader, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Paco' } } })).status, 403);
  const first = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Paco', email: 'paco@example.invalid' } } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.match(first.data.url, /^https:\/\/organizers\.ikisai\.com\/i\/[A-Za-z0-9_-]{43}$/); assert.equal(first.data.shownOnce, true); assert.ok(first.data.validUntil);
  orgToken = tokenOf(first.data.url); orgLinkId = first.data.linkId;
  const second = await app.call('/api/v1/portal-links', { body: { app: 'organizers', scope: { reservation_id: R2 }, person: { name: 'Paco', email: 'PACO@example.invalid' } } });
  assert.equal(second.data.userId, first.data.userId, 'recurrencia: misma cuenta');
  const stored = await app.t.db.query<{ n: number }>('select count(*)::int n from core.portal_links where digest = $1', [orgToken]);
  assert.equal(stored.rows[0]!.n, 0, 'solo se guarda el resumen del token');
});

test('portales · el organizador canjea su enlace: sesión propia, pase común y acceso a sus dos reservas', async () => {
  const bad = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: 'A'.repeat(43) } });
  assert.equal(bad.status, 401); assert.equal(bad.data.error.code, 'LINK_INVALID');
  const ok = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.ok(ok.data.token);
  assert.match(ok.headers.get('set-cookie') ?? '', /ikisai_sso=/);
  orgSession = ok.data.token;
  const boot = await callPortal(organizers, 'organizers', '/api/v1/bootstrap', { token: orgSession });
  assert.equal(boot.status, 200); assert.deepEqual(boot.data.membership.scopes.grants.map((g: any) => g.reservation_id).sort(), [R1, R2].sort());
  // El enlace de organizers no sirve en guests.
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: orgToken } })).data.error.code, 'LINK_INVALID');
});

test('portales · la caducidad sigue a la fecha de la reserva; el personal amplía a mano y revoca', async () => {
  await setUntil(R1, -1);
  const expired = await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } });
  assert.equal(expired.status, 401); assert.equal(expired.data.error.code, 'LINK_EXPIRED');
  await setUntil(R1, 60);
  assert.equal((await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } })).status, 200, 'la fecha se movió: vale otra vez');
  await setUntil(R1, -1);
  const ext = await app.call(`/api/v1/portal-links/${orgLinkId}/extend`, { body: { until: new Date(Date.now() + 5 * 86400e3).toISOString() } });
  assert.equal(ext.status, 200, JSON.stringify(ext.data));
  assert.equal((await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgToken } })).status, 200, 'ampliado a mano');
  const list = await app.call(`/api/v1/portal-links?reservation=${R1}`);
  assert.equal(list.data.items.length, 1); assert.equal(list.data.items[0].linkId, orgLinkId);
  await setUntil(R1, 30);
});

test('portales · el organizador emite enlaces de huésped solo de sus reservas; el huésped entra en Guests', async () => {
  const notMine = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: crypto.randomUUID(), guest_id: G1 }, person: { name: 'Ana' } } });
  assert.equal(notMine.status, 403);
  const orgLink = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Otro' } } });
  assert.equal(orgLink.status, 403);
  const guestLink = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: G1 }, person: { name: 'Ana López' } } });
  assert.equal(guestLink.status, 200, JSON.stringify(guestLink.data)); assert.match(guestLink.data.url, /^https:\/\/guests\.ikisai\.com\/i\//);
  const entered = await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(guestLink.data.url) } });
  assert.equal(entered.status, 200, JSON.stringify(entered.data));
  const boot = await callPortal(guests, 'guests', '/api/v1/bootstrap', { token: entered.data.token });
  assert.deepEqual(boot.data.membership.scopes.grants, [{ reservation_id: R1, guest_id: G1 }]);
  const listed = await callPortal(organizers, 'organizers', `/api/v1/portal-links?reservation=${R1}`, { token: orgSession });
  assert.equal(listed.status, 200); assert.ok(listed.data.items.every((l: any) => l.app === 'guests'), 'el organizador solo ve los enlaces de huésped');
  const revoked = await callPortal(organizers, 'organizers', `/api/v1/portal-links/${guestLink.data.linkId}/revoke`, { token: orgSession, body: {} });
  assert.equal(revoked.status, 200);
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(guestLink.data.url) } })).data.error.code, 'LINK_INVALID');
  const extend = await callPortal(organizers, 'organizers', `/api/v1/portal-links/${guestLink.data.linkId}/extend`, { token: orgSession, body: { until: new Date(Date.now() + 86400e3).toISOString() } });
  assert.equal(extend.status, 403, 'solo el personal amplía');
});

test('portales · un miembro del portal solo se ve a sí mismo en members', async () => {
  const otro = await app.call('/api/v1/portal-links', { body: { app: 'organizers', scope: { reservation_id: crypto.randomUUID() }, person: { name: 'Otra organizadora', email: 'otra@example.invalid' } } });
  assert.equal(otro.status, 200);
  const members = await callPortal(organizers, 'organizers', '/api/v1/members', { token: orgSession });
  assert.equal(members.status, 200); assert.equal(members.data.length, 1); assert.equal(members.data[0].displayName, 'Paco');
});

test('portales · una acción de portal escribe en la app dueña con su propio lote (P20); fuera de un portal, no', async () => {
  await app.t.db.exec(`create table public.test_notes (id uuid primary key, body text, revision bigint not null default 1, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
    select core.register_table('booking', 'public', 'test_notes', array['body']);
    create function public.test_portal_write(p_ctx jsonb) returns jsonb language plpgsql as $$
      begin return core.apply_portal_operations('booking', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'public.test_notes', 'id', p_ctx->'args'->>'id', 'fields', jsonb_build_object('body', p_ctx->'args'->>'body'))))
        || jsonb_build_object('appAfter', current_setting('core.app', true)); end $$;
    select core.allow_read('organizers', 'public.test_portal_write', 'action', '{editor}');
    select core.allow_read('booking', 'public.test_portal_write', 'action', '{editor,owner}');`);
  const before = await app.t.db.query<{ cursor: string }>(`select cursor::text from core.app_state where app = 'booking'`);
  const id = crypto.randomUUID();
  const out = await callPortal(organizers, 'organizers', '/api/v1/invoke/public.test_portal_write', { token: orgSession, body: { id, body: 'hola' } });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  const result = out.data.result ?? out.data;
  assert.equal(result.appAfter, 'organizers', 'el contexto del portal se restaura');
  assert.equal(String(result.cursor), String(BigInt(before.rows[0]!.cursor) + 1n));
  const change = await app.t.db.query<{ actor_id: string; app: string }>(`select actor_id::text, app from core.changes where row_id = $1`, [id]);
  assert.equal(change.rows[0]!.app, 'booking', 'el cambio llega a Booking por changes');
  // El personal de Booking no puede usar esta vía (no es un portal).
  const staff = await app.call('/api/v1/invoke/public.test_portal_write', { body: { id: crypto.randomUUID(), body: 'x' } });
  assert.equal(staff.status, 403, JSON.stringify(staff.data));
});

test('portales · revocar por ámbito anula los enlaces y quita el permiso de la sesión abierta (P21)', async () => {
  const g2 = crypto.randomUUID();
  const link = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: g2 }, person: { name: 'Luis' } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const entered = await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } });
  assert.equal(entered.status, 200);
  const n = await app.t.db.query<{ n: number }>(`select core.portal_revoke_scope('guests', 'guest_id', $1) n`, [g2]);
  assert.equal(n.rows[0]!.n, 1);
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } })).data.error.code, 'LINK_INVALID');
  const boot = await callPortal(guests, 'guests', '/api/v1/bootstrap', { token: entered.data.token });
  assert.ok(!(boot.data.membership?.scopes?.grants ?? []).some((g: any) => g.guest_id === g2), 'la sesión abierta pierde el permiso');
});

test('portales · reenviar el enlace de un huésped reutiliza su cuenta y, con replace, revoca el anterior', async () => {
  const G2 = crypto.randomUUID();
  const first = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: G2 }, person: { name: 'Eva' } } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const again = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: G2 }, person: { name: 'Eva' }, replace: true } });
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.userId, first.data.userId, 'misma cuenta: no se duplican');
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(first.data.url) } })).data.error.code, 'LINK_INVALID', 'el enlace antiguo ya no vale');
  assert.equal((await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(again.data.url) } })).status, 200);
});

test('portales · un huésped solo lee los archivos que subió él (la firma de otro, no)', async () => {
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  const withUploads = createApp({ ...base, app: 'guests', slug: 'guests-api', origins: ['https://guests.ikisai.com'], uploads: { bucket: 'guests-documents', allowedMime: ['image/png'] } });
  const enter = async (name: string) => {
    const link = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: crypto.randomUUID() }, person: { name } } });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    return (await callPortal(withUploads, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } })).data.token as string;
  };
  const ana = await enter('Ana Firma'); const luis = await enter('Luis Curioso');
  const ticket = await callPortal(withUploads, 'guests', '/api/v1/uploads', { token: ana, body: { filename: 'firma.png', mime: 'image/png', size: 10, sha256: 'a'.repeat(64) } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [ticket.data.id]);
  const other = await callPortal(withUploads, 'guests', `/api/v1/files/${ticket.data.id}`, { token: luis });
  assert.equal(other.status, 404); assert.equal(other.data.error.code, 'FILE_NOT_FOUND');
  assert.equal((await callPortal(withUploads, 'guests', `/api/v1/uploads/${ticket.data.id}/verify`, { token: luis, body: {} })).status, 404);
  assert.notEqual((await callPortal(withUploads, 'guests', `/api/v1/files/${ticket.data.id}`, { token: ana })).status, 404, 'la autora sí');
});

test('portales · contacto público sin sesión (C1): textos de contacto de Central por idioma, cacheable', async () => {
  // Simulado de la función que publica Central (su schema); aquí solo se prueba la ruta del kit.
  await app.t.db.exec(`create function public.test_contact(p_args jsonb) returns jsonb language sql stable as $$
    select jsonb_build_array(jsonb_build_object('key', 'contact.email', 'title', case when p_args->>'lang' = 'en' then 'Contact email' else 'Correo de contacto' end, 'body', 'organiza@ikisai.com')) $$;
    select core.allow_public_read('contact', 'public.test_contact');`);
  const es = await callPortal(guests, 'guests', '/api/v1/public/contact?lang=es');
  assert.equal(es.status, 200, JSON.stringify(es.data)); assert.equal(es.data.lang, 'es'); assert.equal(es.data.items[0].title, 'Correo de contacto');
  assert.match(es.headers.get('cache-control') ?? '', /max-age=300/);
  const en = await callPortal(organizers, 'organizers', '/api/v1/public/contact?lang=en');
  assert.equal(en.data.items[0].title, 'Contact email');
  assert.equal((await callPortal(guests, 'guests', '/api/v1/public/contact?lang=xx')).data.lang, 'es', 'idioma desconocido → español');
});

test('portales · core.portal_in_scope (K1): reserva del organizador; reserva y huésped en Guests; nada sin ámbito', async () => {
  const user = await app.t.createUser(); const R = crypto.randomUUID(); const G = crypto.randomUUID();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('guests', $1, 'editor', $2), ('organizers', $1, 'editor', $3)`,
    [user, JSON.stringify({ grants: [{ reservation_id: R, guest_id: G }] }), JSON.stringify({ grants: [{ reservation_id: R }] })]);
  const q = async (portal: string, r: string | null, g: string | null) =>
    (await app.t.db.query<{ ok: boolean }>('select core.portal_in_scope($1, $2, $3, $4) ok', [portal, user, r, g])).rows[0]!.ok;
  assert.equal(await q('organizers', R, null), true);
  assert.equal(await q('organizers', crypto.randomUUID(), null), false, 'otra reserva');
  assert.equal(await q('guests', R, G), true);
  assert.equal(await q('guests', R, null), false, 'en Guests hace falta el huésped');
  assert.equal(await q('guests', R, crypto.randomUUID()), false, 'otro huésped de la misma reserva');
  assert.equal(await q('organizers', null, null), false);
});

test('portales · K3: un organizador abre un archivo de su retiro subido por otro, no el de otro retiro', async () => {
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  await app.t.db.exec(`create table public.test_materials (id uuid primary key, reservation_id uuid not null, file_id uuid, deleted_at timestamptz);
    select core.register_file_field('organizers', 'public', 'test_materials', 'file_id', 'operational');`);
  const inScope = (row: Record<string, unknown>, ctx: any) => ((ctx.membership?.scopes?.grants ?? []) as any[]).some((g) => g.reservation_id === row.reservation_id);
  const org = createApp({ ...base, app: 'organizers', slug: 'organizers-api', origins: ['https://organizers.ikisai.com'], portalIssuer: true,
    uploads: { bucket: 'organizers-materials', allowedMime: ['application/pdf'] }, hooks: { visible: (_t, row, ctx) => inScope(row, ctx) } });
  const enter = async (reservation: string, name: string) => {
    const link = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body: { app: 'organizers', scope: { reservation_id: reservation }, person: { name } } });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    return (await callPortal(org, 'organizers', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } })).data.token as string;
  };
  const R3 = crypto.randomUUID(); const R4 = crypto.randomUUID(); await setUntil(R3, 30); await setUntil(R4, 30);
  const ana = await enter(R3, 'Ana Coorganiza'); const pepe = await enter(R3, 'Pepe Coorganiza'); const otro = await enter(R4, 'Otro Retiro');
  const ticket = await callPortal(org, 'organizers', '/api/v1/uploads', { token: ana, body: { filename: 'programa.pdf', mime: 'application/pdf', size: 10, sha256: 'b'.repeat(64) } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  await app.t.db.query(`update core.files set status = 'verified' where id = $1`, [ticket.data.id]);
  assert.equal((await callPortal(org, 'organizers', `/api/v1/files/${ticket.data.id}`, { token: pepe })).status, 404, 'sin fila que lo referencie, solo la autora');
  await app.t.db.query('insert into public.test_materials (id, reservation_id, file_id) values ($1, $2, $3)', [crypto.randomUUID(), R3, ticket.data.id]);
  assert.notEqual((await callPortal(org, 'organizers', `/api/v1/files/${ticket.data.id}`, { token: pepe })).status, 404, 'coorganizador del mismo retiro');
  assert.equal((await callPortal(org, 'organizers', `/api/v1/files/${ticket.data.id}`, { token: otro })).status, 404, 'organizador de otro retiro');
});

test('portales · C8: archivo de otra app publicado al portal por resolutor; O6: la vista previa solo lee', async () => {
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  const g = createApp({ ...base, app: 'guests', slug: 'guests-api', origins: ['https://guests.ikisai.com'] });
  const R5 = crypto.randomUUID(); await setUntil(R5, 30);
  const owner = await app.t.createUser();
  const file = (await app.t.db.query<{ id: string }>(`insert into core.files (app, bucket, path, filename, mime, size, sha256, created_by, status)
    values ('organizers', 'organizers-materials', 'organizers/x.pdf', 'programa.pdf', 'application/pdf', 10, $1, $2, 'verified') returning id`, ['c'.repeat(64), owner])).rows[0]!.id;
  await app.t.db.exec(`create table public.test_published (file_id uuid, reservation_id uuid);
    create function public.test_material_file(p_ctx jsonb) returns boolean language sql stable as $$
      select exists (select 1 from public.test_published p where p.file_id = (p_ctx->>'file_id')::uuid
        and core.portal_in_scope(p_ctx->>'portal', (p_ctx->>'actor')::uuid, p.reservation_id, null) is not null
        and exists (select 1 from jsonb_array_elements(p_ctx->'scopes'->'grants') x where x->>'reservation_id' = p.reservation_id::text)) $$;
    select core.allow_portal_file('guests', 'public.test_material_file');`);
  const issue = async (preview: boolean) => {
    const link = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: crypto.randomUUID() }, person: { name: preview ? 'Huésped de muestra' : 'Marta' }, preview } });
    assert.equal(link.status, 200, JSON.stringify(link.data));
    return (await callPortal(g, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } })).data.token as string;
  };
  const marta = await issue(false);
  assert.equal((await callPortal(g, 'guests', `/api/v1/portal-files/${file}`, { token: marta })).status, 404, 'no publicado');
  await app.t.db.query('insert into public.test_published values ($1, $2)', [file, R5]);
  assert.equal((await callPortal(g, 'guests', `/api/v1/portal-files/${file}`, { token: marta })).status, 404, 'publicado en otro retiro');
  await app.t.db.query('insert into public.test_published values ($1, $2)', [file, R1]);
  const ok = await callPortal(g, 'guests', `/api/v1/portal-files/${file}`, { token: marta });
  assert.equal(ok.status, 200, JSON.stringify(ok.data)); assert.equal(ok.data.filename, 'programa.pdf');
  const preview = await issue(true);
  const write = await callPortal(g, 'guests', '/api/v1/commands', { token: preview, body: { operations: [] } });
  assert.equal(write.status, 403); assert.equal(write.data.error.code, 'PREVIEW_READ_ONLY');
  assert.equal((await callPortal(g, 'guests', '/api/v1/bootstrap', { token: preview })).status, 200, 'leer sí');
  assert.notEqual((await callPortal(g, 'guests', '/api/v1/commands', { token: marta, body: { operations: [] } })).data?.error?.code, 'PREVIEW_READ_ONLY');
});

test('portales · K6: una acción de Organizers invocada desde Guests escribe en organizers; un portal no se escribe a sí mismo por esta vía', async () => {
  await app.t.db.exec(`create table public.test_answers (id uuid primary key, body text, revision bigint not null default 1, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(), updated_by uuid, deleted_at timestamptz);
    select core.register_table('organizers', 'public', 'test_answers', array['body']);
    create function public.test_guest_answer(p_ctx jsonb) returns jsonb language plpgsql as $$
      begin return core.apply_portal_operations(p_ctx->'args'->>'target', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'public.test_answers', 'id', p_ctx->'args'->>'id', 'fields', jsonb_build_object('body', 'sí')))); end $$;
    select core.allow_read('guests', 'public.test_guest_answer', 'action', '{editor}');`);
  const link = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: orgSession, body: { app: 'guests', scope: { reservation_id: R1, guest_id: crypto.randomUUID() }, person: { name: 'Respondona' } } });
  const token = (await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: tokenOf(link.data.url) } })).data.token as string;
  const id = crypto.randomUUID();
  const ok = await callPortal(guests, 'guests', '/api/v1/invoke/public.test_guest_answer', { token, body: { id, target: 'organizers' } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal((await app.t.db.query<{ app: string }>('select app from core.changes where row_id = $1', [id])).rows[0]!.app, 'organizers');
  const self = await callPortal(guests, 'guests', '/api/v1/invoke/public.test_guest_answer', { token, body: { id: crypto.randomUUID(), target: 'guests' } });
  assert.equal(self.status, 422, JSON.stringify(self.data));
});

test('portales · contacto público por público: cada portal pide el suyo por defecto', async () => {
  await app.t.db.exec(`create or replace function public.test_contact(p_args jsonb) returns jsonb language sql stable as $$
    select jsonb_build_array(jsonb_build_object('key', 'contact.email', 'title', 'Correo', 'body', case p_args->>'audience' when 'guests' then 'ven@ikisai.com' else 'organiza@ikisai.com' end)) $$;`);
  const g = await callPortal(guests, 'guests', '/api/v1/public/contact?lang=es');
  assert.equal(g.data.audience, 'guests'); assert.equal(g.data.items[0].body, 'ven@ikisai.com');
  const o = await callPortal(organizers, 'organizers', '/api/v1/public/contact');
  assert.equal(o.data.audience, 'organizers'); assert.equal(o.data.items[0].body, 'organiza@ikisai.com');
  assert.equal((await callPortal(guests, 'guests', '/api/v1/public/contact?audience=nadie')).data.audience, 'guests', 'público desconocido → el del portal');
});

test('portales · K7: la cuenta de servicio de Organizers se registra sin pertenencias', async () => {
  const user = await app.t.createUser();
  const id = (await app.t.db.query<{ id: string }>(`select core.register_service_actor($1, 'organizers')::text id`, [user])).rows[0]!.id;
  assert.equal(id, user);
  assert.equal((await app.t.db.query<{ n: number }>('select count(*)::int n from core.memberships where user_id = $1', [user])).rows[0]!.n, 0);
  assert.equal((await app.t.db.query<{ id: string }>(`select core.service_actor('organizers')::text id`)).rows[0]!.id, user);
});
