/** Booking · SES-2 (API.md §17.2–§17.4): comunicar la reserva tras el pago, lotes, rechazo, pausa y anulación, con un SES simulado. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSesTransport } from '../../supabase/functions/booking-api/ses/transport.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { fromBase64, unzipSingle } from '../../supabase/functions/_domain/booking/ses/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const ENV: Record<string, string> = { SES_PRE_USER: 'usuario-pre', SES_PRE_PASSWORD: 'clave-pre', SES_PRE_LANDLORD_CODE: '0000000001', SES_PRE_ESTABLISHMENT_CODE: '0000000002' };

/** SES simulado: guarda las peticiones y responde según el guion. */
const ses = {
  requests: [] as Array<{ auth: string; xml: string }>,
  submit: (): string => `<respuesta><codigo>0</codigo><descripcion>Ok</descripcion><lote>LOTE-${ses.requests.length}</lote></respuesta>`,
  batch: (lot: string): string => `<respuesta><codigo>0</codigo><descripcion>Ok</descripcion></respuesta><resultado><lote>${lot}</lote><codigoEstado>1</codigoEstado><descEstado>Tramitado</descEstado><resultadoComunicaciones><resultadoComunicacion><orden>1</orden><codigoComunicacion>COD-${lot}</codigoComunicacion></resultadoComunicacion></resultadoComunicaciones></resultado>`,
};
const fakeFetch: typeof fetch = async (_url, init) => {
  const xml = new TextDecoder().decode(init!.body as Uint8Array);
  ses.requests.push({ auth: (init!.headers as Record<string, string>).authorization ?? '', xml });
  if (xml.includes('consultaLoteRequest')) return new Response(ses.batch(/<lote>([^<]+)<\/lote>/.exec(xml)![1]!), { status: 200 });
  return new Response(ses.submit(), { status: 200 });
};

