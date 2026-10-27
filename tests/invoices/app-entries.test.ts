/**
 * 0244 (API.md §17): ingresos y gastos que llegan de otras apps. `invoices.record_app_entry` es idempotente por
 * (source_app, source_ref) y sustituye el apunte salvo que ya esté entregado a la gestoría; en Finance solo se cambian
 * el evento y las notas; todo apunte es real y entra en el resumen y en la entrega (decisión de VG del 26-10).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { CSV_BOM } from '../../packages/domain-invoices/src/index.ts';
import { checkAppEntrySources, serverCaller, withServerCaller } from '../../supabase/functions/invoices-api/app-entries-caller.ts';

let app: TestApp;
let counter = 0;
const PROJECT = '7d1c1a52-3f0e-4c55-9b7a-0c6a3e7f2b10';
const REF = `flow:project:${PROJECT}:2026-10-31`;
const WORKER_KEY = 'clave-de-worker-de-pruebas';
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const update = (id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table: 'invoices.app_entries', id, expectedRevision, fields });

/** Un `record_app_entry` llega desde el servidor de su app (F1, §17.10): la prueba de origen va con su `source_app`. */
function commit(operations: unknown[], token?: string) {
  const entry = (operations as Array<{ procedure?: string; args?: { source_app?: string } }>).find((o) => o.procedure === 'invoices.record_app_entry');
  const headers: Record<string, string> = entry?.args?.source_app ? { 'X-Ikisai-Worker-Key': WORKER_KEY, 'X-Ikisai-Caller': entry.args.source_app } : {};
  return app.call('/api/v1/commands', { body: { requestId: `entries-${++counter}`, operations }, headers, ...(token ? { token } : {}) });
}
async function ok(operations: unknown[], token?: string) {
  const res = await commit(operations, token);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function rejected(operations: unknown[], code: string, status = 422, token?: string) {
  const res = await commit(operations, token);
  assert.equal(res.status, status, JSON.stringify(res.data));
  assert.equal(res.data.error.code, code, JSON.stringify(res.data));
  return res.data.error;
}
async function entry(id: string): Promise<Record<string, any>> {
  const snap = await app.call('/api/v1/snapshot?tables=invoices.app_entries');
  return (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id)!;
}
/** Lo que manda Flow al cerrar el día: 1234,50 € con IVA, 2 € de devolución pendiente. */
function barDay(extra: Record<string, unknown> = {}) {
  return {
    source_app: 'flow', source_ref: REF, kind: 'income', entry_date: '2026-10-31', description: 'Barra · Evento de octubre · 31-10',
    amount_cents: 123450, tax_rate: 10, pending_refunds_cents: 200, methods: { cash: 80000, bizum: 43450 },
    detail: [{ code: 'A', name: 'Montadito clásico A', quantity: 100, amount_cents: 70000 }, { code: 'α', name: 'Caña', quantity: 205, amount_cents: 53250 }],
    event_id: null, ...extra,
  };
}
const record = async (args: Record<string, unknown>, token?: string) => (await ok([call('invoices.record_app_entry', args)], token)).results[0].result;

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null }, workerKey: WORKER_KEY }),
  });
});
test.after(async () => { await app.close(); });

test('un apunte nuevo: IVA incluido y neto redondeado; repetirlo no cambia nada', async () => {
  const first = await record(barDay(), app.tokens.editor);
  assert.equal(first.status, 'created');
  // 123450 / 1,10 = 112227,27 → 112227 de neto y 11223 de cuota
  assert.equal(Number(first.net_cents), 112227);
  assert.equal(Number(first.tax_cents), 11223);
  const row = await entry(first.entry_id);
  assert.equal(row.source_app, 'flow');
  assert.equal(row.kind, 'income');
  assert.deepEqual(row.methods, { cash: 80000, bizum: 43450 });
  assert.ok(row.received_by, 'queda quién lo envió');

  const again = await record(barDay());
  assert.equal(again.status, 'unchanged');
  assert.equal(again.entry_id, first.entry_id);
  assert.equal(Number(again.revision), Number(first.revision));
});

