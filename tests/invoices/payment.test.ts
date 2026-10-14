/**
 * Invoices · pago (FB_2026_027 y FB_2026_030, migración 0233, decisión del usuario del 13-10-2026): la fecha de pago nunca es
 * la del clic. El lector lee «pagado», la forma de pago y la fecha; si el documento no dice nada, el servidor la da por
 * pagada «sin confirmar» con la fecha de la factura. Año 2024 para no cruzarse con otras pruebas.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createInvoicesApp, INVOICES_ORIGINS } from '../../supabase/functions/invoices-api/app.ts';
import { detectPayment, readPaymentFields } from '../../packages/domain-invoices/src/index.ts';

test('detectPayment: método y fecha de pago; nada si el documento no lo dice o está pendiente', () => {
  assert.deepEqual(detectPayment(['Factura F-1', 'Forma de pago: Tarjeta', 'Total 121,00 €']), { method: 'tarjeta', paid_at: null });
  assert.deepEqual(detectPayment(['FORMA DE PAGO', 'Transferencia bancaria']), { method: 'transferencia', paid_at: null });
  assert.deepEqual(detectPayment(['Pagado el 03/05/2024 en efectivo']), { method: 'efectivo', paid_at: '2024-05-03' });
  assert.deepEqual(detectPayment(['VISA ************1234', 'Fecha operación: 02/05/2024']), { method: 'tarjeta', paid_at: '2024-05-02' });
  assert.deepEqual(detectPayment(['Recibo domiciliado en su cuenta']), { method: 'domiciliacion', paid_at: null });
  assert.deepEqual(detectPayment(['FACTURA PAGADA']), { method: null, paid_at: null });
  assert.equal(detectPayment(['Factura F-1', 'Base 100,00', 'Total 121,00']), null);
  assert.equal(detectPayment(['Forma de pago: transferencia', 'Pendiente de pago']), null);
  // «tarjeta» suelta, sin hablar del pago, no cuenta
  assert.equal(detectPayment(['Tarjeta regalo de cumpleaños']), null);
});

test('readPaymentFields: fecha leída o la de la factura (nunca hoy) y no pisa lo que dijo una persona', () => {
  assert.deepEqual(readPaymentFields({ method: 'tarjeta', paid_at: null }, '2024-05-01'), { payment_status: 'pagada', payment_method: 'tarjeta', paid_at: '2024-05-01', payment_source: 'leido' });
  assert.equal(readPaymentFields({ method: null, paid_at: '2024-05-03' }, '2024-05-01')?.paid_at, '2024-05-03');
  assert.equal(readPaymentFields({ method: 'tarjeta', paid_at: null }, null), null);
  assert.equal(readPaymentFields(null, '2024-05-01'), null);
  assert.equal(readPaymentFields({ method: 'tarjeta', paid_at: null }, '2024-05-01', { payment_status: 'pendiente', payment_source: 'confirmado' }), null);
  assert.equal(readPaymentFields({ method: 'tarjeta', paid_at: null }, '2024-05-01', { payment_status: 'pagada', payment_source: null }), null);
  assert.ok(readPaymentFields({ method: 'tarjeta', paid_at: null }, '2024-05-01', { payment_status: 'pagada', payment_source: 'sin_confirmar' }));
});

let app: TestApp;
let counter = 0;
let supplier: string;
const uuid = () => crypto.randomUUID();
const insert = (table: string, id: string, fields: Record<string, unknown>) => ({ op: 'insert', table, id, fields });
const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>) => ({ op: 'update', table, id, expectedRevision, fields });
async function ok(operations: unknown[]) {
  const r = await app.call('/api/v1/commands', { body: { requestId: `payment-${++counter}`, operations } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}
async function row(id: string) {
  const snap = await app.call('/api/v1/snapshot?tables=invoices.invoices');
  return (snap.data.tables[0].rows as Array<Record<string, any>>).find((r) => r.id === id)!;
}
const pick = async (id: string, keys: string[]) => { const r = await row(id); return keys.map((k) => r[k]); };

test.before(async () => {
  app = await createTestApp({
    app: 'invoices', slug: 'invoices-api', origin: INVOICES_ORIGINS[0]!,
    createHandler: (config) => createInvoicesApp({ ...config, origins: [INVOICES_ORIGINS[0]!], drive: { api: null } }),
  });
  supplier = uuid();
  await ok([insert('invoices.suppliers', supplier, { name: 'Pagos Ejemplo SL' })]);
});

test('servidor: con fecha y sin nada dicho, «Pagada (sin confirmar)» con la fecha de la factura, que la sigue; lo leído y lo confirmado se respetan', async () => {
  const a = uuid();
  await ok([insert('invoices.invoices', a, { supplier_id: supplier, invoice_date: '2024-04-10', object: 'material' })]);
  assert.deepEqual(await pick(a, ['payment_status', 'paid_at', 'payment_source']), ['pagada', '2024-04-10', 'sin_confirmar']);
  // La fecha de la factura cambia: la de pago la sigue mientras siga sin confirmar
  await ok([update('invoices.invoices', a, (await row(a)).revision, { invoice_date: '2024-04-12' })]);
  assert.equal((await row(a)).paid_at, '2024-04-12');
  // Confirmar es un toque y no cambia la fecha; después ya no la sigue
  await ok([update('invoices.invoices', a, (await row(a)).revision, { payment_source: 'confirmado' })]);
  await ok([update('invoices.invoices', a, (await row(a)).revision, { invoice_date: '2024-04-15' })]);
  assert.deepEqual(await pick(a, ['paid_at', 'payment_source']), ['2024-04-12', 'confirmado']);

  // Sin fecha queda pendiente; al recibir la primera fecha pasa a sin confirmar
  const b = uuid();
  await ok([insert('invoices.invoices', b, { supplier_id: supplier, invoice_date: null, object: 'sin fecha' })]);
  assert.equal((await row(b)).payment_status, 'pendiente');
  await ok([update('invoices.invoices', b, (await row(b)).revision, { invoice_date: '2024-05-02' })]);
  assert.deepEqual(await pick(b, ['payment_status', 'paid_at', 'payment_source']), ['pagada', '2024-05-02', 'sin_confirmar']);

  // Lo leído llega con su método y su fecha y no se toca; «pendiente» dicho por una persona tampoco
  const c = uuid();
  await ok([insert('invoices.invoices', c, { supplier_id: supplier, invoice_date: '2024-05-03', object: 'leída', payment_status: 'pagada', payment_method: 'tarjeta', paid_at: '2024-05-04', payment_source: 'leido' })]);
  assert.deepEqual(await pick(c, ['payment_method', 'paid_at', 'payment_source']), ['tarjeta', '2024-05-04', 'leido']);
  const d = uuid();
  await ok([insert('invoices.invoices', d, { supplier_id: supplier, invoice_date: null, object: 'no pagada' })]);
  await ok([update('invoices.invoices', d, (await row(d)).revision, { payment_source: 'confirmado' })]);
  await ok([update('invoices.invoices', d, (await row(d)).revision, { invoice_date: '2024-05-05' })]);
  assert.equal((await row(d)).payment_status, 'pendiente');
});

test('corrección de 0233: la marcada con la fecha del clic pasa a la de la factura; la marcada con otra fecha se deja', async () => {
  const today = (await app.t.db.query<{ d: string }>(`select ((now() at time zone 'Europe/Madrid')::date)::text d`)).rows[0]!.d;
  const mk = async (paidAt: string) => {
    const id = uuid();
    // Como antes de 0233: creada sin fecha, marcada pagada a mano (sin origen) y con la fecha puesta después
    await ok([insert('invoices.invoices', id, { supplier_id: supplier, invoice_date: null, object: 'antigua' })]);
    await ok([update('invoices.invoices', id, (await row(id)).revision, { payment_status: 'pagada', paid_at: paidAt })]);
    await ok([update('invoices.invoices', id, (await row(id)).revision, { invoice_date: '2024-06-01' })]);
    return id;
  };
  const clicked = await mk(today);
  const chosen = await mk('2024-06-20');
  assert.deepEqual(await pick(clicked, ['paid_at', 'payment_source']), [today, null]);
  const fixed = (await app.t.db.query<{ n: number }>('select invoices.fix_click_paid_dates() n')).rows[0]!.n;
  assert.equal(fixed, 1);
  assert.deepEqual(await pick(clicked, ['paid_at', 'payment_source']), ['2024-06-01', 'confirmado']);
  assert.deepEqual(await pick(chosen, ['paid_at', 'payment_source']), ['2024-06-20', null]);
});
