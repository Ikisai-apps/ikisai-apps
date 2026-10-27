/**
 * Pasarela compartida (finance-18, `_domain/payments`): el cliente de Stripe Checkout (con un fetch simulado, sin red),
 * la firma del webhook, la normalización de avisos y el Stripe falso que usan las pruebas de Finance y Booking.
 * Datos sintéticos; ninguna clave real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createStripeGateway, defaultExpiry, normalizeStripeEvent, signStripePayload, verifyStripeSignature, PaymentGatewayError, type CheckoutRequest } from '../../supabase/functions/_domain/payments/stripe.ts';
import { createFakeStripe } from '../../supabase/functions/_domain/payments/fake.ts';

const NOW = Date.parse('2026-11-02T10:00:00Z');
const SECRET = 'whsec_prueba_sintetica';
const request = (f: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  amountCents: 44000, currency: 'eur', description: 'Factura PA-2026-0101 · Retiro de otoño', metadata: { issued_invoice_id: 'e1', reservation_id: 'r1' },
  expiresAt: defaultExpiry(NOW), successUrl: 'https://organizers.example.invalid/pagado', cancelUrl: 'https://organizers.example.invalid/', idempotencyKey: 'pl:e1:44000', ...f,
});

test('cliente real: Checkout con importe exacto, caducidad, metadatos e idempotencia; errores de la pasarela claros', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/checkout/sessions')) return Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1', expires_at: Math.floor(NOW / 1000) + 86000, status: 'open', payment_status: 'unpaid', amount_total: 44000, currency: 'eur', metadata: { issued_invoice_id: 'e1' } });
    if (url.endsWith('/refunds')) return Response.json({ id: 're_1', status: 'succeeded' });
    return Response.json({ error: { message: 'No such checkout session', code: 'resource_missing' } }, { status: 404 });
  }) as unknown as typeof fetch;
  const stripe = createStripeGateway({ secretKey: 'sk_test_sintetica', fetch: fakeFetch, now: () => NOW });
  const s = await stripe.createCheckout(request());
  assert.deepEqual([s.id, s.status, s.amountCents, s.paymentIntent], ['cs_1', 'open', 44000, null]);
  const sent = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(sent.get('line_items[0][price_data][unit_amount]'), '44000');
  assert.equal(sent.get('mode'), 'payment');
  assert.equal(sent.get('metadata[issued_invoice_id]'), 'e1');
  assert.equal((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key'], 'pl:e1:44000');
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, 'Bearer sk_test_sintetica');
  // Devolución parcial (la mitad de las noches) y total, con su clave
  assert.deepEqual(await stripe.refund('pi_1', 22000, 'rf:1'), { refundId: 're_1', status: 'succeeded' });
  assert.equal(new URLSearchParams(String(calls[1]!.init.body)).get('amount'), '22000');
  await assert.rejects(stripe.getCheckout('cs_x'), (e: any) => e instanceof PaymentGatewayError && e.code === 'resource_missing' && e.status === 404);
  // Lo que no se manda: importe no entero, caducidad de menos de 30 min (la retención la pone cada app) o URL sin https
  await assert.rejects(stripe.createCheckout(request({ amountCents: 10.5 })), /Importe/);
  await assert.rejects(stripe.createCheckout(request({ expiresAt: new Date(NOW + 20 * 60_000) })), (e: any) => e.code === 'INVALID_EXPIRY');
  await assert.rejects(stripe.createCheckout(request({ successUrl: 'http://x' })), (e: any) => e.code === 'INVALID_URL');
  assert.equal(calls.length, 3, 'nada inválido llega a la pasarela');
});

test('firma del webhook: buena, mala, fuera de tiempo o sin cabecera', async () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1', object: 'checkout.session', payment_status: 'paid', amount_total: 44000, currency: 'eur', metadata: { issued_invoice_id: 'e1' }, payment_intent: 'pi_1' } } });
  const header = await signStripePayload(body, SECRET, NOW);
  const event = await verifyStripeSignature(body, header, SECRET, { now: NOW + 60_000 });
  assert.equal(event.id, 'evt_1');
  await assert.rejects(verifyStripeSignature(body, header, 'otro_secreto', { now: NOW }), (e: any) => e.code === 'SIGNATURE_INVALID');
  await assert.rejects(verifyStripeSignature(body.replace('44000', '1'), header, SECRET, { now: NOW }), (e: any) => e.code === 'SIGNATURE_INVALID');
  await assert.rejects(verifyStripeSignature(body, header, SECRET, { now: NOW + 600_000 }), (e: any) => e.code === 'SIGNATURE_EXPIRED');
  await assert.rejects(verifyStripeSignature(body, null, SECRET, { now: NOW }), (e: any) => e.code === 'SIGNATURE_MISSING');
  assert.deepEqual(normalizeStripeEvent(event), { eventId: 'evt_1', kind: 'paid', sessionId: 'cs_1', paymentIntent: 'pi_1', amountCents: 44000, refundedCents: null, currency: 'eur', metadata: { issued_invoice_id: 'e1' } });
  assert.equal(normalizeStripeEvent({ id: 'e', type: 'customer.created', data: { object: {} } }).kind, 'ignored');
});

test('Stripe falso: idempotente, se paga, caduca, devuelve en parte y en total, y firma su webhook', async () => {
  let now = NOW;
  const fake = createFakeStripe({ now: () => now });
  const a = await fake.createCheckout(request());
  assert.equal((await fake.createCheckout(request())).id, a.id, 'misma clave, misma sesión');
  assert.equal(fake.requests.length, 1);
  fake.pay(a.id);
  const paid = await fake.webhook(a.id, 'checkout.session.completed', SECRET);
  const ev = normalizeStripeEvent(await verifyStripeSignature(paid.body, paid.signature, SECRET, { now }));
  assert.deepEqual([ev.kind, ev.sessionId, ev.amountCents, ev.metadata.issued_invoice_id], ['paid', a.id, 44000, 'e1']);
  const pi = (await fake.getCheckout(a.id)).paymentIntent!;
  await fake.refund(pi, 22000, 'rf:mitad');
  assert.deepEqual(await fake.refund(pi, 22000, 'rf:mitad'), await fake.refund(pi, 22000, 'rf:mitad'), 'misma clave, misma devolución');
  await fake.refund(pi, 22000, 'rf:resto');
  await assert.rejects(fake.refund(pi, 1, 'rf:demasiado'), (e: any) => e.code === 'INVALID_AMOUNT');
  const refund = normalizeStripeEvent(JSON.parse((await fake.webhook(a.id, 'charge.refunded', SECRET)).body));
  assert.deepEqual([refund.kind, refund.paymentIntent, refund.refundedCents], ['refunded', pi, 44000]);
  // Caduca sola al pasar la hora
  const b = await fake.createCheckout(request({ idempotencyKey: 'pl:e2:1000', amountCents: 1000 }));
  now += 25 * 3600_000;
  assert.equal((await fake.getCheckout(b.id)).status, 'expired');
  fake.failNext();
  await assert.rejects(fake.getCheckout(b.id), (e: any) => e.code === 'GATEWAY_UNAVAILABLE');
});