const tasks: Array<Record<string, any>> = [];
let tasksUp = true;
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY,
      ses: { transport: createSesTransport({ fetchImpl: fakeFetch }), env: (n) => ENV[n], notifyTasks: async (r) => { tasks.push(r); return tasksUp; } } }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `sr-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/ses/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}',
}))).json();
const status = async (id: string) => (await app.call(`/api/v1/ses/${id}`)).data.items as Array<Record<string, any>>;
const due = () => app.t.db.query(`update booking.ses_communications set next_attempt_at = now() - interval '1 second' where next_attempt_at is not null`);

async function confirmed(contact: string): Promise<string> {
  const id = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id, fields: { title: 'Retiro SES', status: 'pre_reservada', start_date: '2027-11-05', end_date: '2027-11-08', expected_guests: 18, contact_name: contact, contact_email: 'organiza@example.invalid' } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: id, event_id: uuid(), from_status: 'pre_reservada' } }]);
  return id;
}

test('ses · comunicar la reserva: sin pago no; con pago, lote en proceso; el tick lo da por aceptado; una sola viva por reserva', async () => {
  const id = await confirmed('Persona Organizadora Sintética');
  const noPay = await app.call(`/api/v1/ses/${id}/rh`, { body: {} });
  assert.equal(noPay.status, 422); assert.equal(noPay.data.error.code, 'SES_PAYMENT_REQUIRED');
  assert.equal((await app.call(`/api/v1/ses/${id}/rh`, { token: app.tokens.reader, body: {} })).status, 403);

  await ok([{ op: 'insert', table: TABLES.finance, id, fields: { deposit_required: 300, deposit_paid: 300, payment_type: 'transferencia', payment_date: '2027-10-01' } }]);
  const registered = (await app.t.db.query<{ at: string | null }>(`select payment_registered_at::text at from booking.reservation_finance where id = $1`, [id])).rows[0]!.at;
  assert.ok(registered, 'el momento legal es cuando se registra el pago en la app');

  ses.requests.length = 0;
  const sent = await app.call(`/api/v1/ses/${id}/rh`, { body: {} });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.equal(sent.data.status, 'en_proceso');
  assert.equal(ses.requests[0]!.auth, `Basic ${btoa('usuario-pre:clave-pre')}`);
  const inner = await unzipSingle(fromBase64(/<solicitud>([^<]+)<\/solicitud>/.exec(ses.requests[0]!.xml)![1]!));
  assert.match(inner.content, /<codigo>0000000002<\/codigo>/);
  assert.match(inner.content, /<rol>TI<\/rol><nombre>Persona<\/nombre><apellido1>Organizadora<\/apellido1><apellido2>Sintética<\/apellido2>/);
  assert.match(ses.requests[0]!.xml, /<codigoArrendador>0000000001<\/codigoArrendador>/);

  let items = await status(id);
  assert.equal(items[0]!.status, 'en_proceso'); assert.equal(items[0]!.lot_id, 'LOTE-1');
  assert.equal(items[0]!.snapshot.persons, 18);
  assert.ok(items[0]!.legal_start_at);
  assert.equal((await app.call(`/api/v1/ses/${id}/rh`, { body: {} })).data.error.code, 'SES_ALREADY_COMMUNICATED');

  await due();
  const t = await tick();
  assert.equal(t.checked, 1);
  items = await status(id);
  assert.equal(items[0]!.status, 'aceptada'); assert.equal(items[0]!.ses_code, 'COD-LOTE-1');
  const attempts = (await app.t.db.query(`select operation, outcome from booking.ses_attempts where communication_id = $1 order by created_at`, [items[0]!.id])).rows;
  assert.deepEqual(attempts, [{ operation: 'comunicacion', outcome: 'submitted' }, { operation: 'consultaLote', outcome: 'accepted' }]);
  assert.equal(JSON.stringify(await app.t.db.query('select * from booking.ses_communications')).includes('solicitud'), false, 'no se guarda el XML');

  // anular: comunicación de anulación que, aceptada, deja la original anulada
  const cancel = await app.call(`/api/v1/ses/${id}/cancel/${items[0]!.id}`, { body: {} });
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.match(ses.requests.at(-1)!.xml, /<tipoOperacion>B<\/tipoOperacion>/);
  await due(); await tick();
  items = await status(id);
  assert.deepEqual(items.map((c) => [c.kind, c.status]).sort(), [['RH', 'anulada'], ['anulacion', 'aceptada']]);
  // tras anular se puede volver a comunicar
  assert.equal((await app.call(`/api/v1/ses/${id}/rh`, { body: {} })).status, 200);
});

test('ses · datos que faltan, rechazo de SES y pausa', async () => {
  const single = await confirmed('Solo');
  await ok([{ op: 'insert', table: TABLES.finance, id: single, fields: { payment_type: 'efectivo', payment_date: '2027-10-02' } }]);
  const missing = await app.call(`/api/v1/ses/${single}/rh`, { body: {} });
  assert.equal(missing.status, 422); assert.equal(missing.data.error.code, 'SES_DATA'); assert.equal(missing.data.error.details.field, 'titular');
  assert.deepEqual(await status(single), [], 'si faltan datos no se registra nada');

  // rechazo de la petición (código distinto de 0)
  const rejected = await confirmed('Persona Rechazada');
  await ok([{ op: 'insert', table: TABLES.finance, id: rejected, fields: { payment_type: 'tarjeta', payment_date: '2027-10-02' } }]);
  const original = ses.submit;
  ses.submit = () => '<respuesta><codigo>109</codigo><descripcion>Formato de solicitud incorrecto</descripcion></respuesta>';
  const res = await app.call(`/api/v1/ses/${rejected}/rh`, { body: {} });
  ses.submit = original;
  assert.equal(res.data.status, 'rechazada');
  const [item] = await status(rejected);
  assert.deepEqual([item!.status, item!.error_code, item!.error_text], ['rechazada', 'SES_109', 'Formato de solicitud incorrecto']);

  // pausa: se prepara y no se envía; al quitarla, el tick la envía
  const paused = await confirmed('Persona Pausada');
  await ok([{ op: 'insert', table: TABLES.finance, id: paused, fields: { payment_type: 'transferencia', payment_date: '2027-10-02' } }]);
  const settings = (await app.t.db.query<{ id: string }>(`select id from booking.ses_settings`)).rows[0]!.id;
  await ok([{ op: 'update', table: TABLES.sesSettings, id: settings, expectedRevision: await revision(TABLES.sesSettings, settings), fields: { paused: true } }]);
  const before = ses.requests.length;
  assert.equal((await app.call(`/api/v1/ses/${paused}/rh`, { body: {} })).data.status, 'preparada');
  assert.equal(ses.requests.length, before, 'en pausa no llama a SES');
  await due(); await tick();
  assert.equal((await status(paused))[0]!.status, 'preparada');
  await ok([{ op: 'update', table: TABLES.sesSettings, id: settings, expectedRevision: await revision(TABLES.sesSettings, settings), fields: { paused: false } }]);
  await due(); await tick();
  assert.equal((await status(paused))[0]!.status, 'en_proceso');
});

test('ses · aviso a Tasks a las 12 h del pago sin comunicar: una vez, idempotente, y no si ya está en proceso', async () => {
  const late = await confirmed('Persona Tardía');
  const onTime = await confirmed('Persona Puntual');
  for (const id of [late, onTime]) await ok([{ op: 'insert', table: TABLES.finance, id, fields: { payment_type: 'transferencia', payment_date: '2027-10-03' } }]);
  await app.t.db.query(`update booking.reservation_finance set payment_registered_at = now() - interval '13 hours' where id = any($1::uuid[])`, [[late, onTime]]);
  await app.call(`/api/v1/ses/${onTime}/rh`, { body: {} }); // ya en proceso: no avisa
  tasks.length = 0;
  tasksUp = false;
  assert.equal((await tick()).notices, 0, 'si Tasks no responde, se reintenta en el siguiente tick');
  tasksUp = true;
  const t = await tick();
  const mine = tasks.filter((r) => r.external_url.endsWith(late));
  assert.equal(mine.length, 2, 'un intento fallido y uno bueno');
  assert.ok(!tasks.some((r) => r.external_url.endsWith(onTime)));
  assert.equal(t.notices >= 1, true);
  assert.deepEqual([mine[1]!.source, mine[1]!.kind, mine[1]!.priority], ['booking', 'booking.ses_deadline', 'critical']);
  assert.match(mine[1]!.due, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(mine[1]!.title.length <= 120 && mine[1]!.note.length <= 1000);
  assert.match(mine[1]!.external_ref, /:deadline$/);
  assert.ok((await app.t.rpc('core_service_actor', { p_name: 'booking' })), 'la cuenta de servicio existe antes de pedir a Tasks');
  const before = tasks.length;
  await tick();
  assert.equal(tasks.filter((r) => r.external_url.endsWith(late)).length, 2, 'una sola vez por reserva y momento legal');
  assert.ok(tasks.length >= before);
});

test('planificador · sondas: SES y Calendar solo despiertan la Edge si hay trabajo', async () => {
  const ticks = (await app.t.db.query<{ route: string; probe: string }>(`select route, probe from core.scheduled_ticks where app = 'booking' order by route`)).rows;
  assert.deepEqual(ticks, [{ route: 'calendar/tick', probe: 'booking.calendar_has_work' }, { route: 'ses/tick', probe: 'booking.ses_has_work' }]);
  const has = async (fn: string) => (await app.t.db.query<{ v: boolean }>(`select ${fn}() v`)).rows[0]!.v;
  await app.t.db.query(`update booking.ses_communications set next_attempt_at = now() + interval '1 hour' where status in ('preparada','en_proceso','error')`);
  await app.t.db.query(`insert into booking.ses_deadline_notices (reservation_id, legal_start_at) select f.id, f.payment_registered_at from booking.reservation_finance f where f.payment_registered_at is not null on conflict do nothing`);
  assert.equal(await has('booking.ses_has_work'), false);
  await app.t.db.query(`update booking.ses_communications set next_attempt_at = now() - interval '1 second' where id = (select id from booking.ses_communications where status in ('preparada','en_proceso','error') limit 1)`);
  assert.equal(await has('booking.ses_has_work'), true);
  await app.t.db.query(`update booking.calendar_sync_jobs set status = 'done'`);
  assert.equal(await has('booking.calendar_has_work'), false);
  await confirmed('Persona Calendario');
  assert.equal(await has('booking.calendar_has_work'), true, 'confirmar una reserva encola su trabajo de calendario');
});
