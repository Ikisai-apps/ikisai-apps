import type { SyncClient } from '@ikisai/sync-client';
import { closeSheet, el, fieldAttrs, openSheet } from '@ikisai/ui-kit';
import { PAYMENT_METHODS } from '@ikisai/domain-invoices';
import { INVOICES, type LocalInvoice } from '../app/client.ts';
import { PAYMENT_METHOD_LABELS, eur } from '../app/data.ts';
import { field, select } from './common.ts';
import { commitWithUndo, pick } from './undo.ts';

const PAY_FIELDS = ['payment_status', 'paid_at', 'payment_method', 'payment_source'];

/**
 * «Marcar pagada» desde la fila de Facturas (tanda 30, MUELA-080): la hoja con la fecha y el medio, como «Cobrada» en
 * Emitidas. La fecha nunca es la del clic (FB_2026_027): propone la de la factura. Al guardar, «Deshacer» vuelve a poner
 * los cuatro campos del pago como estaban.
 */
export function openPaySheet(client: SyncClient, invoice: LocalInvoice, title: string): void {
  const date = el('input', { ...fieldAttrs({ id: 'invoices.facturas.pago.fecha', label: 'Fecha de pago', type: 'date', entity: 'invoices.invoices', prop: 'paid_at', sensitivity: 'internal', confirm: 'none' }), type: 'date', id: 'rowPaidAt', value: invoice.paid_at ?? invoice.invoice_date ?? '', required: true }) as HTMLInputElement;
  const method = select('rowPaidMethod', [['', 'Sin indicar'], ...PAYMENT_METHODS.map((m) => [m, PAYMENT_METHOD_LABELS[m] ?? m] as [string, string])], invoice.payment_method,
    { ...fieldAttrs({ id: 'invoices.facturas.pago.metodo', label: 'Método de pago', type: 'select', entity: 'invoices.invoices', prop: 'payment_method', sensitivity: 'internal', confirm: 'none' }) });
  const error = el('p', { class: 'formerror', role: 'alert' });
  const form = el('form', { class: 'inv-form', id: 'payForm', novalidate: true, onsubmit: (e: Event) => {
    e.preventDefault();
    if (!date.value) { error.textContent = 'Indica la fecha de pago.'; return; }
    void commitWithUndo(client, { table: INVOICES, id: invoice.id, revision: invoice.revision, fields: { payment_status: 'pagada', paid_at: date.value, payment_method: method.value || null, payment_source: 'confirmado' },
      before: pick(invoice as unknown as Record<string, unknown>, PAY_FIELDS) }, `${invoice.code ?? 'Factura'} marcada como pagada.`, 'Vuelve a estar pendiente de pago.')
      .then((ok) => { if (ok) void closeSheet(true); });
  } },
  field('Pagada el', date, 'La fecha en que salió el dinero, no la de hoy si fue otro día.'), field('Método', method), error,
  el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'invoices.facturas.pago.guardar', 'data-feedback-label': 'Guardar pago', class: 'primary', type: 'submit', id: 'savePaid' }, 'Guardar')));
  openSheet({ title: `Pagada · ${title}`, meta: `${invoice.code ?? 'código pendiente'} · ${eur(invoice.calculated_total)}`, body: form,
    panelAttrs: { 'data-feedback-id': 'invoices.facturas.pago.hoja', 'data-feedback-label': 'Marcar pagada' } });
}
