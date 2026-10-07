/** Feedback y QA transversal (contrato §3.7): reportes internos y de portales, idempotencia, límites, ciclo de verificación y enrutado. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/handler.ts';

const BOOKING = 'https://booking.ikisai.com';
let app: TestApp;
let organizers: (r: Request) => Promise<Response>;
let guests: (r: Request) => Promise<Response>;
const R1 = crypto.randomUUID();
const G1 = crypto.randomUUID();

async function callPortal(handler: (r: Request) => Promise<Response>, portal: string, path: string, init: { body?: unknown; token?: string } = {}) {
  const res = await handler(new Request(`${app.supabase.url}/functions/v1/${portal}-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: `https://${portal}.ikisai.com`, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const report = (over: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(), requestId: crypto.randomUUID(), subject: 'application', intent: 'bug', message: 'Al volver atrás se pierde el cambio.',
  node: { id: 'booking.reservation.guests.add', path: ['Reserva', 'Huéspedes', 'Añadir huésped'], meta: { kind: 'button' } },
  context: { release: 'v1.2.3', commit: 'abc1234', route: '/reservas/3f2a1b4c-0000-0000-0000-000000000000/huespedes?tab=2', online: false,
    viewport: { width: 412, height: 915 }, deviceClass: 'mobile', inputValue: 'Juan Pérez 12345678Z', sync: { pending: 2, conflicts: 0 },
    steps: [{ route: '/reservas', node: 'booking.reservations.list', action: 'tap' }] },
  ...over,
});

test.before(async () => {
  app = await createTestApp({ app: 'booking', slug: 'booking-api', origin: BOOKING, createHandler: (config) => createApp({ ...config, app: 'booking', slug: 'booking-api', origins: [BOOKING], portalIssuer: true }) });
  const base = { url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: app.supabase.fetch };
  organizers = createApp({ ...base, app: 'organizers', slug: 'organizers-api', origins: ['https://organizers.ikisai.com'], portalIssuer: true });
  guests = createApp({ ...base, app: 'guests', slug: 'guests-api', origins: ['https://guests.ikisai.com'] });
  await app.t.db.exec(`create table public.fb_until (reservation_id uuid primary key, until timestamptz);
    create function public.fb_portal_until(p_scope jsonb) returns timestamptz language sql stable as $$ select now() + interval '30 days' $$;
    select core.allow_portal_resolver('organizers', 'public.fb_portal_until'); select core.allow_portal_resolver('guests', 'public.fb_portal_until');`);
  // El owner de Booking es además owner de Central: dueño del ecosistema.
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'owner')`, [app.users.owner]);
});
test.after(async () => { await app.close(); });

let first: any;

test('feedback · un lector informa un fallo: código, contexto con lista blanca, idempotencia', async () => {
  const body = report();
  const res = await app.call('/api/v1/feedback', { token: app.tokens.reader, body });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  first = res.data.report;
  assert.match(first.code, /^FB_\d{4}_\d{3,}$/);
  assert.equal(first.destination, 'qa'); assert.equal(first.routingStatus, 'none'); assert.equal(first.display, 'open'); assert.equal(first.mine, true);
  const stored = await app.t.db.query<{ context: any; source_route: string }>('select context, source_route from core.feedback_reports where id = $1', [body.id]);
  assert.equal(JSON.stringify(stored.rows[0]!.context).includes('Juan'), false, 'el valor de un campo no se guarda');
  assert.equal(stored.rows[0]!.source_route, '/reservas/:id/huespedes');
  const again = await app.call('/api/v1/feedback', { token: app.tokens.reader, body: { ...body, requestId: crypto.randomUUID(), context: { online: true } } });
  assert.equal(again.status, 200); assert.equal(again.data.report.replayed, true, 'reintento sin red: mismo reporte');
  const reuse = await app.call('/api/v1/feedback', { token: app.tokens.reader, body: { ...body, message: 'otra cosa' } });
  assert.equal(reuse.status, 409); assert.equal(reuse.data.error.code, 'IDEMPOTENCY_REUSE');
});

test('feedback · imagen adjunta: subida al bucket de feedback, URL firmada y bloque para agente', async () => {
  const bytes = new TextEncoder().encode('imagen-de-prueba');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const ticket = await app.call('/api/v1/feedback/uploads', { token: app.tokens.reader, body: { filename: 'captura.webp', mime: 'image/webp', size: bytes.byteLength, sha256: sha } });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.data));
  app.supabase.storage.set(ticket.data.path, bytes); // el simulado no acepta PUT: se deja el objeto como si se hubiera subido
  assert.equal((await app.call(`/api/v1/feedback/uploads/${ticket.data.id}/verify`, { token: app.tokens.reader, body: {} })).data.verified, true);
  const pdf = await app.call('/api/v1/feedback/uploads', { token: app.tokens.reader, body: { filename: 'x.pdf', mime: 'application/pdf', size: 10, sha256: sha } });
  assert.equal(pdf.status, 422, 'solo imágenes');
  const body = report({ intent: 'improvement', blocking: true, attachmentIds: [ticket.data.id] });
  const created = await app.call('/api/v1/feedback', { token: app.tokens.reader, body });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const detail = await app.call(`/api/v1/feedback/${created.data.report.code}`, { token: app.tokens.editor });
  assert.equal(detail.status, 200, JSON.stringify(detail.data));
  assert.equal(detail.data.attachments.length, 1); assert.ok(detail.data.attachments[0].url);
  assert.match(detail.data.agentBlock, /ME BLOQUEA/); assert.match(detail.data.agentBlock, /booking\.reservation\.guests\.add/);
  const foreign = await app.call('/api/v1/feedback', { token: app.tokens.editor, body: report({ attachmentIds: [ticket.data.id] }) });
  assert.equal(foreign.data.error.code, 'FEEDBACK_ATTACHMENT_INVALID', 'no se adjunta la imagen de otra persona');
  const many = await app.call('/api/v1/feedback', { token: app.tokens.reader, body: report({ attachmentIds: [1, 2, 3, 4].map(() => crypto.randomUUID()) }) });
  assert.equal(many.data.error.code, 'FEEDBACK_TOO_MANY_ATTACHMENTS');
});

test('feedback · lista, árbol, «También me pasa» y permisos de gestión', async () => {
  const list = await app.call('/api/v1/feedback?node=booking.reservation.guests.add', { token: app.tokens.editor });
  assert.equal(list.status, 200); assert.equal(list.data.items.length, 2); assert.equal(list.data.items[0].blocking, true, 'lo que bloquea, primero');
  const tree = await app.call('/api/v1/feedback/tree', { token: app.tokens.editor });
  assert.deepEqual(tree.data.nodes.map((n: any) => [n.id, n.open]), [['booking.reservation.guests.add', 2]]);
  assert.equal((await app.call(`/api/v1/feedback/${first.id}/support`, { token: app.tokens.editor, body: {} })).data.report.supportersCount, 1);
  assert.equal((await app.call(`/api/v1/feedback/${first.id}/support`, { token: app.tokens.editor, body: {} })).data.report.supportersCount, 1, 'una vez por persona');
  assert.equal((await app.call(`/api/v1/feedback/${first.id}/dismiss`, { token: app.tokens.reader, body: { reason: 'no' } })).status, 403);
});

test('feedback · ciclo: publicado con el código → pendiente de verificar (pin para quien informó y para el owner) → verificado o sigue fallando', async () => {
  await app.t.db.query('select core.feedback_mark_released($1, $2)', [[first.code], 'v1.2.4']);
  const pinOwner = await app.call('/api/v1/feedback?status=pending_verify&pin=true', { token: app.tokens.owner });
  assert.deepEqual(pinOwner.data.items.map((r: any) => r.code), [first.code], 'el owner del ecosistema siempre ve el pin');
  const pinReader = await app.call('/api/v1/feedback?status=pending_verify&pin=true', { token: app.tokens.reader });
  assert.equal(pinReader.data.items.length, 1, 'quien lo informó también');
  const pinEditor = await app.call('/api/v1/feedback?status=pending_verify&pin=true', { token: app.tokens.editor });
  assert.equal(pinEditor.data.items.length, 0, 'los demás, no');
  const reopened = await app.call(`/api/v1/feedback/${first.id}/reopen`, { token: app.tokens.reader, body: { message: 'Sigue igual en Android' } });
  assert.equal(reopened.data.report.display, 'open'); assert.equal(reopened.data.report.reopenCount, 1);
  await app.t.db.query('select core.feedback_mark_released($1, $2)', [[first.code], 'v1.2.5']);
  const verified = await app.call(`/api/v1/feedback/${first.id}/verify`, { token: app.tokens.owner, body: {} });
  assert.equal(verified.data.report.status, 'verified'); assert.equal(verified.data.report.verifiedBuild, 'v1.2.5');
});

test('feedback · portales: el huésped informa de su retiro (va al organizador), fuera de ámbito no existe; espacio → enrutado a Tasks', async () => {
  const orgLink = await app.call('/api/v1/portal-links', { token: app.tokens.editor, body: { app: 'organizers', scope: { reservation_id: R1 }, person: { name: 'Org', email: 'org@example.invalid' } } });
  const org = (await callPortal(organizers, 'organizers', '/api/v1/auth/link', { body: { token: orgLink.data.url.split('/i/')[1] } })).data.token;
  const guestLink = await callPortal(organizers, 'organizers', '/api/v1/portal-links', { token: org, body: { app: 'guests', scope: { reservation_id: R1, guest_id: G1 }, person: { name: 'Ana' } } });
  const guest = (await callPortal(guests, 'guests', '/api/v1/auth/link', { body: { token: guestLink.data.url.split('/i/')[1] } })).data.token;

  const event = await callPortal(guests, 'guests', '/api/v1/feedback', { token: guest, body: report({ subject: 'event', intent: 'suggestion', node: undefined, category: 'horarios', scope: { reservation_id: R1, guest_id: G1 }, message: 'Las sesiones empiezan muy pronto.' }) });
  assert.equal(event.status, 200, JSON.stringify(event.data)); assert.equal(event.data.report.destination, 'organizer'); assert.equal(event.data.report.routingStatus, 'none');
  const outside = await callPortal(guests, 'guests', '/api/v1/feedback', { token: guest, body: report({ subject: 'event', intent: 'suggestion', scope: { reservation_id: crypto.randomUUID() } }) });
  assert.equal(outside.status, 404); assert.equal(outside.data.error.code, 'OUT_OF_SCOPE');
  const seen = await callPortal(organizers, 'organizers', '/api/v1/feedback?app=guests', { token: org });
  assert.deepEqual(seen.data.items.map((r: any) => r.code), [event.data.report.code], 'el organizador de esa reserva lo ve');
  const detail = await callPortal(guests, 'guests', `/api/v1/feedback/${event.data.report.id}`, { token: guest });
  assert.equal(detail.status, 200); assert.equal(detail.data.agentBlock, undefined, 'un portal no ve el diagnóstico técnico');
  const internal = await callPortal(guests, 'guests', `/api/v1/feedback/${first.id}`, { token: guest });
  assert.equal(internal.status, 404, 'el huésped no ve el QA interno');

  const space = await callPortal(guests, 'guests', '/api/v1/feedback', { token: guest, body: report({ subject: 'space', intent: 'problem', category: 'damage', node: undefined, scope: { reservation_id: R1 }, message: 'La ducha no evacúa.' }) });
  assert.equal(space.data.report.destination, 'operations'); assert.equal(space.data.report.routingStatus, 'pending');
  const claim = (await app.t.db.query<{ c: any }>('select core.feedback_routing_claim(10) c')).rows[0]!.c;
  assert.equal(claim.length, 1); assert.equal(claim[0].externalRef, space.data.report.code + ':1');
  assert.equal(JSON.stringify(claim[0]).includes('Ana'), false, 'la petición a Tasks no lleva el nombre');
  await app.t.db.query('select core.feedback_routing_result($1, $2, null)', [claim[0].externalRef, crypto.randomUUID()]);
  await app.t.db.query(`select core.feedback_task_status($1::jsonb)`, [JSON.stringify([{ externalRef: claim[0].externalRef, status: 'done' }])]);
  const after = await app.call(`/api/v1/feedback/${space.data.report.id}`, { token: app.tokens.editor });
  assert.equal(after.data.report.display, 'pending_verify', 'tarea hecha: pendiente de verificar');
});

test('feedback · límite diario por persona', async () => {
  await app.t.db.query(`insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, destination, routing_status)
    select gen_random_uuid(), 'FB_TEST_' || g, 'r' || g, 'd', $1, 'internal', 'booking', 'application', 'idea', 'x', 'qa', 'none' from generate_series(1, 30) g`, [app.users.editor]);
  const res = await app.call('/api/v1/feedback', { token: app.tokens.editor, body: report() });
  assert.equal(res.status, 429); assert.equal(res.data.error.code, 'FEEDBACK_RATE_LIMITED');
});

test('feedback · worker: cuenta de servicio bajo demanda, petición a Tasks sin datos personales y estado copiado', async () => {
  const calls: Array<{ route: string; body: any }> = [];
  const tasksFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.includes('/functions/v1/tasks-api/api/v1/worker/')) return app.supabase.fetch(input, init);
    const route = url.split('/api/v1/worker/')[1]!; const body = JSON.parse(String(init?.body));
    assert.equal(new Headers(init?.headers).get('X-Ikisai-Worker-Key'), 'clave-worker');
    calls.push({ route, body });
    if (route === 'requests/task') return Response.json({ taskId: '00000000-0000-4000-8000-000000000001', status: 'open' });
    return Response.json({ items: body.externalRefs.map((externalRef: string) => ({ externalRef, status: 'done' })) });
  };
  const central = createApp({ url: app.supabase.url, anonKey: app.supabase.anonKey, serviceKey: app.supabase.serviceKey, fetch: tasksFetch,
    app: 'central', slug: 'central-api', origins: ['https://central.ikisai.com'], workerKey: 'clave-worker', feedbackWorker: true });
  await app.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'editor') on conflict do nothing`, [app.users.editor]);
  // Un reporte de espacio interno pendiente de enrutar.
  // (el editor agotó su cupo diario en la prueba anterior: informa el owner)
  const res = await app.call('/api/v1/feedback', { token: app.tokens.owner, body: report({ subject: 'space', intent: 'problem', category: 'utilities', node: undefined, message: 'No hay agua caliente en el baño común.' }) });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  await app.t.db.query(`update core.feedback_reports set next_routing_at = now() where routing_status in ('pending','error')`);
  const tick = async () => (await central(new Request(app.supabase.url + '/functions/v1/central-api/api/v1/worker/feedback/tick', { method: 'POST', headers: { 'X-Ikisai-Worker-Key': 'clave-worker' } }))).json();
  const out = await tick();
  assert.ok(out.routed >= 1, JSON.stringify(out));
  const task = calls.find((c) => c.route === 'requests/task' && c.body.kind === 'feedback.space.utilities');
  assert.ok(task, JSON.stringify(calls.map((c) => c.body.kind)));
  assert.equal(task!.body.on_behalf_of.kind, 'internal'); assert.match(task!.body.external_url, /^https:\/\/tasks\.ikisai\.com\/#\/feedback\/FB_/);
  const service = await app.t.db.query<{ kind: string; display_name: string; role: string }>(
    `select p.kind, p.display_name, m.role from core.profiles p join core.memberships m on m.user_id = p.user_id and m.app = 'tasks' where p.service_name = 'feedback'`);
  assert.deepEqual(service.rows[0], { kind: 'service', display_name: 'Feedback (sistema)', role: 'editor' });
  assert.ok(out.statusUpdates >= 1, 'el estado «hecha» se copia');
  const again = await tick();
  assert.equal(again.routed, 0, 'nada que enrutar dos veces');
  assert.equal((await app.t.db.query<{ n: number }>(`select count(*)::int n from core.profiles where service_name = 'feedback'`)).rows[0]!.n, 1, 'una sola cuenta de servicio');
});
