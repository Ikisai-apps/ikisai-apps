import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, openSheet, renderQr, replace, toast } from '@ikisai/ui-kit';
import { CHECKOUT_METHOD_LABELS, formatEuros, ORDER_STATUS_LABELS, PROCEDURES, TABLES, type CheckoutMethod } from '@ikisai/domain-flow';
import { callProcedure, errorCode, flowActions, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { orderTotal, pendingOf, watchData, type FlowData, type Order } from '../app/data.ts';
import { busyButton } from './sheets-common.ts';

/**
 * Caja profunda (0917, v2 con `deep_checkout`):
 * - Ficha del cliente (su número): todos sus pedidos, por cobrar, en cocina, por recoger y entregados. Se eligen varios y
 *   se pagan (en un solo pago o como pedidos independientes) o se entregan a la vez.
 * - «Pagar»: el importe en grande y desglosado; Metálico, Bizum, Tarjeta (deshabilitada por ahora) y Bitcoin (Lightning u
 *   on-chain con QR; sin conversión EUR→BTC: quien paga pone la cantidad).
 * - Tras pagar: Enviar a Finance (apunte fiscal de ese cobro) · Imprimir factura (el justificante de Finance, tras enviarlo) ·
 *   Enviar por correo (aún sin función) · Cerrar.
 */
interface Settings { project_id: string; lightning_address: string | null; bitcoin_address: string | null; deleted_at: string | null }

const stateOf = (data: FlowData, o: Order): string => {
  if (o.status === 'open') return 'Por cobrar';
  if (o.status === 'delivered') return 'Entregado';
  const p = pendingOf(data, o);
  return p.prepPending ? `En cocina ${p.prepTotal - p.prepPending}/${p.prepTotal}` : 'Por recoger';
};

/** Ficha del cliente con su número. */
export function openCustomerSheet(client: SyncClient, projectId: string, number: number): void {
  let data: FlowData | null = null;
  const chosen = new Set<string>();
  const list = el('div', { class: 'checkout-orders', role: 'list' });
  const foot = el('div', { class: 'flow-actions' });
  const sheet = openSheet({ title: `Cliente ${number}`, meta: 'Elige los pedidos para pagar o entregar a la vez.', body: list, foot, onClose: () => off() });

  const mine = (): Order[] => {
    if (!data) return [];
    const customer = [...data.customers.values()].find((c) => c.number === number && c.project_id === projectId);
    return customer ? data.orders.filter((o) => o.customer_id === customer.id) : [];
  };

  function paint(): void {
    if (!data) return;
    const orders = mine().sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || a.created_at.localeCompare(b.created_at));
    for (const id of [...chosen]) if (!orders.some((o) => o.id === id && o.status !== 'delivered')) chosen.delete(id);
    if (!orders.length) { replace(list, el('p', { class: 'muted' }, 'Este cliente aún no tiene pedidos.')); replace(foot); return; }
    replace(list, ...orders.map((o) => {
      const items = (data!.linesByOrder.get(o.id) ?? []).map((l) => `${l.quantity} ${data!.products.get(l.product_id)?.code ?? ''}`).join(' · ');
      const box = el('input', { type: 'checkbox', checked: chosen.has(o.id), disabled: o.status === 'delivered', 'aria-label': `Elegir pedido ${o.pay_seq ?? ''}`,
        onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) chosen.add(o.id); else chosen.delete(o.id); paintFoot(); } });
      return el('label', { class: `qcard checkout-order is-${o.status}`, role: 'listitem' }, box,
        el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, `${o.pay_seq ? `Pedido ${o.pay_seq}` : 'Sin cobrar'} · ${stateOf(data!, o)}`),
          el('small', { class: 'qcard-sub muted' }, `${items || 'sin productos'} · ${formatEuros(orderTotal(data!, o))}`)));
    }));
    paintFoot();
  }

  function paintFoot(): void {
    const sel = mine().filter((o) => chosen.has(o.id));
    const toPay = sel.filter((o) => o.status === 'open');
    const toDeliver = sel.filter((o) => o.status === 'paid');
    replace(foot,
      busyButton({ class: 'secondary', ...(toDeliver.length ? {} : { disabled: 'disabled' }) }, `Entregar (${toDeliver.length})`, () => deliver(toDeliver)),
      busyButton({ class: 'primary', ...(toPay.length ? {} : { disabled: 'disabled' }) }, `Pagar (${toPay.length})`, async () => { openPaySheet(client, projectId, toPay.map((o) => o.id)); }));
  }

  async function deliver(orders: Order[]): Promise<void> {
    if (!isOnline(client)) { toast('Entregar necesita conexión.'); return; }
    const actions = flowActions(client);
    let done = 0;
    for (const o of orders) {
      try {
        if (data?.completeOnDelivery.has(o.project_id)) await actions.deliverAll(o.id, 'number', o.revision);
        else await actions.deliverOrder(o.id, 'number', false, o.revision);
        done += 1;
      } catch (error) {
        toast(errorCode(error) === 'DELIVERY_NEEDS_CONFIRMATION' ? `El pedido ${o.pay_seq} tiene cosas pendientes: entrégalo desde su ficha.` : describeError(error));
      }
    }
    if (done) toast(`${done} ${done === 1 ? 'pedido entregado' : 'pedidos entregados'}.`);
    chosen.clear();
  }

  const off = watchData(client, (d) => { data = d; paint(); if (!d.project) sheet.close(); }, projectId);
}

