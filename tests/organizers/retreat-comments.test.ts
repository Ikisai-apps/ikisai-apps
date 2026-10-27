/**
 * Organizers · comentarios del retiro (bandeja de quien organiza): lo que los asistentes cuentan en Guests sobre el retiro
 * llega a quien lo organiza, por `GET feedback?app=guests` de organizers-api, y solo lo de sus retiros. Lo de los espacios y
 * lo de la aplicación no le llega (lo atiende Ikisai). Contra las Edge sobre PGlite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { loadGuestFeedback, retreatComments, type FeedbackItem } from '../../apps/organizers/src/app/retreat-comments.ts';
import { readOperations, unreadByReservation, unreadOf } from '../../apps/organizers/src/app/comment-reads.ts';
import { TABLES } from '../../supabase/functions/_domain/organizers/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-pruebas';
let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let seq = 0;

async function org(path: string, init: { token?: string; body?: unknown } = {}): Promise<{ status: number; data: any }> {
  const res = await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORGANIZERS_ORIGINS[0]!, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
async function reservation(title: string): Promise<string> {
  const id = uuid();
  const res = await booking.call('/api/v1/commands', { body: { requestId: `rc-${++seq}-${uuid()}`, operations: [
    { op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2026-10-02', end_date: '2026-10-04', expected_guests: 8 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<{ token: string; id: string }> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org('/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const me = await org('/api/v1/me', { token: session.data.token });
  return { token: session.data.token, id: me.data.userId };
}
/** Un comentario de huésped tal como lo guarda el núcleo (destino según `core.feedback_route`). */
async function report(reporter: string, fields: { subject: 'event' | 'space' | 'application'; reservation_id: string; message: string; category?: string; at?: string }): Promise<string> {
  const id = uuid();
  const destination = fields.subject === 'event' ? 'organizer' : fields.subject === 'space' ? 'operations' : 'qa';
  await booking.t.db.query(`insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, category, scope, destination, routing_status, created_at)
    values ($1, 'FB_RC_' || $2, $3, 'd', $4, 'guest', 'guests', $5, 'problem', $6, $7, $8::jsonb, $9, 'none', coalesce($10::timestamptz, now()))`,
  [id, String(++seq), `rc-${seq}`, reporter, fields.subject, fields.message, fields.category ?? null, JSON.stringify({ reservation_id: fields.reservation_id, guest_id: uuid() }), destination, fields.at ?? null]);
  return id;
}

let R1: string; let R2: string;
let ana: { token: string; id: string }; let otra: { token: string; id: string };
const ids = { early: '', late: '', other: '', space: '', app: '' };

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  organizers = createOrganizersApp({ url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!], workerKey: WORKER_KEY });
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-rc@example.invalid');
  otra = await organizerSession(R2, 'otra-rc@example.invalid');
  // Quien comenta es un huésped; para la prueba basta una cuenta que no organiza ninguno de los dos retiros.
  const guest = booking.users.reader;
  ids.early = await report(guest, { subject: 'event', reservation_id: R1, message: 'Las sesiones empiezan muy pronto.', category: 'schedule', at: '2026-10-03T08:00:00Z' });
  ids.late = await report(guest, { subject: 'event', reservation_id: R1, message: 'La cena, estupenda.', category: 'food', at: '2026-10-04T20:00:00Z' });
  ids.other = await report(guest, { subject: 'event', reservation_id: R2, message: 'De otro retiro.' });
  ids.space = await report(guest, { subject: 'space', reservation_id: R1, message: 'La ducha no evacúa.' });
  ids.app = await report(guest, { subject: 'application', reservation_id: R1, message: 'Un botón no va.' });
});
test.after(async () => { await booking.close(); });

