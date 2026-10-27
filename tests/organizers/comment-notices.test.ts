/**
 * Organizers · avisos por correo de comentarios nuevos (0709; AVISOS_COMENTARIOS.md). Un correo por persona que organiza,
 * como mucho cada hora, con lo que aún no ha visto de sus retiros y nada de nadie más; apagado, no sale nada. El SMTP, con
 * una conexión doble. Las Edge de Booking y Organizers sobre PGlite. Datos sintéticos.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createOrganizersApp, ORGANIZERS_ORIGINS } from '../../supabase/functions/organizers-api/app.ts';
import { TABLES as BOOKING } from '../../supabase/functions/_domain/booking/mod.ts';
import { TABLES } from '../../supabase/functions/_domain/organizers/mod.ts';
import { buildMessage, commentNoticeEmail, createSmtpMailer, SmtpError, type MailMessage, type SmtpConnection } from '../../supabase/functions/_domain/organizers/mail.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-pruebas';

// ---------- puro ----------

test('organizers · avisos: el correo dice el retiro y cuántos, sin el texto ni quién lo escribió', () => {
  const one = commentNoticeEmail([{ title: 'Retiro de otoño', comments: 1 }], 'https://organizers.ikisai.com/#/');
  assert.equal(one.subject, 'Un comentario nuevo de tus asistentes');
  assert.match(one.text, /- Retiro de otoño: 1 comentario nuevo\n/);
  assert.match(one.text, /https:\/\/organizers\.ikisai\.com\/#\//);
  const two = commentNoticeEmail([{ title: 'A\r\nBcc: x@y.z', comments: 2 }, { title: '', comments: 1 }], 'L');
  assert.equal(two.subject, '3 comentarios nuevos de tus asistentes');
  assert.match(two.text, /- A Bcc: x@y\.z: 2 comentarios nuevos\n- Tu retiro: 1 comentario nuevo/, 'un título no parte líneas');
});

test('organizers · avisos: el mensaje lleva el asunto en UTF-8 y el cuerpo en base64, sin cabeceras inyectadas', () => {
  const raw = buildMessage({ to: 'ana@example.invalid', subject: 'Comentarios nuevos\r\nBcc: robo@example.invalid', text: 'Hola:\nAquí está.' }, 'Ikisai <avisos@example.invalid>', new Date('2026-10-28T10:00:00Z'));
  const [head, body] = raw.split('\r\n\r\n');
  assert.doesNotMatch(head!, /^Bcc:/m);
  assert.match(head!, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(head!, /^Content-Transfer-Encoding: base64$/m);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(body!.replace(/\r\n/g, '')), (c) => c.charCodeAt(0))), 'Hola:\r\nAquí está.');
});

/** Un servidor SMTP de mentira: contesta por orden y guarda lo que recibe. */
function fakeSmtp(replies: string[]): { connect: () => Promise<SmtpConnection>; received: string[] } {
  const received: string[] = [];
  const queue = [...replies];
  let out = new TextEncoder().encode('');
  const push = () => { const next = queue.shift(); if (next !== undefined) out = new TextEncoder().encode(next + '\r\n'); };
  return {
    received,
    connect: async () => {
      push();
      return {
        async read(buffer) { if (!out.length) return null; const n = Math.min(buffer.length, out.length); buffer.set(out.subarray(0, n)); out = out.subarray(n); return n; },
        async write(data) { received.push(new TextDecoder().decode(data)); push(); return data.length; },
        close() { /* nada */ },
      };
    },
  };
}