/** «Pagar» uno o varios pedidos abiertos. */
export function openPaySheet(client: SyncClient, projectId: string, orderIds: string[]): void {
  let data: FlowData | null = null;
  let unify = true;
  let settings: Settings | null = null;
  const body = el('div', { class: 'checkout-pay' });
  const foot = el('div', { class: 'flow-actions checkout-methods' });
  const sheet = openSheet({ title: 'Pagar', body, foot, onClose: () => off() });

  const orders = (): Order[] => (data?.orders ?? []).filter((o) => orderIds.includes(o.id) && o.status === 'open');

  async function loadSettings(): Promise<void> {
    const rows = (await client.list(TABLES.projectSettings)) as unknown as Settings[];
    settings = rows.find((s) => s.project_id === projectId && !s.deleted_at) ?? null;
  }

  function paint(): void {
    if (!data) return;
    const os = orders();
    if (!os.length) { sheet.close(); return; }
    const total = os.reduce((s, o) => s + orderTotal(data!, o), 0);
    replace(body,
      el('p', { class: 'checkout-total' }, formatEuros(total)),
      el('ul', { class: 'checkout-breakdown' }, ...os.map((o) => el('li', null,
        el('strong', null, `${formatEuros(orderTotal(data!, o))}`),
        ' · ', (data!.linesByOrder.get(o.id) ?? []).map((l) => `${l.quantity} × ${data!.products.get(l.product_id)?.name ?? ''}`).join(', ')))),
      ...(os.length > 1 ? [el('label', { class: 'editor-option' },
        el('input', { type: 'checkbox', checked: unify, onchange: (e: Event) => { unify = (e.target as HTMLInputElement).checked; } }),
        el('span', null, 'Un solo pago (si no, cada pedido con su justificante)'))] : []));
    const method = (m: CheckoutMethod, disabled = false) => busyButton({ class: m === 'cash' ? 'primary' : 'secondary', 'data-method': m, ...(disabled ? { disabled: 'disabled', title: 'Aún no disponible' } : {}) },
      CHECKOUT_METHOD_LABELS[m], () => (m === 'btc_ln' || m === 'btc_chain' ? bitcoin(m, total) : pay(m, total)));
    replace(foot, method('cash'), method('bizum'), method('card', true), method('btc_ln', !settings?.lightning_address), method('btc_chain', !settings?.bitcoin_address));
  }

  async function bitcoin(m: CheckoutMethod, total: number): Promise<void> {
    const address = m === 'btc_ln' ? settings?.lightning_address : settings?.bitcoin_address;
    if (!address) { toast('El encargado aún no ha puesto la dirección en el Inicio del flujo.'); return; }
    const payload = m === 'btc_ln' ? `lightning:${address}` : `bitcoin:${address}`;
    let qr: Element;
    try { qr = renderQr(payload, { size: 240, label: CHECKOUT_METHOD_LABELS[m] }); }
    catch { qr = el('code', { class: 'checkout-address' }, payload); } // no cabe en un QR: la dirección en texto
    const ok = await confirmDialog({ title: CHECKOUT_METHOD_LABELS[m], confirmLabel: 'Pagado',
      text: `Que pague ${formatEuros(total)} en su monedero (la cantidad la pone quien paga). Pulsa «Pagado» cuando lo veas recibido.`,
      body: el('div', { class: 'checkout-qr' }, qr, el('small', { class: 'muted' }, address)) });
    if (ok) await pay(m, total, true);
  }

  async function pay(m: CheckoutMethod, total: number, confirmed = false): Promise<void> {
    if (!isOnline(client)) { toast('Cobrar necesita conexión. Usa la comanda de papel si no vuelve.'); return; }
    if (!confirmed && !(await confirmDialog({ title: `Cobrado: ${CHECKOUT_METHOD_LABELS[m].toLowerCase()}`, text: `${formatEuros(total)}.`, confirmLabel: 'Pagado' }))) return;
    const os = orders();
    try {
      const out = await callProcedure<{ orders: Array<{ pay_seq: number }>; receipts: Array<{ receipt_id: string; total_cents: number }> }>(client, PROCEDURES.payOrders, {
        order_ids: os.map((o) => o.id), method: m, unify: os.length > 1 ? unify : true, revisions: Object.fromEntries(os.map((o) => [o.id, o.revision])) });
      sheet.close();
      openPaidSheet(client, out.receipts, out.orders.map((o) => o.pay_seq));
    } catch (error) { toast(describeError(error)); }
  }

  void loadSettings().then(paint);
  const off = watchData(client, (d) => { data = d; paint(); }, projectId);
}