test('organizers · comentarios del retiro: quien organiza ve lo que cuentan de su retiro, lo más reciente primero', async () => {
  const res = await org('/api/v1/feedback?app=guests&status=all&limit=500', { token: ana.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const items = res.data.items as FeedbackItem[];
  const seen = new Set(items.map((r) => r.id));
  assert.ok(!seen.has(ids.other), 'nada de otro retiro');
  assert.ok(!seen.has(ids.space) && !seen.has(ids.app), 'lo del lugar y lo de la app lo atiende Ikisai');
  assert.deepEqual(retreatComments(items, R1).map((r) => r.id), [ids.late, ids.early]);
  assert.deepEqual(retreatComments(items, R1.toUpperCase()).map((r) => r.category), ['food', 'schedule']);
  assert.deepEqual(retreatComments(items, R2), []);
});

test('organizers · comentarios del retiro: la otra organizadora no ve los de Ana; el cliente pide la ruta de siempre', async () => {
  const res = await org('/api/v1/feedback?app=guests&status=all&limit=500', { token: otra.token });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const items = res.data.items as FeedbackItem[];
  assert.deepEqual(retreatComments(items, R1), []);
  assert.deepEqual(retreatComments(items, R2).map((r) => r.id), [ids.other]);
  const paths: string[] = [];
  const loaded = await loadGuestFeedback({ api: async <T>(path: string) => { paths.push(path); return { items: [] } as T; } });
  assert.deepEqual(loaded, []);
  assert.deepEqual(paths, ['/feedback?app=guests&status=all&limit=500']);
});

// --- Leídos y sin leer (0706) ----------------------------------------------------------------------------------------
const commit = (token: string, operations: unknown[]) => org('/api/v1/commands', { token, body: { requestId: `rd-${++seq}-${uuid()}`, operations } });
const read = (reservation_id: string, report_id: string, user_id: string) => ({ op: 'insert', table: TABLES.commentReads, id: uuid(), fields: { reservation_id, report_id, user_id } });
const code = (res: { data: any }) => res.data?.error?.code;

test('organizers · leídos: cada persona apunta lo suyo, de su retiro y de un comentario de asistente; no cambia', async () => {
  const ok = await commit(ana.token, [read(R1, ids.late, ana.id)]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(code(await commit(ana.token, [read(R2, ids.other, ana.id)])), 'OUT_OF_SCOPE', 'otro retiro');
  assert.equal(code(await commit(ana.token, [read(R1, ids.early, otra.id)])), 'INVALID_FIELDS', 'en nombre de otra');
  assert.equal(code(await commit(ana.token, [read(R1, ids.space, ana.id)])), 'INVALID_FIELDS', 'no es un comentario del retiro');
  assert.equal(code(await commit(ana.token, [read(R1, ids.other, ana.id)])), 'INVALID_FIELDS', 'comentario de otro retiro con este retiro');
  const row = (await booking.t.db.query<{ id: string; revision: string }>(`select id, revision from organizers.comment_reads where user_id = $1`, [ana.id])).rows[0]!;
  assert.equal(code(await commit(ana.token, [{ op: 'update', table: TABLES.commentReads, id: row.id, expectedRevision: Number(row.revision), fields: { report_id: ids.early } }])), 'IMMUTABLE_FIELD');
  assert.equal(code(await commit(ana.token, [{ op: 'delete', table: TABLES.commentReads, id: row.id, expectedRevision: Number(row.revision) }])), 'IMMUTABLE_FIELD');
  // Sin texto ni nombres: solo ids y la hora.
  const cols = (await booking.t.db.query<{ c: string }>(`select column_name c from information_schema.columns where table_schema = 'organizers' and table_name = 'comment_reads'`)).rows.map((r) => r.c).sort();
  assert.deepEqual(cols, ['created_at', 'deleted_at', 'id', 'read_at', 'report_id', 'reservation_id', 'revision', 'updated_at', 'updated_by', 'user_id']);
});

test('organizers · leídos: la coorganizadora no ve lo que lee Ana, y cuenta como sin leer para ella', async () => {
  const co = await organizerSession(R1, 'co-rc@example.invalid');
  const snap = async (token: string) => (await org(`/api/v1/snapshot?tables=${TABLES.commentReads}`, { token })).data.tables[0].rows as Array<{ report_id: string; user_id: string }>;
  assert.ok((await snap(ana.token)).some((r) => r.report_id === ids.late));
  assert.deepEqual(await snap(co.token), []);
  const mine = new Set((await snap(co.token)).map((r) => r.report_id));
  assert.deepEqual(unreadOf([ids.late, ids.early], mine), [ids.late, ids.early]);
  // La lógica del cliente: solo apunta los que faltan, una vez cada uno.
  const ops = readOperations([ids.late, ids.early, ids.early.toUpperCase()], new Set([ids.late]), R1, co.id);
  assert.deepEqual(ops.map((o) => o.fields.report_id), [ids.early]);
  assert.equal((await commit(co.token, ops)).status, 200);
});

test('organizers · leídos: «Mis retiros» cuenta por retiro los comentarios de asistentes sin ver, y nada más', () => {
  const R = uuid(), S = uuid();
  const item = (id: string, reservation: string | null, over: Partial<FeedbackItem> = {}): FeedbackItem => ({
    id, code: id, reporterKind: 'guest', subject: 'event', intent: 'comment', category: null, message: 'Bien',
    scope: reservation ? { reservation_id: reservation } : null, createdAt: '2026-10-20T10:00:00Z', ...over,
  });
  const items = [item('a', R), item('b', R.toUpperCase()), item('c', S), item('d', S), item('e', R, { subject: 'space' }),
    item('f', R, { reporterKind: 'staff' }), item('g', null)];
  assert.deepEqual([...unreadByReservation(items, new Set(['c', 'd']))], [[R, 2]]);
  assert.deepEqual([...unreadByReservation(items, new Set())].sort(), [[R, 2], [S, 2]].sort());
});

test('organizers · leídos: el KPI de Dirección cuenta los comentarios que nadie del retiro ha visto', async () => {
  const central = await booking.t.createUser();
  await booking.t.db.query(`insert into core.memberships (app, user_id, role) values ('central', $1, 'reader')`, [central]);
  const unread = async () => {
    const out = (await booking.t.rpc('core_read', { p_app: 'central', p_actor: central, p_name: 'organizers.central_kpi_projection', p_args: {} })) as any;
    return Number((out.rows as Array<Record<string, any>>).find((r) => r.kpi === 'organizers.guest_comments_unread_30d')!.value);
  };
  const fresh = await report(booking.users.reader, { subject: 'event', reservation_id: R1, message: 'Comentario nuevo de hoy.' });
  const before = await unread();
  assert.equal((await commit(ana.token, [read(R1, fresh, ana.id)])).status, 200);
  assert.equal(await unread(), before - 1, 'leído por una persona del retiro: ya no cuenta');
});

test('organizers · leídos: la conservación borra las de más de 180 días o de un retiro terminado hace más de 90; nadie más', async () => {
  const rows = async (user: string) => (await booking.t.db.query<{ id: string; report_id: string; deleted_at: string | null }>(
    'select id, report_id, deleted_at from organizers.comment_reads where user_id = $1 order by read_at', [user])).rows;
  const tick = async () => (await organizers(new Request(`${booking.supabase.url}/functions/v1/organizers-api/api/v1/worker/retention/tick`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();
  const has = async () => (await booking.t.db.query<{ v: boolean }>('select organizers.retention_has_work() v')).rows[0]!.v;
  // Quien organiza no puede borrar su lectura: solo la conservación.
  const own = (await rows(ana.id)).find((r) => !r.deleted_at)!;
  const rev = (await booking.t.db.query<{ revision: number }>('select revision from organizers.comment_reads where id = $1', [own.id])).rows[0]!.revision;
  const refused = await commit(ana.token, [{ op: 'delete', table: TABLES.commentReads, id: own.id, expectedRevision: Number(rev) }]);
  assert.deepEqual([refused.status, refused.data.error.code], [422, 'IMMUTABLE_FIELD']);
  assert.equal(await has(), false, 'todo es reciente y el retiro no ha terminado');

  // Una lectura de Ana, de hace 181 días: se va. La de la otra organizadora (de su retiro, reciente) se queda.
  await booking.t.db.query(`update organizers.comment_reads set read_at = now() - interval '181 days' where id = $1`, [own.id]);
  const keptOther = (await rows(otra.id)).filter((r) => !r.deleted_at).length;
  assert.equal(await has(), true);
  const run = await tick();
  assert.ok(run.reads >= 1, JSON.stringify(run));
  assert.ok((await rows(ana.id)).find((r) => r.id === own.id)!.deleted_at, 'borrada (lote del sistema)');
  assert.equal((await rows(otra.id)).filter((r) => !r.deleted_at).length, keptOther, 'las de otra no se tocan');

  // El retiro de Ana terminó hace más de 90 días: se van todas sus lecturas de ese retiro.
  await booking.t.db.query(`update booking.reservations set start_date = current_date - 100, end_date = current_date - 95 where id = $1`, [R1]);
  assert.equal(await has(), true);
  await tick();
  assert.deepEqual((await booking.t.db.query(`select 1 from organizers.comment_reads where reservation_id = $1 and deleted_at is null`, [R1])).rows, []);
  assert.equal(await has(), false);
});

