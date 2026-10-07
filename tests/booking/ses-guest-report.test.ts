/** Booking · SES-3: llegada y parte de viajeros (PV) con un SES simulado. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { createSesTransport } from '../../supabase/functions/booking-api/ses/transport.ts';
import { TABLES } from '../../supabase/functions/_domain/booking/mod.ts';
import { fromBase64, kinshipCode, unzipSingle } from '../../supabase/functions/_domain/booking/ses/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const ENV: Record<string, string> = { SES_PRE_USER: 'u', SES_PRE_PASSWORD: 'p', SES_PRE_LANDLORD_CODE: '0000000001', SES_PRE_ESTABLISHMENT_CODE: '0000000002' };
const sent: string[] = [];
const fakeFetch: typeof fetch = async (_url, init) => {
  const xml = new TextDecoder().decode(init!.body as Uint8Array);
  sent.push(xml);
  if (xml.includes('consultaLoteRequest')) {
    const lots = [...xml.matchAll(/<lote>([^<]+)<\/lote>/g)].map((m) => m[1]!);
    return new Response('<respuesta><codigo>0</codigo><descripcion>Ok</descripcion></respuesta>' + lots.map((lot) =>
      `<resultado><lote>${lot}</lote><codigoEstado>1</codigoEstado><descEstado>Ok</descEstado><resultadoComunicaciones><resultadoComunicacion><orden>1</orden><codigoComunicacion>PV-${lot}</codigoComunicacion></resultadoComunicacion></resultadoComunicaciones></resultado>`).join(''));
  }
  return new Response(`<respuesta><codigo>0</codigo><descripcion>Ok</descripcion><lote>L${sent.length}</lote></respuesta>`);
};

let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY,
      ses: { transport: createSesTransport({ fetchImpl: fakeFetch }), env: (n) => ENV[n], notifyTasks: null } }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `pv-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/ses/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();

const adult = (fields: Record<string, unknown>) => ({
  first_name: 'Ana', last_name_1: 'Sintética', last_name_2: 'Prueba', document_type: 'DNI', document_number: '00000000T', document_support_number: 'AAA000000',
  birth_date: '1990-01-01', nationality: 'ESP', sex: 'M', residence_address: 'C/ Falsa 1', residence_postal_code: '00000', residence_city: 'Villaprueba',
  residence_country: 'ESP', email: 'ana@example.invalid', ...fields,
});

test('ses · parentesco en texto libre al código del catálogo', () => {
  assert.deepEqual(['Madre', 'abuela', 'Tutor legal', 'tía', 'HJ', 'vecina', ''].map(kinshipCode), ['PM', 'AB', 'TU', 'TI', 'HJ', 'OT', null]);
});

test('ses · parte de viajeros: solo los listos, los incompletos no bloquean; tardíos después; con parte aceptado SES no se apaga', async () => {
  const res = uuid(); const event = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro PV', status: 'pre_reservada', start_date: '2027-12-10', end_date: '2027-12-12', expected_guests: 4, contact_name: 'Persona Organizadora' } }]);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: event, from_status: 'pre_reservada' } }]);
  const now = new Date().toISOString();
  const [ana, leo, eva, sin] = [uuid(), uuid(), uuid(), uuid()];
  await ok([
    { op: 'insert', table: TABLES.guests, id: ana, fields: { event_id: event, ...adult({}), arrived_at: now, document_checked_at: now, signed_at: now, signed_by_name: 'Ana Sintética' } },
    { op: 'insert', table: TABLES.guests, id: leo, fields: { event_id: event, ...adult({ first_name: 'Leo', document_type: null, document_number: null, document_support_number: null, birth_date: '2019-05-05', sex: 'H' }), is_minor: true, kinship: 'Madre', arrived_at: now } },
    { op: 'insert', table: TABLES.guests, id: eva, fields: { event_id: event, ...adult({ first_name: 'Eva', document_number: '11111111H' }), arrived_at: now, signed_at: now, signed_by_name: 'Eva' } },
    { op: 'insert', table: TABLES.guests, id: sin, fields: { event_id: event, ...adult({ first_name: 'Sin', document_number: '22222222J' }) } },
  ]);

  // quien ya consta enviado a mano no se vuelve a ofrecer
  const manual = uuid();
  await ok([{ op: 'insert', table: TABLES.guests, id: manual, fields: { event_id: event, ...adult({ first_name: 'Manual', document_number: '33333333P' }), arrived_at: now, document_checked_at: now, signed_at: now, signed_by_name: 'Manual', ses_status: 'enviado_SES', ses_sent_at: now } }]);
  const preview = await app.call(`/api/v1/ses/${res}/pv`);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.guests.map((g: any) => [g.first_name, g.ready, g.missing]).sort(), [
    ['Ana', true, []], ['Eva', false, ['document_checked']], ['Leo', true, []],
  ], 'Sin no ha llegado; Eva sin documento comprobado; Leo (8 años) no firma');

  const close = await app.call(`/api/v1/ses/${res}/pv`, { body: {} });
  assert.equal(close.status, 200, JSON.stringify(close.data));
  assert.equal(close.data.status, 'en_proceso');
  assert.deepEqual(close.data.pending, [{ id: eva, missing: ['document_checked'] }]);
  const inner = await unzipSingle(fromBase64(/<solicitud>([^<]+)<\/solicitud>/.exec(sent.at(-1)!)![1]!));
  assert.match(sent.at(-1)!, /<tipoComunicacion>PV<\/tipoComunicacion>/);
  assert.match(inner.content, /<numPersonas>2<\/numPersonas>/);
  assert.match(inner.content, /<nombre>Leo<\/nombre>[\s\S]*<parentesco>PM<\/parentesco>/);
  assert.doesNotMatch(inner.content, /Eva|Sin</);

  // repetir no duplica: Ana y Leo ya están en un parte vivo
  const again = await app.call(`/api/v1/ses/${res}/pv`, { body: {} });
  assert.equal(again.data.status, 'sin_listos');

  // Eva tardía: se comprueba su documento y se comunica sola
  await ok([{ op: 'update', table: TABLES.guests, id: eva, expectedRevision: await revision(TABLES.guests, eva), fields: { document_checked_at: now } }]);
  const late = await app.call(`/api/v1/ses/${res}/pv`, { body: { guest_ids: [eva] } });
  assert.equal(late.data.status, 'en_proceso');

  await app.t.db.query(`update booking.ses_communications set next_attempt_at = now() - interval '1 second'`);
  await tick();
  const items = (await app.call(`/api/v1/ses/${res}`)).data.items.filter((c: any) => c.kind === 'PV');
  assert.deepEqual(items.map((c: any) => c.status), ['aceptada', 'aceptada']);
  assert.ok(items.every((c: any) => c.legal_start_at));

  // con un parte aceptado, no se deja de comunicar a SES
  const off = await app.call('/api/v1/commands', { body: { requestId: `pv-${++seq}`, operations: [{ op: 'update', table: TABLES.reservations, id: res,
    expectedRevision: await revision(TABLES.reservations, res), fields: { ses_enabled: false, ses_disabled_reason: 'prueba' } }] } });
  assert.equal(off.status, 422); assert.equal(off.data.error.code, 'SES_ALREADY_REGISTERED');
});