/** Tras pagar: justificantes y sus acciones. */
function openPaidSheet(client: SyncClient, receipts: Array<{ receipt_id: string; total_cents: number }>, seqs: number[]): void {
  const sent = new Set<string>();
  const rows = el('div', { class: 'checkout-receipts' });
  function paint(): void {
    replace(rows, ...receipts.map((r, i) => el('div', { class: 'qcard checkout-receipt' },
      el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, `${receipts.length > 1 ? `Justificante ${i + 1}` : 'Justificante'} · ${formatEuros(r.total_cents)}`)),
      el('div', { class: 'flow-actions' },
        // Justificante imprimible de Finance (#817): solo tras «Enviar a Finance»; antes, apagado.
        el('button', { type: 'button', class: 'ghost', disabled: !sent.has(r.receipt_id), title: sent.has(r.receipt_id) ? '' : 'Primero, «Enviar a Finance»',
          onclick: () => window.open(`https://finance.ikisai.com/#/justificante?ref=${encodeURIComponent(`flow:receipt:${r.receipt_id}`)}`, '_blank', 'noopener') }, 'Imprimir factura'),
        el('button', { type: 'button', class: 'ghost', disabled: true, title: 'Pronto' }, 'Enviar por correo'),
        sent.has(r.receipt_id) ? el('span', { class: 'muted small' }, 'Enviado a Finance')
          : busyButton({ class: 'secondary' }, 'Enviar a Finance', () => sendToFinance(r.receipt_id))))));
  }
  async function sendToFinance(id: string): Promise<void> {
    // El estado del envío lo anota flow-api con la respuesta de Finance.
    try { await client.api(`/receipts/${id}/send/finance`, { method: 'POST', json: {} }); toast('Enviado a Finance como apunte fiscal.'); sent.add(id); void client.sync(); }
    catch (error) { toast(describeError(error)); }
    paint();
  }
  const sheet = openSheet({ title: 'Pagado', meta: `${seqs.length > 1 ? 'Pedidos' : 'Pedido'} ${seqs.join(', ')} · ${ORDER_STATUS_LABELS.paid.toLowerCase()}`,
    body: rows, foot: el('div', { class: 'flow-actions' }, el('button', { type: 'button', class: 'primary', onclick: () => sheet.close() }, 'Cerrar')) });
  paint();
}

/** Owner: direcciones de cobro con Bitcoin del flujo (ajustes del proyecto). */
export async function editBitcoinSettings(client: SyncClient, projectId: string): Promise<void> {
  const rows = (await client.list(TABLES.projectSettings)) as unknown as Array<Settings & { id: string; revision: number }>;
  const current = rows.find((s) => s.project_id === projectId && !s.deleted_at);
  const ln = el('input', { type: 'text', maxlength: '200', placeholder: 'nombre@walletofsatoshi.com', 'aria-label': 'Dirección Lightning', value: current?.lightning_address ?? '' });
  const chain = el('input', { type: 'text', maxlength: '100', placeholder: 'bc1…', 'aria-label': 'Dirección Bitcoin', value: current?.bitcoin_address ?? '' });
  const ok = await confirmDialog({ title: 'Cobro con Bitcoin', text: 'Las direcciones salen como QR en la caja. Vacías, ese método queda desactivado.', confirmLabel: 'Guardar',
    body: el('div', { class: 'editor-head' }, el('label', null, 'Dirección Lightning', ln), el('label', null, 'Dirección Bitcoin', chain)) });
  if (!ok) return;
  const fields = { lightning_address: ln.value.trim() || null, bitcoin_address: chain.value.trim() || null };
  try {
    await client.commit([current
      ? { op: 'update', table: TABLES.projectSettings, id: current.id, expectedRevision: current.revision, fields }
      : { op: 'insert', table: TABLES.projectSettings, id: crypto.randomUUID(), fields: { project_id: projectId, ...fields } }] as any);
    toast('Direcciones guardadas.');
  } catch (error) { toast(describeError(error)); }
}
