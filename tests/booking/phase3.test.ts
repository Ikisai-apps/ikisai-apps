/** Booking · fase 3 de los portales: lo contratado para el portal (F1) y el proyecto del retiro y sus extras en Tasks (B13). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createBookingApp, BOOKING_ORIGINS } from '../../supabase/functions/booking-api/app.ts';
import { PROCEDURES, TABLES } from '../../supabase/functions/_domain/booking/mod.ts';

const uuid = () => crypto.randomUUID();
const WORKER_KEY = 'clave-de-worker-de-prueba';
const calls: Array<{ path: string; body: Record<string, any> }> = [];
let route = true;
let projects = new Map<string, string>();
const fakeTasks = async (path: string, body: Record<string, any>) => {
  calls.push({ path, body });
  if (path === 'requests/project') {
    if (!route) return { status: 200, data: { projectId: null, status: 'no_route' } };
    const existed = projects.has(body.external_ref);
    projects.set(body.external_ref, projects.get(body.external_ref) ?? uuid());
    return { status: 200, data: { projectId: projects.get(body.external_ref), status: body.state === 'cancelled' ? 'archived' : existed ? 'renamed' : 'created' } };
  }
  if (!projects.has(body.project_ref)) return { status: 409, data: { error: { code: 'PROJECT_NOT_READY' } } };
  return { status: 200, data: { taskId: uuid(), status: 'created' } };
};

let app: TestApp;
let seq = 0;
test.before(async () => {
  app = await createTestApp({
    app: 'booking', slug: 'booking-api', origin: BOOKING_ORIGINS[0]!,
    createHandler: (config) => createBookingApp({ ...config, origins: [BOOKING_ORIGINS[0]!], workerKey: WORKER_KEY, ses: { notifyTasks: null, tasksPost: fakeTasks } }),
  });
});
test.after(async () => { await app.close(); });

async function ok(operations: unknown[]) {
  const res = await app.call('/api/v1/commands', { body: { requestId: `f3-${++seq}-${uuid()}`, operations } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
}
const revision = async (table: string, id: string) => Number((await app.t.db.query<{ revision: string }>(`select revision from ${table} where id = $1`, [id])).rows[0]!.revision);
const tick = async () => (await app.handler(new Request(`${app.supabase.url}/functions/v1/booking-api/api/v1/worker/tasks/tick`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ikisai-Worker-Key': WORKER_KEY }, body: '{}' }))).json();

test('fase 3 · lo contratado sin lo pagado; proyecto en Tasks creado, renombrado y archivado; extras tras el proyecto', async () => {
  const cond = uuid(); const sound = uuid(); const res = uuid(); const proposal = uuid();
  await ok([
    { op: 'insert', table: TABLES.conditions, id: cond, fields: { name: 'Condiciones F3', is_default: true, deposit_percent: 30, deposit_minimum: 0, deposit_days: 5, short_notice_days: 15 } },
    { op: 'insert', table: TABLES.rates, id: sound, fields: { name: 'Equipo de sonido', layer: 'extra', unit: 'estancia', amount: 200 } },
    { op: 'insert', table: TABLES.reservations, id: res, fields: { title: 'Retiro F3', status: 'pre_reservada', start_date: '2028-09-08', end_date: '2028-09-10', expected_guests: 10, contact_name: 'Persona Organizadora', contact_phone: '600000000' } },
  ]);
  await ok([{ op: 'call', procedure: PROCEDURES.newProposalVersion, args: { reservation_id: res, proposal_id: proposal } }]);
  await ok([
    { op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, description: 'Estancia', unit: 'unidad', quantity: 1, unit_amount: 3000, position: 1 } },
    { op: 'insert', table: TABLES.proposalLines, id: uuid(), fields: { proposal_id: proposal, rate_id: sound, description: 'Equipo de sonido', unit: 'estancia', quantity: 1, unit_amount: 200, position: 2 } },
  ]);
  await ok([{ op: 'call', procedure: PROCEDURES.sendProposal, args: { proposal_id: proposal } }]);
  await ok([{ op: 'call', procedure: PROCEDURES.acceptProposal, args: { proposal_id: proposal } }]);
  await ok([{ op: 'update', table: TABLES.finance, id: res, expectedRevision: await revision('booking.reservation_finance', res), fields: { payment_type: 'transferencia', deposit_paid: 500 } }]);

  // F1
  const org = await app.t.createUser();
  await app.t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('organizers', $1, 'editor', $2::jsonb)`, [org, JSON.stringify({ grants: [{ reservation_id: res }] })]);
  const detail = (await app.t.rpc('core_read', { p_app: 'organizers', p_actor: org, p_name: 'booking.portal_reservation_detail', p_args: { reservation_id: res } })) as any;
  assert.deepEqual([Number(detail.contract.total), Number(detail.contract.deposit_required), detail.contract.payment_type, detail.contract.proposal_version], [3200, 960, 'transferencia', 1]);
  assert.deepEqual(detail.contract.due.map((d: any) => [d.kind, Number(d.amount)]), [['senal', 960], ['saldo', 2240]]);
  assert.equal(detail.contract.due[1].date, '2028-09-11', 'el saldo vence 24 h después del final (día siguiente al de salida)');
  assert.equal(detail.contract.due[1].hours_after_end, 24);
  assert.ok(!JSON.stringify(detail).includes('deposit_paid') && !JSON.stringify(detail.contract).includes('500'), 'lo pagado no sale de Booking');

  // B13: sin confirmar no hay proyecto; al confirmar, primero sin ruta (se reintenta) y después se crea con su extra
  calls.length = 0;
  assert.equal((await tick()).projects, 0);
  await ok([{ op: 'call', procedure: 'booking.confirm_reservation', args: { reservation_id: res, event_id: uuid(), from_status: 'pre_reservada' } }]);
  route = false;
  let out = await tick();
  assert.deepEqual([out.projects, out.extras], [0, 0]);
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.tasks_has_work() v`)).rows[0]!.v, true);
  route = true;
  out = await tick();
  assert.deepEqual([out.projects, out.extras], [1, 0], 'el extra espera a que el proyecto conste');
  const code = (await app.t.db.query<{ code: string }>(`select code from booking.reservations where id = $1`, [res])).rows[0]!.code;
  const project = calls.filter((c) => c.path === 'requests/project').at(-1)!.body;
  assert.deepEqual([project.external_ref, project.date, project.title, project.state, project.kind], [`RES${code}`, '2028-09-08', 'Retiro F3', 'confirmed', 'booking.retreat_project']);
  assert.ok(!JSON.stringify(calls).includes('600000000') && !JSON.stringify(calls).includes('Persona Organizadora'), 'sin datos de contacto');
  out = await tick();
  assert.deepEqual([out.projects, out.extras], [0, 1]);
  const extra = calls.filter((c) => c.path === 'requests/task').at(-1)!.body;
  assert.deepEqual([extra.kind, extra.project_ref, extra.due, extra.title], ['booking.retreat_extra', `RES${code}`, '2028-09-08', 'Equipo de sonido']);
  assert.equal((await tick()).projects + (await tick()).extras, 0, 'nada más que hacer');

  // proyecto en la papelera de Tasks: sus extras nuevos no se piden; al restaurarse, sí
  const line2 = uuid();
  await app.t.db.query(`update booking.tasks_projects set last_status = 'deleted' where reservation_id = $1`, [res]);
  await app.t.db.query(`insert into booking.proposal_lines (proposal_id, rate_id, description, unit, quantity, unit_amount, position, id)
    select $1, $2, 'Equipo de sonido extra', 'estancia', 1, 200, 3, $3`, [proposal, sound, line2]).catch(async () => {
    // la propuesta aceptada está bloqueada: se inserta como el procedimiento (marca local de la transacción)
    await app.t.db.query(`select set_config('booking.proposal_procedure', 'on', false)`);
    await app.t.db.query(`insert into booking.proposal_lines (proposal_id, rate_id, description, unit, quantity, unit_amount, position, id) values ($1, $2, 'Equipo de sonido extra', 'estancia', 1, 200, 3, $3)`, [proposal, sound, line2]);
    await app.t.db.query(`select set_config('booking.proposal_procedure', '', false)`);
  });
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.tasks_has_work() v`)).rows[0]!.v, false, 'con el proyecto en la papelera no se reintenta');
  await app.t.db.query(`update booking.tasks_projects set last_status = 'restored' where reservation_id = $1`, [res]);
  assert.equal((await tick()).extras, 1, 'al restaurarse el proyecto, se pide el extra pendiente');

  // cambia la fecha: se renombra; se cancela: se archiva
  await ok([{ op: 'update', table: TABLES.reservations, id: res, expectedRevision: await revision('booking.reservations', res), fields: { start_date: '2028-09-15', end_date: '2028-09-17' } }]);
  out = await tick();
  assert.equal(out.projects, 1);
  assert.equal(calls.filter((c) => c.path === 'requests/project').at(-1)!.body.date, '2028-09-15');
  await ok([{ op: 'update', table: TABLES.reservations, id: res, expectedRevision: await revision('booking.reservations', res), fields: { status: 'cancelada' } }]);
  out = await tick();
  assert.equal(calls.filter((c) => c.path === 'requests/project').at(-1)!.body.state, 'cancelled');
  assert.equal((await app.t.db.query<{ v: boolean }>(`select booking.tasks_has_work() v`)).rows[0]!.v, false);
});
