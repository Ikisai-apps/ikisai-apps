/**
 * Facturar desde una reserva (API.md §14.8; Booking: docs/booking/API.md §19). Finance lee
 * `booking.reservation_invoice_source` y prepara el BORRADOR; Booking no escribe en Finance.
 *
 * Booking da los precios con IVA incluido por defecto. Una línea con IVA incluido se guarda con su base y su cuota
 * explícitas (`vat_amount`), de modo que base + cuota es exactamente el importe de Booking.
 */
import type { IncomeCategory } from './issued.ts';

export interface ReservationInvoiceSource {
  reservation: { id: string; code: string | null; label: string; revision: number; check_in: string | null; check_out: string | null };
  customer: { name: string | null; kind: string | null; tax_id: string | null; id_type: string | null; country: string | null;
    address: { line?: string | null; postal_code?: string | null; city?: string | null; province?: string | null; country?: string | null } | null };
  prices_include_vat: boolean;
  proposal: { id: string; version: number; total: number } | null;
  final_amount: number | null;
  lines: Array<{ kind: 'tarifa' | 'extra' | 'ajuste'; description: string; quantity: number | null; unit: string | null; unit_price: number;
    discount_amount: number | null; vat_rate: number | null; income_category: string | null }>;
  invoiced: unknown;
}

/** Línea tal como la escribe el usuario (o la trae Booking): precio y descuento con o sin IVA según `includeVat`. */
export interface PricedLine { description: string; quantity: number | null; unit_price: number; discount_amount?: number | null; vat_rate: number | null }

export interface DraftLineValues {
  description: string;
  quantity: number;
  /** Sin IVA (hasta 4 decimales). */
  unit_price: number;
  discount_amount: number;
  net_amount: number;
  vat_rate: number | null;
  /** Solo con IVA incluido: la cuota exacta que hace base + cuota = importe con IVA. */
  vat_amount: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function draftLineFromPrice(line: PricedLine, includeVat: boolean): DraftLineValues {
  const quantity = line.quantity ?? 1;
  const discount = line.discount_amount ?? 0;
  const amount = r2(quantity * line.unit_price - discount);
  if (!includeVat || !line.vat_rate) {
    return { description: line.description, quantity, unit_price: line.unit_price, discount_amount: discount, net_amount: amount, vat_rate: line.vat_rate, vat_amount: includeVat ? 0 : null };
  }
  const factor = 1 + line.vat_rate / 100;
  const net = r2(amount / factor);
  return { description: line.description, quantity, unit_price: r4(line.unit_price / factor), discount_amount: r2(discount / factor), net_amount: net, vat_rate: line.vat_rate, vat_amount: r2(amount - net) };
}

/** Precio para mostrar en el editor a partir de lo guardado (inverso de draftLineFromPrice). */
export function displayPrice(value: number | null, vatRate: number | null, includeVat: boolean): number | null {
  if (value === null) return null;
  return includeVat && vatRate ? r2(value * (1 + vatRate / 100)) : value;
}

/** Categorías de Booking a las de Finance (extras y servicios no tienen equivalente: «otros»). */
export const BOOKING_INCOME_CATEGORY: Record<string, IncomeCategory> = { alojamiento: 'alojamiento', restauracion: 'restauracion', extras: 'otros', servicios: 'otros' };

/** Tipo de cliente de Booking al de la factura: un particular, o una entidad que necesita NIF y domicilio. */
export function recipientKindFromBooking(kind: string | null): 'empresa' | 'particular' {
  return kind === 'particular' ? 'particular' : 'empresa';
}

export interface DraftPrefill {
  source: { reservationId: string; code: string | null; label: string; revision: number };
  recipient_name: string | null;
  recipient_kind: 'empresa' | 'profesional' | 'particular';
  recipient_tax_id: string | null;
  recipient_address: ReservationInvoiceSource['customer']['address'];
  description: string;
  operation_date: string | null;
  income_category: IncomeCategory | null;
  prices_include_vat: boolean;
  lines: PricedLine[];
}

export function reservationPrefill(src: ReservationInvoiceSource): DraftPrefill {
  const byCategory = new Map<IncomeCategory, number>();
  for (const l of src.lines) {
    const c = BOOKING_INCOME_CATEGORY[l.income_category ?? ''] ?? 'otros';
    byCategory.set(c, (byCategory.get(c) ?? 0) + Math.abs((l.quantity ?? 1) * l.unit_price));
  }
  const category = [...byCategory.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    source: { reservationId: src.reservation.id, code: src.reservation.code, label: src.reservation.label, revision: src.reservation.revision },
    recipient_name: src.customer.name,
    recipient_kind: recipientKindFromBooking(src.customer.kind),
    recipient_tax_id: src.customer.tax_id,
    recipient_address: src.customer.address,
    description: [src.reservation.code, src.reservation.label].filter(Boolean).join(' · ').slice(0, 500),
    operation_date: src.reservation.check_out ?? src.reservation.check_in,
    income_category: category,
    prices_include_vat: src.prices_include_vat,
    lines: src.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, discount_amount: l.discount_amount, vat_rate: l.vat_rate })),
  };
}