test('validación de lo que manda la otra app', async () => {
  const bad = (extra: Record<string, unknown>, field: string) => rejected([call('invoices.record_app_entry', barDay(extra))], 'INVALID_ARGS').then((e) => assert.equal(e.details.field, field));
  await bad({ source_app: 'nada' }, 'source_app');
  await bad({ source_app: 'invoices', source_ref: 'invoices:x' }, 'source_app');
  await bad({ source_ref: `tasks:${PROJECT}` }, 'source_ref');
  await bad({ kind: 'transfer' }, 'kind');
  await bad({ entry_date: '31-10-2026' }, 'entry_date');
  await bad({ amount_cents: 12.5 }, 'amount_cents');
  await bad({ tax_rate: '10' }, 'tax_rate');
  await bad({ methods: { cash: 1000 } }, 'methods');
  await bad({ pending_refunds_cents: 0 }, 'detail');
  await bad({ tax_cents: 11000 }, 'tax_cents');
  await bad({ event_id: 'no-es-un-uuid' }, 'event_id');
  // Sin desglose ni medios también vale
  const plain = await record({ source_app: 'flow', source_ref: `flow:project:${PROJECT}:2026-10-30`, kind: 'income', entry_date: '2026-10-30', description: 'Barra · 30-10', amount_cents: 0, tax_rate: 10 });
  assert.equal(plain.status, 'created');
});

test('el lector no envía; en Finance no se crea, no se borra y no se toca lo que viene de la otra app', async () => {
  await rejected([call('invoices.record_app_entry', barDay())], 'FORBIDDEN', 403, app.tokens.reader);
  const { entry_id: id } = await record(barDay());
  const row = await entry(id);
  await rejected([{ op: 'insert', table: 'invoices.app_entries', id: uuid(), fields: { notes: 'a mano' } }], 'APP_ENTRY_PROCEDURE_ONLY');
  await rejected([update(id, row.revision, { amount_cents: 1 })], 'INVALID_FIELDS');
  await rejected([{ op: 'delete', table: 'invoices.app_entries', id, expectedRevision: row.revision }], 'APP_ENTRY_NOT_DELETABLE');
});

test('evento y notas desde Finance; la otra app no los pisa al sustituir; todo cuenta en el resumen', async () => {
  const EVENT = uuid();
  const { entry_id: id } = await record(barDay());
  let row = await entry(id);
  await ok([update(id, row.revision, { event_id: EVENT, notes: 'Caja cuadrada' })], app.tokens.editor);

  // Flow reenvía el cierre con una devolución ya confirmada: se sustituye y conserva el evento y las notas.
  const replaced = await record(barDay({ amount_cents: 123250, pending_refunds_cents: 0, methods: { cash: 79800, bizum: 43450 } }));
  assert.equal(replaced.status, 'replaced');
  row = await entry(id);
  assert.equal(Number(row.amount_cents), 123250);
  assert.equal(row.event_id, EVENT);
  assert.equal(row.notes, 'Caja cuadrada');

  const summary = (await app.call('/api/v1/read/invoices.app_entries_summary', { body: { year: 2026, quarter: 4 } })).data;
  assert.equal(Number(summary.income.count), 2, 'el del 30-10 y el del 31-10');
  assert.equal(Number(summary.income.total), 1232.5);
  assert.deepEqual(summary.income.quota_by_rate.map((g: any) => [Number(g.rate), Number(g.base), Number(g.quota)]), [[10, 1120.45, 112.05]]);
  assert.equal(summary.not_invoiced, undefined, 'no hay «sin facturar»');
});

