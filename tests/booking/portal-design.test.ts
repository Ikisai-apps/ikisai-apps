/** Booking · fase 2 de los portales, parte 2: diseño, extras, tarifas para la calculadora y peticiones (B7d, B9, B10, B12). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { applyMinimum, PROCEDURES, proposalTotals, suggestLines, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const tasks: Array<Record<string, any>> = [];
let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, ses: { notifyTasks: async (r) => { tasks.push(r as any); return true; } } }),
  });
});
test.after(async () => { await app.close(); });

const commands = (operations: unknown[]) => app.call('/api/v1/commands', { body: { requestId: `pz-${++seq}-${uuid()}`, operations } });
async function ok(operations: unknown[]) { const res = await commands(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); }
const invoke = (actor: string, name: string, args: unknown) => app.t.rpc('core_invoke', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const read = (actor: string, name: string, args: unknown) => app.t.rpc('core_read', { p_app: 'organizers', p_actor: actor, p_name: name, p_args: args }) as Promise<any>;
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);

test('diseño · el organizador diseña en estudio, pide extras visibles, calcula con las tarifas y pide confirmar sin aceptar', async () => {
  const res = uuid();
  await ok([{ op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro diseño', status: 'en_estudio', event_type: 'retiro', start_date: '2028-05-05', end_date: '2028-05-07', expected_guests: 10, internal_notes: 'interna' } }]);
  const org = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [org, JSON.stringify({ grants: [{ reservation_id: res }] })]);

  // sin tarifas visibles: la calculadora dice «Ikisai te enviará el precio»
  assert.equal((await read(org, 'booking.portal_rates', { reservation_id: res })).available, false);

  const stay = uuid(); const sound = uuid(); const hidden = uuid(); const cond = uuid();
  await ok([
    { op: 'insert', table: TABLES.rates, id: stay, fields: { name: 'Pensión completa grupo', layer: 'por_persona', unit: 'persona_noche', amount: 60, portal_visible: true, public_name: 'Pensión completa', public_description: 'Alojamiento y tres comidas' } },
    { op: 'insert', table: TABLES.rates, id: sound, fields: { name: 'Sonido', layer: 'extra', unit: 'estancia', amount: 120, portal_visible: true } },
    { op: 'insert', table: TABLES.rates, id: hidden, fields: { name: 'Interna', layer: 'extra', unit: 'estancia', amount: 50 } },
    { op: 'insert', table: TABLES.conditions, id: cond, fields: { name: 'Condiciones portal', is_default: true, vat_rate: 10, minimum_total: 2500 } },
  ]);

  // B7d: diseño con solo campos permitidos; los demás no se cuelan
  const draft = await invoke(org, 'booking.portal_update_draft', { reservation_id: res, fields: { expected_guests: 14, menu_style_requested: 'vegano', organizer_notes: 'Queremos sala grande', internal_notes: 'no', status: 'confirmada' },
    extras: [{ rate_id: sound, quantity: 1 }] });
  assert.ok(draft.revision);
  const r = (await app.t.db.query<Record<string, any>>(`select * from booking.reservations where id = $1`, [res])).rows[0]!;
  assert.deepEqual([r.expected_guests, r.menu_style_requested, r.organizer_notes, r.internal_notes, r.status], [14, 'vegano', 'Queremos sala grande', 'interna', 'en_estudio']);
  assert.deepEqual((await read(org, 'booking.portal_extra_requests', { reservation_id: res })).items.map((e: any) => e.name), ['Sonido']);
  await assert.rejects(invoke(org, 'booking.portal_update_draft', { reservation_id: res, extras: [{ rate_id: hidden }] }), (e: any) => e.code === 'EXTRA_NOT_OFFERED');

  // B9: tarifas visibles (con nombre público) y condiciones; Organizers calcula con el dominio
  const rates = await read(org, 'booking.portal_rates', { reservation_id: res });
  assert.equal(rates.available, true);
  assert.deepEqual(rates.rates.map((x: any) => x.name).sort(), ['Pensión completa', 'Sonido']);
  assert.equal(Number(rates.conditions.minimum_total), 2500);
  const lines = suggestLines({ event_type: 'retiro', start_date: '2028-05-05', end_date: '2028-05-07', expected_guests: 14 }, rates.rates);
  const totals = proposalTotals(lines, rates.conditions);
  assert.equal(totals.total, 14 * 2 * 60);
  assert.deepEqual(applyMinimum(totals.total, rates.conditions.minimum_total), { total: 2500, minimumApplied: true, minimum: 2500 });
  assert.deepEqual(applyMinimum(3000, 2500), { total: 3000, minimumApplied: false, minimum: 2500 });

  // B12: el personal envía la propuesta; el organizador la ve y pide confirmar o comenta, nunca acepta
  const proposal = uuid();
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: proposal } }]);
  await ok([{ op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, rate_id: stay, description: 'Pensión completa', unit: 'persona_noche', quantity: 28, unit_amount: 60 } }]);
  assert.deepEqual((await read(org, 'booking.portal_proposals', { reservation_id: res })).items, [], 'un borrador no se ve');
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: proposal } }]);
  const seen = (await read(org, 'booking.portal_proposals', { reservation_id: res })).items[0];
  assert.deepEqual([seen.status, Number(seen.total), seen.lines.length, seen.conditions.name], ['enviada', 1680, 1, 'Condiciones portal']);

  await assert.rejects(invoke(org, 'booking.portal_request', { reservation_id: res, kind: 'comentario' }), (e: any) => e.code === 'INVALID_FIELDS');
  await invoke(org, 'booking.portal_request', { reservation_id: res, kind: 'quiere_confirmar', proposal_id: proposal });
  await invoke(org, 'booking.portal_request', { reservation_id: res, kind: 'comentario', proposal_id: proposal, message: '¿Se puede añadir una noche?' });
  const mine = await read(org, 'booking.portal_my_requests', { reservation_id: res });
  assert.deepEqual(mine.items.map((q: any) => [q.kind, q.status, q.mine]).sort(), [['comentario', 'enviada', true], ['quiere_confirmar', 'enviada', true]]);
  assert.equal((await app.t.db.query<{ status: string }>(`select status from booking.proposals where id = $1`, [proposal])).rows[0]!.status, 'enviada', 'pedir confirmar no acepta');

  // el personal marca vista; no puede inventar peticiones
  const reqId = mine.items.find((q: any) => q.kind === 'quiere_confirmar').id;
  await ok([{ op: 'update', table: TABLES.portalRequests, id: reqId, expectedRevision: await revision('booking.portal_requests', reqId), fields: { status: 'vista' } }]);
  assert.equal((await commands([{ op: 'insert', table: TABLES.portalRequests, id: uuid(), fields: { reservation_id: res, kind: 'comentario', message: 'x' } }])).status, 422);

  // avisos a Tasks: «quiere confirmar» con prioridad alta
  tasks.length = 0;
  await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/portal/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }));
  assert.deepEqual(tasks.map((t) => [t.kind, t.priority]).sort(), [['booking.organizer_confirm', 'high'], ['booking.proposal_comment', 'normal']]);

  // con la reserva fuera de estudio o negociación, el diseño se bloquea
  await app.t.db.query(`update booking.reservations set status = 'pre_reservada' where id = $1`, [res]);
  await assert.rejects(invoke(org, 'booking.portal_update_draft', { reservation_id: res, fields: { expected_guests: 20 } }), (e: any) => e.code === 'DRAFT_LOCKED');
});
