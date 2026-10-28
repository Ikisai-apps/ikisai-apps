/**
 * Redsys (tarjeta y Bizum), segundo adaptador de la pasarela compartida: 3DES en TS puro (vector clásico y contra
 * node:crypto), formulario firmado, pedido estable, avisos firmados (autorizado, denegado, manipulado) y devoluciones
 * con el Redsys falso. Clave sintética; ningún dato de tarjeta.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { desEncryptBlock, tripleDesCbcZeroIv } from '../../supabase/functions/_domain/payments/des.ts';
import { decodeRedsysParameters, normalizeRedsysNotification, redsysGoPage, redsysSignature, verifyRedsysNotification } from '../../supabase/functions/_domain/payments/redsys.ts';
import { createFakeRedsys } from '../../supabase/functions/_domain/payments/fake-redsys.ts';
import { PaymentGatewayError, type CheckoutRequest } from '../../supabase/functions/_domain/payments/stripe.ts';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase();
const NOW = Date.parse('2026-10-28T10:00:00Z');
const request = (o: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  amountCents: 4400, currency: 'eur', description: 'Factura F2026-0007 · Saldo del retiro', metadata: { app: 'invoices', issued_invoice_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
  expiresAt: new Date(NOW + 23 * 3600_000), successUrl: 'https://finance.ikisai.com/#/facturas?pagada=1', cancelUrl: 'https://finance.ikisai.com/#/facturas',
  idempotencyKey: 'invoices:pl:a1b2:4400:0', ...o,
});

test('DES: vector clásico; 3DES-CBC con IV a cero igual que node:crypto', () => {
  assert.equal(hex(desEncryptBlock(Buffer.from('133457799BBCDFF1', 'hex'), Buffer.from('0123456789ABCDEF', 'hex'))), '85E813540F0AB405');
  for (let i = 0; i < 6; i++) {
    const key = randomBytes(24); const data = randomBytes(8 * (1 + i));
    const c = createCipheriv('des-ede3-cbc', key, Buffer.alloc(8)); c.setAutoPadding(false);
    assert.equal(hex(tripleDesCbcZeroIv(key, data)), hex(Buffer.concat([c.update(data), c.final()])));
  }
});

test('formulario firmado: importe, pedido estable, euros, Bizum; la firma se comprueba con la clave del pedido', async () => {
  const redsys = createFakeRedsys({ now: () => NOW, methods: 'bizum' });
  assert.equal(redsys.provider, 'redsys'); assert.equal(redsys.queryable, false);
  const s = await redsys.createCheckout(request());
  assert.match(s.id, /^\d{4}[0-9a-z]{8}$/);
  assert.equal(s.url, `https://finance.ikisai.com/api/v1/public/payments/redsys/go/${s.id}`);
  assert.equal(s.form!.action, 'https://sis-t.redsys.es:25443/sis/realizarPago');
  const p = decodeRedsysParameters(s.form!.fields.Ds_MerchantParameters!);
  assert.deepEqual([p.DS_MERCHANT_AMOUNT, p.DS_MERCHANT_ORDER, p.DS_MERCHANT_CURRENCY, p.DS_MERCHANT_TRANSACTIONTYPE, p.DS_MERCHANT_PAYMETHODS], ['4400', s.id, '978', '0', 'z']);
  assert.deepEqual(JSON.parse(p.DS_MERCHANT_MERCHANTDATA!), request().metadata);
  assert.equal(s.form!.fields.Ds_Signature, await redsysSignature(redsys.secretKey, s.id, s.form!.fields.Ds_MerchantParameters!));
  // Misma clave de idempotencia: mismo pedido; otra: otro
  assert.equal((await redsys.createCheckout(request())).id, s.id);
  assert.notEqual((await redsys.createCheckout(request({ idempotencyKey: 'invoices:pl:a1b2:4400:1' }))).id, s.id);
  await assert.rejects(redsys.createCheckout(request({ currency: 'usd' })), (e: unknown) => e instanceof PaymentGatewayError && e.code === 'INVALID_CURRENCY');
  await assert.rejects(redsys.getCheckout(s.id), (e: unknown) => e instanceof PaymentGatewayError && e.code === 'NOT_SUPPORTED');
  // Página de paso: manda el formulario, con los valores escapados
  const html = redsysGoPage(s.form!);
  assert.match(html, /action="https:\/\/sis-t\.redsys\.es:25443\/sis\/realizarPago"/);
  assert.ok(html.includes(`value="${s.form!.fields.Ds_Signature}"`));
  assert.ok(!redsysGoPage({ action: 'https://x', fields: { a: '"><script>' } }).includes('"><script>'));
});

test('avisos: autorizado → paid con los metadatos; denegado → failed; manipulado o con otra clave → rechazado', async () => {
  const redsys = createFakeRedsys({ now: () => NOW });
  const s = await redsys.createCheckout(request());
  const okFields = await redsys.notification(s.id, 'ok', { bizum: true });
  const n = await verifyRedsysNotification(okFields, redsys.secretKey);
  const e = normalizeRedsysNotification(n);
  assert.deepEqual([e.kind, e.sessionId, e.amountCents, e.currency, e.metadata.app, e.metadata.issued_invoice_id], ['paid', s.id, 4400, 'eur', 'invoices', request().metadata.issued_invoice_id]);
  // El mismo aviso repetido tiene el mismo id (la app lo aplica una vez)
  assert.equal(normalizeRedsysNotification(await verifyRedsysNotification(okFields, redsys.secretKey)).eventId, e.eventId);
  const s2 = await redsys.createCheckout(request({ idempotencyKey: 'otro' }));
  const denied = normalizeRedsysNotification(await verifyRedsysNotification(await redsys.notification(s2.id, 'denied'), redsys.secretKey));
  assert.equal(denied.kind, 'failed');
  // Manipulado: otro importe con la firma de antes
  const params = decodeRedsysParameters(okFields.Ds_MerchantParameters!);
  const tampered = { ...okFields, Ds_MerchantParameters: Buffer.from(JSON.stringify({ ...params, Ds_Amount: '1' })).toString('base64') };
  await assert.rejects(verifyRedsysNotification(tampered, redsys.secretKey), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'SIGNATURE_INVALID');
  await assert.rejects(verifyRedsysNotification(okFields, Buffer.alloc(24, 7).toString('base64')), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'SIGNATURE_INVALID');
  await assert.rejects(verifyRedsysNotification({ Ds_MerchantParameters: okFields.Ds_MerchantParameters }, redsys.secretKey), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'SIGNATURE_MISSING');
});

test('devoluciones por REST: parcial y total aceptadas (0900); de más o sin pagar, rechazadas', async () => {
  const redsys = createFakeRedsys({ now: () => NOW });
  const s = await redsys.createCheckout(request());
  await assert.rejects(redsys.refund(s.id, 100, 'k0'), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'DS_0950', 'sin pagar no se devuelve');
  await redsys.notification(s.id, 'ok');
  assert.equal((await redsys.refund(s.id, 1000, 'k1')).status, 'succeeded');
  assert.equal((await redsys.refund(s.id, 3400, 'k2')).status, 'succeeded');
  assert.equal(redsys.refunded.get(s.id), 4400);
  await assert.rejects(redsys.refund(s.id, 1, 'k3'), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'DS_0950');
  await assert.rejects(redsys.refund(s.id, 0, 'k4'), (x: unknown) => x instanceof PaymentGatewayError && x.code === 'INVALID_AMOUNT');
});
