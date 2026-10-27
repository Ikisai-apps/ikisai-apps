/**
 * «Justificante del día» de un ingreso de otra app (encargo de VG del 27-10; API.md §17.5): la hoja imprimible de un
 * apunte de ventas, con la fecha, los totales por medio de cobro, el desglose (por producto o, en una liquidación de
 * cuenta de cliente, por pedido) y el IVA incluido. Sin DOM: se prueba con node (tests/invoices/day-receipt.test.ts).
 *
 * Es un TICKET (decisión de VG del 27-10): sin serie ni numeración de factura. El IVA va incluido, como en cualquier
 * ticket; no se trata como el de una factura.
 *
 * Justificante imprimible de cada cobro (encargo de VG por Core, 27-10; API.md §17.9): el mismo documento sirve para un
 * cobro suelto que la caja de Flow manda a Finance. El título sale de `receipt_kind`: «Ticket de venta» o, con
 * `invoice`, «Factura simplificada». `receipt_number` es el número de cobro que pone la app (no es una serie de Finance).
 */

export interface ReceiptEntry {
  source_app: string;
  source_ref: string;
  kind: 'income' | 'expense';
  /** 0245: el justificante es solo de lo fiscal. Sin valor, fiscal. */
  nature?: 'fiscal' | 'process';
  entry_date: string;
  description: string;
  amount_cents: number;
  net_cents: number;
  tax_cents: number;
  tax_rate: number;
  pending_refunds_cents: number;
  methods: Record<string, number>;
  detail: Array<{ code?: string | null; name: string; quantity: number; amount_cents: number }>;
  /** 0245/0247: número de cobro (de la app) y factura o ticket. */
  receipt_number?: string | null;
  receipt_kind?: 'invoice' | 'ticket' | null;
}

export interface DayReceipt {
  /** «Ticket de ventas» (cierre del día), «Ticket de venta» (un cobro) o «Factura simplificada». */
  title: string;
  /** Número de cobro de la app, si lo trae. */
  number: string | null;
  kind: 'ticket' | 'invoice';
  date: string;
  description: string;
  lines: Array<{ label: string; quantity: number; cents: number }>;
  methods: Array<{ label: string; cents: number }>;
  rate: number;
  netCents: number;
  taxCents: number;
  totalCents: number;
  pendingRefundsCents: number;
  /** Aviso del pie: qué es y qué no es este documento. */
  notice: string;
}

const METHOD_LABELS: Record<string, string> = { cash: 'Metálico', bizum: 'Bizum', card: 'Tarjeta', bitcoin: 'Bitcoin', transfer: 'Transferencia' };
export const methodLabel = (k: string): string => METHOD_LABELS[k] ?? k;

/** El justificante de un ingreso: ticket o factura simplificada, con su número de cobro si lo trae. */
export function dayReceipt(entry: ReceiptEntry): DayReceipt {
  if (entry.kind !== 'income') throw new Error('Solo los ingresos tienen justificante de ventas.');
  if ((entry.nature ?? 'fiscal') !== 'fiscal') throw new Error('Un apunte de proceso no tiene justificante: no va a la gestoría.');
  const kind = entry.receipt_kind === 'invoice' ? 'invoice' : 'ticket';
  const number = entry.receipt_number?.trim() || null;
  return {
    title: kind === 'invoice' ? 'Factura simplificada' : number ? 'Ticket de venta' : 'Ticket de ventas',
    number,
    kind,
    date: entry.entry_date,
    description: entry.description,
    lines: (entry.detail ?? []).map((d) => ({ label: d.code ? `${d.code} · ${d.name}` : d.name, quantity: Number(d.quantity), cents: Number(d.amount_cents) })),
    methods: Object.entries(entry.methods ?? {}).map(([k, v]) => ({ label: methodLabel(k), cents: Number(v) })),
    rate: Number(entry.tax_rate),
    netCents: Number(entry.net_cents),
    taxCents: Number(entry.tax_cents),
    totalCents: Number(entry.amount_cents),
    pendingRefundsCents: Number(entry.pending_refunds_cents ?? 0),
    notice: kind === 'invoice'
      ? `Factura simplificada${number ? ` nº ${number}` : ''}. IVA incluido.`
      : `Ticket${number ? ` nº ${number}` : ' de las ventas'}: no es una factura y no lleva serie ni numeración de factura. IVA incluido.`,
  };
}
