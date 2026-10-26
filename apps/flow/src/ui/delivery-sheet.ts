import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, createQuantityField, el, openSheet, replace, toast } from '@ikisai/ui-kit';
import { TABLES, type DeliveryIdent } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { errorCode, errorDetails, flowActions, isOnline } from '../app/actions.ts';
import { customerNumber, pendingOf, watchData, type FlowData, type Order } from '../app/data.ts';
import { askReason, busyButton, productMedal } from './sheets-common.ts';

/**
 * Ficha de entrega (canon V1 §6; FLOW-DIR-001 §2): un único componente que abren Servicio y Caja. Cada línea con su
 * cantidad entregada («1 de 3 aguas») y, si es montadito, cuántos están preparados. El pedido sigue cobrado mientras quede
 * algo; «Menú entregado» se puede pulsar siempre, se destaca cuando todo está, y con algo pendiente pide confirmación
 * consciente, que queda registrada. Preparado no es entregado.
 */
const IDENTS: Array<[DeliveryIdent, string]> = [['number', 'Por número'], ['presence', 'Lo reconozco'], ['qr', 'QR'], ['skipped', 'Sin identificar']];

export function openDeliverySheet(client: SyncClient, orderId: string, options: { onClose?: () => void } = {}): void {
  const actions = flowActions(client);
  const canEdit = client.bootstrap()?.membership.role !== 'reader';
  let data: FlowData | null = null;
  let ident: DeliveryIdent = 'number';
  const fields = new Map<string, { set(q: number): void; node: HTMLElement }>();
  const progress = new Map<string, HTMLElement>();

  const summary = el('p', { class: 'delivery-summary', role: 'status' });
  const linesEl = el('div', { class: 'delivery-lines' });
  const identEl = el('fieldset', { class: 'delivery-ident' }, el('legend', null, 'Identificación del cliente'),
    ...IDENTS.map(([value, label]) => el('label', { class: 'chip-radio' },
      el('input', { type: 'radio', name: 'ident', value, checked: value === ident, onchange: () => { ident = value; } }), el('span', null, label))));
  const deliverButton = busyButton({ class: 'primary' }, 'Menú entregado', deliver);
  const reopenButton = busyButton({ class: 'ghost' }, 'Reabrir entrega', reopen);
  const foot = el('div', { class: 'flow-actions' }, reopenButton, deliverButton);
  const sheet = openSheet({
    title: 'Entrega',
    body: el('div', { class: 'delivery' }, summary, linesEl, identEl),
    foot,
    onClose: () => { offData(); options.onClose?.(); },
  });

  const order = (): Order | undefined => data?.orders.find((o) => o.id === orderId);

  function lineRow(lineId: string): HTMLElement {
    const line = data!.linesByOrder.get(orderId)!.find((l) => l.id === lineId)!;
    const product = data!.products.get(line.product_id)!;
    const field = createQuantityField({
      label: `Entregado de ${product.name}`, name: `d-${line.id}`, value: line.delivered_qty, decimals: 0, min: 0, max: line.quantity, step: 1, disabled: !canEdit,
      onChange: (v) => void setDelivered(line.id, v.value ?? 0),
    });
    const prog = el('small', { class: 'muted' });
    progress.set(line.id, prog);
    fields.set(line.id, { set: (q) => field.set({ value: q, unit: field.get().unit }), node: field.element });
    return el('div', { class: 'delivery-line', 'data-line': line.id },
      productMedal(product),
      el('div', { class: 'delivery-line-text' }, el('strong', null, product.name), prog),
      el('div', { class: 'delivery-line-qty' }, field.element));
  }

  async function setDelivered(lineId: string, qty: number): Promise<void> {
    const line = data?.linesByOrder.get(orderId)?.find((l) => l.id === lineId);
    if (!line || line.delivered_qty === qty) return;
    const q = Math.max(0, Math.min(line.quantity, Math.round(qty)));
    try {
      await client.commit([{ op: 'update', table: TABLES.orderLines, id: lineId, expectedRevision: line.revision, fields: { delivered_qty: q } }]);
    } catch (error) { toast(describeError(error)); }
  }

  function paint(): void {
    const o = order();
    if (!o || !data) { sheet.close(); return; }
    const lines = data.linesByOrder.get(orderId) ?? [];
    const units = data.unitsByOrder.get(orderId) ?? [];
    const p = pendingOf(data, o);
    const number = customerNumber(data, o);
    replace(summary, `Pedido ${o.pay_seq ?? '—'}${number ? ` · cliente ${number}` : ''} · ` +
      (o.status === 'delivered' ? 'entregado' : p.prepPending ? `${p.prepTotal - p.prepPending} de ${p.prepTotal} montaditos preparados` : 'todo preparado') +
      (o.status !== 'delivered' ? ` · faltan ${p.undelivered} por entregar` : ''));
    // Filas estables: solo se crean una vez; luego se actualizan cantidades y progreso.
    const known = new Set(Array.from(linesEl.children).map((n) => (n as HTMLElement).dataset.line));
    for (const line of lines) if (!known.has(line.id)) linesEl.append(lineRow(line.id));
    for (const line of lines) {
      const product = data.products.get(line.product_id);
      const done = units.filter((u) => u.line_id === line.id && u.status === 'done').length;
      const live = units.filter((u) => u.line_id === line.id && u.status !== 'cancelled').length;
      const text = `${line.delivered_qty} de ${line.quantity} entregados${product?.prepared ? ` · ${done} de ${live} preparados` : ''}${line._pending ? ' · pendiente de confirmar' : ''}`;
      progress.get(line.id)!.textContent = text;
      const f = fields.get(line.id);
      if (f && !f.node.contains(document.activeElement)) f.set(line.delivered_qty);
    }
    const complete = p.prepPending === 0 && p.undelivered === 0;
    reopenButton.hidden = o.status !== 'delivered';
    deliverButton.hidden = o.status === 'delivered';
    // Siempre pulsable; destacado solo cuando todo está preparado y entregado (§6.3).
    deliverButton.className = complete ? 'primary' : 'secondary deliver-incomplete';
    if (!canEdit) { reopenButton.disabled = true; deliverButton.disabled = true; }
  }

  async function deliver(): Promise<void> {
    const o = order();
    if (!o) return;
    if (!isOnline(client)) { toast('Entregar necesita conexión. Usa la comanda de papel si no vuelve.'); return; }
    try {
      await actions.deliverOrder(o.id, ident, false, o.revision);
      toast('Pedido entregado.');
      sheet.close();
    } catch (error) {
      if (errorCode(error) !== 'DELIVERY_NEEDS_CONFIRMATION') { toast(describeError(error)); return; }
      const d = errorDetails(error);
      const parts = [d.pendingUnits ? `${d.pendingUnits} ${d.pendingUnits === 1 ? 'montadito sin terminar' : 'montaditos sin terminar'}` : '',
        d.undeliveredItems ? `${d.undeliveredItems} ${d.undeliveredItems === 1 ? 'producto sin marcar como entregado' : 'productos sin marcar como entregados'}` : ''].filter(Boolean);
      const ok = await confirmDialog({ title: '¿Entregar con cosas pendientes?', text: `Falta: ${parts.join(' y ')}. Quedará registrado como entrega con excepción.`, confirmLabel: 'Entregar igualmente' });
      if (!ok) return;
      const fresh = order();
      try { await actions.deliverOrder(o.id, ident, true, fresh?.revision ?? o.revision); toast('Pedido entregado con excepción registrada.'); sheet.close(); }
      catch (again) { toast(describeError(again)); }
    }
  }

  async function reopen(): Promise<void> {
    const o = order();
    if (!o) return;
    const reason = await askReason('Reabrir la entrega', 'El pedido vuelve a «por entregar». No cambia nada del cobro.', 'Reabrir');
    if (!reason) return;
    try { await actions.reopenOrder(o.id, reason, o.revision); toast('Entrega reabierta.'); } catch (error) { toast(describeError(error)); }
  }

  const offData = watchData(client, (d) => { data = d; paint(); });
}