test('entrega a la gestoría: los apuntes van en el manifest y el CSV; entregada, ya no se sustituyen', async () => {
  const exportId = uuid();
  const created = (await ok([call('invoices.create_export', { export_id: exportId, period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 4 })])).results[0].result;
  assert.equal(Number(created.invoice_count), 0);
  assert.equal(Number(created.app_entry_count), 2, 'una entrega solo con apuntes de apps no está vacía');

  const bundle = (await app.call('/api/v1/read/invoices.export_bundle', { body: { export_id: exportId } })).data;
  assert.equal(bundle.stale, false);
  assert.equal(bundle.manifest.app_entries.length, 2);
  assert.equal(Number(bundle.manifest.app_entries_totals.income.quota), 112.05);

  const csv = await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/ingresos_gastos_apps.csv`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }));
  assert.equal(csv.status, 200);
  // Response.text() se come el BOM: se lee en bytes para comprobar que va
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await csv.arrayBuffer());
  assert.ok(text.startsWith(CSV_BOM));
  assert.ok(text.includes(`2026-10-31;flow;${REF};ingreso;Barra · Evento de octubre · 31-10;10;1120,45;112,05;1232,50;0,00;cash: 798,00 | bizum: 434,50`), text);
  const taxes = await (await app.handler(new Request(`${app.supabase.url}/functions/v1/invoices-api/api/v1/exports/${exportId}/resumen_impuestos.csv`, { headers: { Origin: app.origin, Authorization: 'Bearer ' + app.tokens.owner } }))).text();
  assert.ok(taxes.includes('iva_repercutido_apps;10;1120,45;112,05'), taxes);

  // Antes de entregarla, un reenvío la deja desactualizada
  await record(barDay({ amount_cents: 123350, pending_refunds_cents: 100, methods: { cash: 79900, bizum: 43450 } }));
  assert.equal((await app.call('/api/v1/read/invoices.export_bundle', { body: { export_id: exportId } })).data.stale, true);

  const second = uuid();
  await ok([call('invoices.create_export', { export_id: second, period_kind: 'quarter', fiscal_year: 2026, fiscal_quarter: 4 })]);
  await ok([call('invoices.mark_delivered', { export_id: second, delivered_to: 'Gestoría' })]);
  const locked = await rejected([call('invoices.record_app_entry', barDay({ amount_cents: 123450, pending_refunds_cents: 200 }))], 'ENTRY_LOCKED', 409);
  assert.equal(locked.details.source_ref, REF);
  // Lo mismo que ya está entregado sí responde, sin cambiar nada
  assert.equal((await record(barDay({ amount_cents: 123350, pending_refunds_cents: 100, methods: { cash: 79900, bizum: 43450 } }))).status, 'unchanged');
  const row = (await app.call('/api/v1/snapshot?tables=invoices.app_entries')).data.tables[0].rows.find((r: any) => r.source_ref === REF);
  // Las notas sí se pueden escribir
  await ok([update(row.id, row.revision, { notes: 'Revisado con la caja del día' })]);
});

test('liquidación de cuenta de cliente (pago único que cierra varios pedidos): cabe en el modelo, con el desglose por pedido', async () => {
  const PAYMENT = '0c2f7d2a-5b1e-4f3a-9d6c-1e2f3a4b5c6d';
  const settlement = {
    source_app: 'flow', source_ref: `flow:settlement:${PAYMENT}`, kind: 'income', entry_date: '2026-11-01', description: 'Cuenta del cliente 112 · liquidación',
    amount_cents: 3600, tax_rate: 10, methods: { bizum: 3600 },
    detail: [
      { code: 'P 14', name: 'Pedido 14', quantity: 1, amount_cents: 2100, order_id: '1d6e2c5a-7f3b-4a8e-9c1d-2b3a4c5d6e7f' },
      { code: 'P 31', name: 'Pedido 31', quantity: 1, amount_cents: 1500, order_id: '2e7f3d6b-8a4c-4b9f-8d2e-3c4b5d6e7f80' },
    ],
  };
  const first = await record(settlement);
  assert.equal(first.status, 'created');
  const row = await entry(first.entry_id);
  assert.equal(row.detail.length, 2);
  assert.equal(row.detail[1].order_id, '2e7f3d6b-8a4c-4b9f-8d2e-3c4b5d6e7f80', 'la referencia del pedido se guarda tal cual');
  assert.equal((await record(settlement)).status, 'unchanged');
  // El desglose por pedido tiene que sumar lo cobrado
  await rejected([call('invoices.record_app_entry', { ...settlement, amount_cents: 3700, methods: { bizum: 3700 } })], 'INVALID_ARGS');
});

test('0245: fiscal y de proceso. Por defecto, fiscal; lo de proceso no va a la gestoría ni al IVA; no cambia al sustituir', async () => {
  const day = (ref: string, extra: Record<string, unknown> = {}) => ({ source_app: 'flow', source_ref: `flow:project:${PROJECT}:${ref}`, kind: 'income', entry_date: '2026-12-20',
    description: `Barra · ${ref}`, amount_cents: 11000, tax_rate: 10, methods: { cash: 11000 }, ...extra });
  const fiscal = await record(day('fiscal-20-12'));
  assert.equal(fiscal.nature, 'fiscal', 'sin nature, fiscal (lo de siempre)');
  const process = await record(day('cierre-20-12', { nature: 'process', amount_cents: 55000, methods: { cash: 55000 } }));
  assert.equal(process.nature, 'process');
  assert.equal((await entry(process.entry_id)).nature, 'process');

  const summary = (await app.call('/api/v1/read/invoices.app_entries_summary', { body: { from: '2026-12-20', to: '2026-12-20' } })).data;
  assert.equal(Number(summary.income.count), 1);
  assert.equal(Number(summary.income.total), 110);
  assert.deepEqual([Number(summary.process.count), Number(summary.process.income)], [1, 550]);
  const manifest = (await app.t.db.query<{ m: any }>(`select invoices.app_entries_manifest('2026-12-20', '2026-12-20') m`)).rows[0]!.m;
  assert.deepEqual(manifest.map((x: any) => x.source_ref), [`flow:project:${PROJECT}:fiscal-20-12`]);

  // Sin «desfacturar»: la naturaleza no cambia al sustituir
  const change = await rejected([call('invoices.record_app_entry', day('cierre-20-12', { nature: 'fiscal', amount_cents: 55000, methods: { cash: 55000 } }))], 'NATURE_CHANGE', 409);
  assert.equal(change.details.nature, 'process');
  await rejected([call('invoices.record_app_entry', day('otro-20-12', { nature: 'informativo' }))], 'INVALID_ARGS');
  // Con la misma naturaleza, se sustituye como siempre
  assert.equal((await record(day('cierre-20-12', { nature: 'process', amount_cents: 56000, methods: { cash: 56000 } }))).status, 'replaced');
  // En Finance no se cambia
  const row = await entry(process.entry_id);
  await rejected([update(process.entry_id, row.revision, { nature: 'fiscal' })], 'INVALID_FIELDS');
});

test('0245: un gasto es fiscal solo con justificante; al adjuntarlo pasa a fiscal y al revés no', async () => {
  const expense = (ref: string, extra: Record<string, unknown> = {}) => ({ source_app: 'flow', source_ref: `flow:project:${PROJECT}:${ref}`, kind: 'expense', entry_date: '2026-12-21',
    description: `Hielo · ${ref}`, amount_cents: 2420, tax_rate: 21, methods: { cash: 2420 }, ...extra });
  // Sin nature ni justificante: de proceso
  const hielo = await record(expense('hielo'));
  assert.equal(hielo.nature, 'process');
  // Un gasto fiscal sin justificante, no
  await rejected([call('invoices.record_app_entry', expense('vasos', { nature: 'fiscal' }))], 'INVOICE_REQUIRED');
  // Con el número del ticket al reenviar, pasa a fiscal
  const withTicket = await record(expense('hielo', { receipt_number: 'T-77', receipt_kind: 'invoice' }));
  assert.deepEqual([withTicket.status, withTicket.nature], ['replaced', 'fiscal']);
  // Un reenvío sin justificante no lo quita, y no vuelve a proceso
  assert.equal((await record(expense('hielo', { receipt_number: 'T-77' }))).status, 'unchanged');
  assert.equal((await record(expense('hielo'))).nature, 'fiscal');
  await rejected([call('invoices.record_app_entry', expense('hielo', { nature: 'process' }))], 'NATURE_CHANGE', 409);
  // Un documento que no es de Finance o no está verificado, no
  await rejected([call('invoices.record_app_entry', expense('servilletas', { receipt_file_id: uuid(), receipt_kind: 'invoice' }))], 'INVALID_FILE');

  // En Finance: adjuntar el número a un gasto de proceso lo pasa a fiscal; quitarlo de un gasto fiscal, no
  const servilletas = await record(expense('servilletas'));
  assert.equal(servilletas.nature, 'process');
  let row = await entry(servilletas.entry_id);
  await ok([update(servilletas.entry_id, row.revision, { receipt_number: 'F-2026-118' })], app.tokens.editor);
  row = await entry(servilletas.entry_id);
  assert.deepEqual([row.nature, row.receipt_number], ['fiscal', 'F-2026-118']);
  await rejected([update(servilletas.entry_id, row.revision, { receipt_number: null })], 'INVOICE_REQUIRED');
  const summary = (await app.call('/api/v1/read/invoices.app_entries_summary', { body: { from: '2026-12-21', to: '2026-12-21' } })).data;
  assert.equal(Number(summary.expense.count), 2, 'los dos gastos con justificante');
});

test('0247: un gasto con ticket se registra, pero no es fiscal; con factura sí, y su IVA cuenta como soportado', async () => {
  const expense = (ref: string, extra: Record<string, unknown> = {}) => ({ source_app: 'flow', source_ref: `flow:project:${PROJECT}:${ref}`, kind: 'expense', entry_date: '2026-12-22',
    description: `Compra · ${ref}`, amount_cents: 1210, tax_rate: 21, methods: { cash: 1210 }, ...extra });
  const ticket = await record(expense('limones', { receipt_number: 'T-9', receipt_kind: 'ticket' }));
  assert.deepEqual([ticket.nature, ticket.receipt_kind], ['process', 'ticket']);
  await rejected([call('invoices.record_app_entry', expense('limones', { receipt_kind: 'ticket', nature: 'fiscal' }))], 'INVOICE_REQUIRED');
  // Llega la factura: pasa a fiscal; una factura no vuelve a ser ticket
  const invoice = await record(expense('limones', { receipt_number: 'F-31', receipt_kind: 'invoice' }));
  assert.deepEqual([invoice.status, invoice.nature, invoice.receipt_kind], ['replaced', 'fiscal', 'invoice']);
  await rejected([call('invoices.record_app_entry', expense('limones', { receipt_kind: 'ticket' }))], 'NATURE_CHANGE', 409);
  // Un ingreso con ticket sigue siendo fiscal (la venta va al IVA repercutido)
  const sale = await record({ ...expense('venta', { kind: 'income', receipt_number: 'TK-1', receipt_kind: 'ticket' }) });
  assert.equal(sale.nature, 'fiscal');
  const summary = (await app.call('/api/v1/read/invoices.app_entries_summary', { body: { from: '2026-12-22', to: '2026-12-22' } })).data;
  assert.deepEqual([Number(summary.expense.count), Number(summary.expense.quota)], [1, 2.1], 'solo el gasto con factura, con su IVA');
});

test('0248: un cobro de la caja con su número dice si es ticket o factura; sin decirlo, 422 RECEIPT_KIND_REQUIRED', async () => {
  const sale = (extra: Record<string, unknown> = {}) => ({ source_app: 'flow', source_ref: `flow:receipt:${PROJECT}-57`, kind: 'income', entry_date: '2026-12-22',
    description: 'Barra · justificante 57', amount_cents: 1100, tax_rate: 10, methods: { cash: 1100 }, ...extra });
  await rejected([call('invoices.record_app_entry', sale({ nature: 'fiscal', receipt_number: '57' }))], 'RECEIPT_KIND_REQUIRED');
  const ticket = await record(sale({ nature: 'fiscal', receipt_number: '57', receipt_kind: 'ticket' }));
  assert.deepEqual([ticket.status, ticket.nature, ticket.receipt_kind], ['created', 'fiscal', 'ticket']);
  // Reenviado sin receipt_kind, se queda el que tenía
  assert.equal((await record(sale({ nature: 'fiscal', receipt_number: '57' }))).status, 'unchanged');
  // Sin justificante (como manda Flow hoy un cobro sin número), sigue entrando
  const plain = await record(sale({ source_ref: `flow:receipt:${PROJECT}-58`, nature: 'fiscal' }));
  assert.deepEqual([plain.nature, plain.receipt_kind], ['fiscal', null]);
});

test('0247: un ticket registrado como factura recibida queda fuera del resumen fiscal y de la entrega', async () => {
  const supplier = uuid();
  await ok([{ op: 'insert', table: 'invoices.suppliers', id: supplier, fields: { name: 'Frutería del Mercado' } }]);
  const id = uuid();
  await ok([{ op: 'insert', table: 'invoices.invoices', id, fields: { supplier_id: supplier, invoice_date: '2027-01-05', object: 'Fruta', receipt_kind: 'ticket' } }]);
  const row = (await app.call('/api/v1/snapshot?tables=invoices.invoices')).data.tables[0].rows.find((r: any) => r.id === id);
  assert.equal(row.receipt_kind, 'ticket');
  const fiscal = (await app.t.db.query<{ s: any }>(`select invoices.fiscal_summary_for('2027-01-01', '2027-03-31') s`)).rows[0]!.s;
  assert.equal(Number(fiscal.invoices.pendiente_datos) + Number(fiscal.invoices.pendiente_revision), 0, 'el ticket no cuenta');
  // Pendiente, se corrige a factura y entonces cuenta
  await ok([{ op: 'update', table: 'invoices.invoices', id, expectedRevision: row.revision, fields: { receipt_kind: 'invoice' } }]);
  const after = (await app.t.db.query<{ s: any }>(`select invoices.fiscal_summary_for('2027-01-01', '2027-03-31') s`)).rows[0]!.s;
  assert.equal(Number(after.invoices.pendiente_datos) + Number(after.invoices.pendiente_revision), 1);
});

test('F1 (API.md §17.10): con la clave de worker y X-Ikisai-Caller, source_app tiene que ser la app que llama', async () => {
  const proof = (caller: string, key = WORKER_KEY) => ({ 'X-Ikisai-Worker-Key': key, 'X-Ikisai-Caller': caller });
  const send = (args: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.call('/api/v1/commands', { body: { requestId: `entries-${++counter}`, operations: [call('invoices.record_app_entry', args)] }, headers });
  const day = (d: string) => barDay({ source_ref: `flow:project:${PROJECT}:${d}`, entry_date: d, nature: 'process' });
  // Desde el servidor de Flow, con la persona: entra como siempre
  const ok1 = await send(day('2027-02-01'), proof('flow'));
  assert.equal(ok1.status, 200, JSON.stringify(ok1.data));
  // Quien llama es Booking y dice ser Flow: no
  const forged = await send(day('2027-02-02'), proof('booking'));
  assert.deepEqual([forged.status, forged.data.error.code], [403, 'SOURCE_MISMATCH']);
  // Otra clave u otra app no son prueba
  assert.equal(serverCaller(new Request('http://x', { headers: proof('flow', 'otra') }), WORKER_KEY), null);
  assert.equal(serverCaller(new Request('http://x', { headers: proof('tasks') }), WORKER_KEY), null);
  const noProof = await send(day('2027-02-03'), proof('flow', 'otra'));
  assert.deepEqual([noProof.status, noProof.data.error.code], [403, 'CALLER_REQUIRED'], 'obligatoria para flow y booking');
  // Cuando sea obligatoria: sin prueba, 403 CALLER_REQUIRED; con la suya, sí
  const required = new Set(['flow', 'booking']);
  const ops = [call('invoices.record_app_entry', { source_app: 'flow' })] as never;
  assert.throws(() => checkAppEntrySources(ops, required), (e: any) => e.status === 403 && e.code === 'CALLER_REQUIRED');
  const through = (headers: Record<string, string>) => withServerCaller(async () => { checkAppEntrySources(ops, required); return new Response('ok'); }, WORKER_KEY)(new Request('http://x', { headers }));
  assert.equal(await (await through(proof('flow'))).text(), 'ok');
  await assert.rejects(through(proof('flow', 'otra')), (e: any) => e.code === 'CALLER_REQUIRED');
  await assert.rejects(through(proof('booking')), (e: any) => e.code === 'SOURCE_MISMATCH');
  assert.doesNotThrow(() => checkAppEntrySources([{ op: 'update', table: 'invoices.app_entries', id: 'x', fields: {} }] as never, required), 'lo demás, igual que siempre');
});
