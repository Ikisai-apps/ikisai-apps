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

let app: TestApp;
let counter = 0;
const PROJECT = '7d1c1a52-3f0e-4c55-9b7a-0c6a3e7f2b10';
const REF = `flow:project:${PROJECT}:2026-10-31`;
const call = (procedure: string, args: Record<string, unknown>) => ({ op: 'call', procedure, args });
const update = (id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table: 'invoices.app_entries', id, expectedRevision, fields });

function commit(operations: unknown[], token?: string) {
  return app.call('/api/v1/commands', { body: { requestId: `entries-${++counter}`, operations }, ...(token ? { token } : {}) });
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
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
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
  const text = await csv.text();
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