test('organizers · avisos: SMTP con TLS, AUTH PLAIN y DATA; un 535 o una dirección rara no envían', async () => {
  const ok = fakeSmtp(['220 hola', '250-smtp.example.invalid\r\n250 AUTH PLAIN', '235 ok', '250 ok', '250 ok', '354 sigue', '250 en cola', '221 adiós']);
  const mailer = createSmtpMailer({ host: 'smtp.example.invalid', user: 'avisos', pass: 'secreto', from: 'Ikisai <avisos@example.invalid>', connect: ok.connect });
  await mailer.send({ to: 'ana@example.invalid', subject: 'Prueba', text: 'Hola' });
  assert.deepEqual(ok.received.slice(0, 5).map((l) => l.trim().split(' ')[0]), ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA']);
  assert.equal(ok.received[1]!.trim(), `AUTH PLAIN ${btoa('\u0000avisos\u0000secreto')}`);
  assert.equal(ok.received[2]!.trim(), 'MAIL FROM:<avisos@example.invalid>');
  assert.match(ok.received[5]!, /\r\n\.\r\n$/);
  const denied = fakeSmtp(['220 hola', '250 ok', '535 no']);
  await assert.rejects(createSmtpMailer({ host: 'h', user: 'u', pass: 'p', from: 'a@b.c', connect: denied.connect }).send({ to: 'ana@example.invalid', subject: 's', text: 't' }),
    (e: unknown) => e instanceof SmtpError && e.stage === 'auth');
  const never = fakeSmtp([]);
  await assert.rejects(createSmtpMailer({ host: 'h', user: 'u', pass: 'p', from: 'a@b.c', connect: never.connect }).send({ to: 'ana@x.invalid>\r\nRCPT TO:<robo@x.invalid', subject: 's', text: 't' }),
    (e: unknown) => e instanceof SmtpError && e.stage === 'address');
  assert.deepEqual(never.received, []);
});

// ---------- PGlite ----------

let booking: TestApp;
let organizers: (r: Request) => Promise<Response>;
let organizersOff: (r: Request) => Promise<Response>;
const outbox: MailMessage[] = [];
let seq = 0;

async function org(handler: (r: Request) => Promise<Response>, path: string, init: { token?: string; body?: unknown; worker?: boolean } = {}): Promise<{ status: number; data: any }> {
  const res = await handler(new Request(`${booking.supabase.url}/functions/v1/organizers-api${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers: { Origin: ORGANIZERS_ORIGINS[0]!, 'Content-Type': 'application/json', ...(init.token ? { Authorization: 'Bearer ' + init.token } : {}), ...(init.worker ? { 'X-Ikisai-Worker-Key': WORKER_KEY } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  }));
  return { status: res.status, data: await res.json().catch(() => null) };
}
const tick = (handler = organizers) => org(handler, '/api/v1/worker/comment-notices/tick', { body: {}, worker: true });
async function reservation(title: string): Promise<string> {
  const id = uuid();
  const res = await booking.call('/api/v1/commands', { body: { requestId: `cn-${++seq}-${uuid()}`, operations: [
    { op: 'insert', table: BOOKING.reservations, id, fields: { title, status: 'pre_reservada', start_date: '2026-11-06', end_date: '2026-11-08', expected_guests: 8 } }] } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return id;
}
async function organizerSession(reservation_id: string, email: string): Promise<{ token: string; id: string }> {
  const link = await booking.call('/api/v1/portal-links', { token: booking.tokens.editor, body: { app: 'organizers', scope: { reservation_id }, person: { name: 'Organizadora', email } } });
  assert.equal(link.status, 200, JSON.stringify(link.data));
  const session = await org(organizers, '/api/v1/auth/link', { body: { token: link.data.url.split('/i/')[1] } });
  assert.equal(session.status, 200, JSON.stringify(session.data));
  const me = await org(organizers, '/api/v1/me', { token: session.data.token });
  return { token: session.data.token, id: me.data.userId };
}
async function report(reservation_id: string, message: string, subject: 'event' | 'space' = 'event'): Promise<string> {
  const id = uuid();
  await booking.t.db.query(`insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, message, category, scope, destination, routing_status)
    values ($1, 'FB_CN_' || $2, $3, 'd', $4, 'guest', 'guests', $5, 'problem', $6, null, $7::jsonb, $8, 'none')`,
  [id, String(++seq), `cn-${seq}`, booking.users.reader, subject, message, JSON.stringify({ reservation_id, guest_id: uuid() }), subject === 'event' ? 'organizer' : 'operations']);
  return id;
}

let R1: string; let R2: string; let ana: { token: string; id: string }; let otra: { token: string; id: string };

test.before(async () => {
  booking = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!] }),
  });
  const base = { url: booking.supabase.url, anonKey: booking.supabase.anonKey, serviceKey: booking.supabase.serviceKey, fetch: booking.supabase.fetch, release: 'test', origins: [ORGANIZERS_ORIGINS[0]!], workerKey: WORKER_KEY };
  organizers = createOrganizersApp({ ...base, mail: { enabled: true, mailer: { send: async (m) => { outbox.push(m); } } } });
  organizersOff = createOrganizersApp({ ...base, mail: { enabled: false, mailer: { send: async (m) => { outbox.push(m); } } } });
  R1 = await reservation('Retiro de Ana');
  R2 = await reservation('Retiro de otra');
  ana = await organizerSession(R1, 'ana-cn@example.invalid');
  otra = await organizerSession(R2, 'otra-cn@example.invalid');
});
test.after(async () => { await booking.close(); });

test('organizers · avisos: un correo por persona con lo suyo sin leer; luego, una hora de espera; apagado, nada', async () => {
  const seen = await report(R1, 'Lo leyó ya.');
  await report(R1, 'La cena, estupenda.');
  await report(R1, 'Las sesiones, pronto.');
  await report(R1, 'La ducha no evacúa.', 'space');
  // Ana ya vio uno (0706): no se le avisa de ese.
  const read = await org(organizers, '/api/v1/commands', { token: ana.token, body: { requestId: `cn-${++seq}`, operations: [
    { op: 'insert', table: TABLES.commentReads, id: uuid(), fields: { reservation_id: R1, report_id: seen, user_id: ana.id } }] } });
  assert.equal(read.status, 200, JSON.stringify(read.data));

  assert.deepEqual((await tick(organizersOff)).data, { sent: 0, errors: 0, off: true });
  assert.equal(outbox.length, 0, 'apagado no envía');

  const first = await tick();
  assert.deepEqual(first.data, { sent: 1, errors: 0, skipped: 0 }, JSON.stringify(first.data));
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.to, 'ana-cn@example.invalid');
  assert.equal(outbox[0]!.subject, '2 comentarios nuevos de tus asistentes');
  assert.match(outbox[0]!.text, /- Retiro de Ana: 2 comentarios nuevos/);
  assert.doesNotMatch(outbox[0]!.text, /cena|sesiones|ducha|Retiro de otra/, 'ni el texto ni lo de otros');

  // Dentro de la hora, aunque llegue otro, no se escribe; pasada la hora, solo lo nuevo.
  await report(R1, 'Otra cosa.');
  assert.deepEqual((await tick()).data, { sent: 0, errors: 0, skipped: 0 });
  await booking.t.db.query(`update organizers.comment_notices set last_sent_at = now() - interval '61 minutes' where user_id = $1`, [ana.id]);
  await tick();
  assert.equal(outbox.length, 2);
  assert.equal(outbox[1]!.subject, 'Un comentario nuevo de tus asistentes');

  // La otra organizadora, con uno en su retiro: el suyo y nada del de Ana.
  await report(R2, 'Hola.');
  await tick();
  assert.equal(outbox.length, 3);
  assert.deepEqual([outbox[2]!.to, /Retiro de otra: 1 comentario nuevo/.test(outbox[2]!.text)], ['otra-cn@example.invalid', true]);
  assert.equal((await booking.t.db.query<{ v: boolean }>('select organizers.comment_notices_has_work() v')).rows[0]!.v, false);
});
