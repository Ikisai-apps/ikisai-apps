/** Facturar desde una reserva (API.md §14.8): precios con IVA incluido a base y cuota exactas, y el borrador relleno. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { displayPrice, draftLineFromPrice, recipientKindFromBooking, reservationPrefill, type ReservationInvoiceSource } from '../../packages/domain-invoices/src/index.ts';

test('precio con IVA incluido: base y cuota exactas que suman el importe de Booking', () => {
  const a = draftLineFromPrice({ description: 'Alojamiento', quantity: 20, unit_price: 55, discount_amount: 0, vat_rate: 10 }, true);
  assert.deepEqual([a.net_amount, a.vat_amount, a.unit_price], [1000, 100, 50]);
  const b = draftLineFromPrice({ description: 'Masaje', quantity: 3, unit_price: 33.33, discount_amount: 5, vat_rate: 21 }, true);
  assert.equal(Math.round((b.net_amount + b.vat_amount!) * 100), Math.round((3 * 33.33 - 5) * 100));
  assert.equal(b.net_amount, 78.5); assert.equal(b.vat_amount, 16.49);
  // Sin IVA incluido: el precio es la base y la cuota la calcula el servidor
  const c = draftLineFromPrice({ description: 'x', quantity: 2, unit_price: 50, discount_amount: 10, vat_rate: 10 }, false);
  assert.deepEqual([c.net_amount, c.vat_amount, c.unit_price, c.discount_amount], [90, null, 50, 10]);
  // Volver al precio que vio el usuario
  assert.equal(displayPrice(a.unit_price, 10, true), 55);
  assert.equal(displayPrice(50, 10, false), 50);
});

test('borrador desde la reserva: cliente sin datos fiscales, categoría dominante, fecha de salida', () => {
  const src: ReservationInvoiceSource = {
    reservation: { id: '33333333-3333-4333-8333-333333333333', code: 'R-2026-014', label: 'Retiro Primavera', revision: 4, check_in: '2026-11-06', check_out: '2026-11-08' },
    customer: { name: 'Asociación Yoga Norte', kind: 'asociacion', tax_id: null, id_type: null, country: null, address: null },
    prices_include_vat: true, proposal: { id: 'p', version: 2, total: 1221 }, final_amount: null, invoiced: null,
    lines: [
      { kind: 'tarifa', description: 'Alojamiento', quantity: 20, unit: 'persona_noche', unit_price: 55, discount_amount: 0, vat_rate: 10, income_category: 'alojamiento' },
      { kind: 'extra', description: 'Masaje', quantity: 2, unit: 'unidad', unit_price: 60.5, discount_amount: 0, vat_rate: 21, income_category: 'extras' },
    ],
  };
  const p = reservationPrefill(src);
  assert.equal(p.recipient_kind, 'empresa'); assert.equal(p.recipient_tax_id, null);
  assert.equal(p.income_category, 'alojamiento'); assert.equal(p.operation_date, '2026-11-08');
  assert.equal(p.description, 'R-2026-014 · Retiro Primavera'); assert.equal(p.prices_include_vat, true); assert.equal(p.lines.length, 2);
  assert.equal(recipientKindFromBooking('particular'), 'particular');
});
