import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, createQuantityField, el, fieldAttrs, openSheet, replace, toast } from '@ikisai/ui-kit';
import { formatEuros, groupMenu, ORDER_STATUS_LABELS, PAY_METHOD_LABELS, SETTLE_METHOD_LABELS, CHECKOUT_METHOD_LABELS, TABLES, type MenuProduct, type PayMethod } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { errorCode, errorDetails, flowActions, isOnline } from '../app/actions.ts';
import { customerNumber, orderTotal, watchData, type FlowData, type Order, type Product } from '../app/data.ts';
import { askReason, busyButton, productMedal } from './sheets-common.ts';
import { accountLabel, chooseAccount } from './accounts.ts';
import { openPaySheet } from './checkout.ts';
import { openDeliverySheet } from './delivery-sheet.ts';

/**
 * Ficha de pedido de Caja (canon V1 §4; FLOW-DIR-001 §1–3). Un toque en la tarjeta la abre; nada cambia de estado sin una
 * acción explícita.
 * - Abierto: catálogo por Clásicos, Gourmet y Barra con «− n +»; se corrige libremente (cola offline). «Cobrado: efectivo»
 *   o «Cobrado: Bizum» lo cobra: precio cerrado, número de cobro y unidades (necesita red).
 * - Cobrado: lo cobrado con su precio, «Entrega» (la misma ficha que Servicio, y al cerrarla se vuelve aquí), «Corregir
 *   pedido» (bajar cantidades → devolución pendiente; añadir → ampliación con su propio cobro), «Anular cobro» y
 *   devoluciones pendientes por confirmar.
 * - Con cuentas (v2, 0910): «A cuenta» lo carga a una cuenta abierta (o abre una). Mientras la cuenta está abierta, el
 *   pedido no se corrige ni se anula; liquidada, se corrige pero no se anula (su dinero está en el pago de la cuenta).
 */
export function openOrderSheet(client: SyncClient, orderId: string, opts: { onClose?: () => void } = {}): void {
  const actions = flowActions(client);
  const me = client.bootstrap()?.profile.userId ?? null;
  const role = client.bootstrap()?.membership.role ?? 'reader';
  const canEdit = role !== 'reader';
  let data: FlowData | null = null;
  let mode: 'view' | 'correct' = 'view';
  let shape = '';
  const qtyFields = new Map<string, { set(q: number): void; node: HTMLElement }>();
  /** Corrección en curso de un pedido cobrado: cantidad final por línea y lo que se añade (ampliación). */
  let correction: { lines: Map<string, number>; extra: Map<string, number> } | null = null;

  /** Una acción de la ficha en vuelo: mientras dura, ningún botón del pie se puede pulsar (aunque se repinte). */
  let busy = false;
  const act = (attrs: Record<string, string>, label: string, run: () => Promise<void>) => busyButton(attrs, label, async () => {
    if (busy) return;
    busy = true;
    for (const b of foot.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
    try { await run(); } finally { busy = false; const o = order(); if (o) paintFoot(o); }
  });

  const head = el('p', { class: 'order-head', role: 'status' });
  const body = el('div', { class: 'order-body' });
  const totalEl = el('p', { class: 'order-total' });
  const foot = el('div', { class: 'flow-actions' });
  const sheet = openSheet({ title: 'Pedido', body: el('div', { class: 'order-sheet' }, head, body, totalEl), foot, onClose: () => { offData(); opts.onClose?.(); } });

  const order = (): Order | undefined => data?.orders.find((o) => o.id === orderId);
  const lines = () => data?.linesByOrder.get(orderId) ?? [];
  const asMenu = (p: Product): MenuProduct => ({ id: p.id, scope: p.scope, code: p.code, name: p.name, description: p.description, priceCents: p.price_cents, position: p.position, imageKey: p.image_key });

  // ---- Pedido abierto: cantidades sobre el catálogo -------------------------------------------------------------
  async function setOpenQuantity(productId: string, quantity: number): Promise<void> {
    const o = order();
    if (!o || o.status !== 'open') return;
    const q = Math.max(0, Math.min(99, Math.round(quantity)));
    const line = lines().find((l) => l.product_id === productId);
    try {
      if (!line && q > 0) {
        const position = lines().reduce((m, l) => Math.max(m, l.position), 0) + 1;
        await client.commit([{ op: 'insert', table: TABLES.orderLines, id: crypto.randomUUID(), fields: { order_id: o.id, product_id: productId, quantity: q, position } }]);
      } else if (line && q === 0) {
        await client.commit([{ op: 'delete', table: TABLES.orderLines, id: line.id, expectedRevision: line.revision }]);
      } else if (line && q !== line.quantity) {
        await client.commit([{ op: 'update', table: TABLES.orderLines, id: line.id, expectedRevision: line.revision, fields: { quantity: q } }]);
      }
    } catch (error) { toast(describeError(error)); }
  }

  function catalog(onChange: (productId: string, q: number) => void, value: (productId: string) => number, max?: (productId: string) => number): HTMLElement[] {
    qtyFields.clear();
    // Solo la carta del flujo de este pedido (los datos traen los productos de todos los flujos: salían repetidos y se podía
    // elegir el de otra barra, VG 28-10).
    const project = data!.orders.find((x) => x.id === orderId)?.project_id;
    return groupMenu([...data!.products.values()].filter((p) => p.active && p.project_id === project).map(asMenu)).map((g) => el('section', { class: 'order-group' },
      el('h3', null, g.label),
      ...g.products.map((mp) => {
        const product = data!.products.get(mp.id)!;
        const field = createQuantityField({ field: { id: 'flow.caja.cantidad', entity: 'flow.order_lines', prop: 'quantity', type: 'number' }, label: `Cantidad de ${product.name}`, name: `o-${product.id}`, value: value(product.id), decimals: 0, min: 0, max: max?.(product.id) ?? 99, step: 1,
          disabled: !canEdit, onChange: (v) => onChange(product.id, v.value ?? 0) });
        qtyFields.set(product.id, { set: (q) => field.set({ value: q, unit: field.get().unit }), node: field.element });
        return el('div', { class: 'order-row' }, productMedal(product),
          el('div', { class: 'order-row-text' }, el('strong', null, product.name), el('small', { class: 'muted' }, formatEuros(product.price_cents))),
          el('div', { class: 'order-row-qty' }, field.element));
      })));
  }

  // ---- Pedido cobrado: lo cobrado, corrección y dinero ------------------------------------------------------------
  function paidLines(): HTMLElement {
    return el('ul', { class: 'order-lines' }, ...lines().map((l) => {
      const p = data!.products.get(l.product_id);
      return el('li', null, p ? productMedal(p, 28) : null, el('span', null, `${l.quantity} × ${p?.name ?? 'Producto'}`),
        el('span', { class: 'muted' }, `${l.delivered_qty} entregados`), el('strong', null, formatEuros(l.quantity * (l.unit_price_cents ?? 0))));
    }));
  }

  function correctionBody(): HTMLElement[] {
    const c = correction!;
    const reduce = el('section', { class: 'order-group' }, el('h3', null, 'Bajar o quitar'),
      ...lines().map((l) => {
        const p = data!.products.get(l.product_id)!;
        const field = createQuantityField({ field: { id: 'flow.caja.cambio_cantidad', entity: 'flow.order_lines', prop: 'quantity', type: 'number' }, label: `Nueva cantidad de ${p.name}`, name: `c-${l.id}`, value: c.lines.get(l.id) ?? l.quantity, decimals: 0, min: 0, max: l.quantity, step: 1,
          onChange: (v) => { c.lines.set(l.id, v.value ?? 0); paintCorrectionTotal(); } });
        return el('div', { class: 'order-row' }, productMedal(p), el('div', { class: 'order-row-text' }, el('strong', null, p.name), el('small', { class: 'muted' }, `cobrado ${l.quantity}`)),
          el('div', { class: 'order-row-qty' }, field.element));
      }));
    const add = el('section', { class: 'order-extra' }, el('h3', null, 'Añadir (ampliación con su propio cobro, al final de la cola)'),
      ...catalog((id, q) => { if (q > 0) c.extra.set(id, q); else c.extra.delete(id); paintCorrectionTotal(); }, (id) => c.extra.get(id) ?? 0));
    return [reduce, add];
  }

  function correctionDiff(): { refund: number; extra: number } {
    const c = correction!;
    const refund = lines().reduce((sum, l) => sum + (l.quantity - (c.lines.get(l.id) ?? l.quantity)) * (l.unit_price_cents ?? 0), 0);
    const extra = [...c.extra].reduce((sum, [id, q]) => sum + q * (data!.products.get(id)?.price_cents ?? 0), 0);
    return { refund, extra };
  }

  function paintCorrectionTotal(): void {
    const { refund, extra } = correctionDiff();
    replace(totalEl, [refund ? `A devolver: ${formatEuros(refund)}` : '', extra ? `Ampliación por cobrar: ${formatEuros(extra)}` : ''].filter(Boolean).join(' · ') || 'Sin cambios');
  }

  async function saveCorrection(method: PayMethod): Promise<void> {
    const o = order();
    if (!o || !correction) return;
    if (!isOnline(client)) { toast('Corregir un pedido cobrado necesita conexión.'); return; }
    const reduce = lines().filter((l) => (correction!.lines.get(l.id) ?? l.quantity) !== l.quantity).map((l) => ({ line_id: l.id, quantity: correction!.lines.get(l.id)! }));
    const extra = [...correction.extra].map(([product_id, quantity]) => ({ product_id, quantity }));
    try {
      if (reduce.length) {
        try {
          await actions.adjustPaidOrder(o.id, reduce, method, false, o.revision);
        } catch (error) {
          if (errorCode(error) !== 'REDUCTION_NEEDS_CONFIRMATION') throw error;
          const affected = (errorDetails(error).affected ?? []) as Array<{ units?: unknown[]; deliveredQty?: number }>;
          const started = affected.reduce((n, a) => n + (a.units?.length ?? 0), 0);
          const delivered = affected.some((a) => a.deliveredQty);
          const ok = await confirmDialog({
            title: '¿Corregir algo ya empezado?',
            text: `${started ? `Hay ${started} ${started === 1 ? 'montadito empezado o terminado' : 'montaditos empezados o terminados'} en lo que quitas. ` : ''}${delivered ? 'Parte ya está entregada. ' : ''}El trabajo hecho no se borra: se cancela y queda anotado.`,
            confirmLabel: 'Corregir igualmente',
          });
          if (!ok) return;
          await actions.adjustPaidOrder(o.id, reduce, method, true, order()?.revision ?? o.revision);
        }
      }
      if (extra.length) {
        const created = await actions.createExtension(o.id, extra);
        toast('Ampliación creada: cóbrala para que entre en preparación.');
        correction = null; mode = 'view'; shape = '';
        sheet.close();
        openOrderSheet(client, created.order_id);
        return;
      }
      toast(reduce.length ? 'Pedido corregido. La devolución queda pendiente hasta confirmarla.' : 'Sin cambios.');
      correction = null; mode = 'view'; shape = ''; paint();
    } catch (error) { toast(describeError(error)); }
  }

  // ---- Pintado ----------------------------------------------------------------------------------------------------
  function paint(): void {
    const o = order();
    if (!o || !data) { sheet.close(); return; }
    const number = customerNumber(data, o);
    const parent = o.parent_id ? data.orders.find((x) => x.id === o.parent_id) : null;
    replace(head, [o.pay_seq ? `Pedido ${o.pay_seq}` : 'Pedido sin cobrar', number ? `cliente ${number}` : o.origin === 'public' ? 'desde la carta' : 'en caja',
      parent ? `ampliación del ${parent.pay_seq ?? 'pedido'}` : '', ORDER_STATUS_LABELS[o.status], methodLabel(o)].filter(Boolean).join(' · '));
    // El cuerpo se rehace solo si cambia su forma (estado, modo, líneas): así no se pierde el foco en un «− n +».
    const nextShape = `${o.status}|${mode}|${lines().map((l) => `${l.id}:${l.quantity}:${l.delivered_qty}`).join(',')}`;
    if (o.status === 'open') {
      if (!shape.startsWith('open|')) replace(body, ...catalog((id, q) => void setOpenQuantity(id, q), (id) => lines().find((l) => l.product_id === id)?.quantity ?? 0));
      for (const [id, f] of qtyFields) if (!f.node.contains(document.activeElement)) f.set(lines().find((l) => l.product_id === id)?.quantity ?? 0);
      replace(totalEl, `Total: ${formatEuros(orderTotal(data, o))}`, lines().some((l) => l._pending) ? el('small', { class: 'muted' }, ' · cambios pendientes de confirmar') : null);
    } else if (mode === 'correct') {
      if (nextShape !== shape) { replace(body, ...correctionBody()); paintCorrectionTotal(); }
    } else if (nextShape !== shape) {
      const refunds = (data.paymentsByOrder.get(o.id) ?? []).filter((p) => p.kind === 'refund' && !p.settled_at);
      replace(body, paidLines(),
        ...(refunds.length ? [el('section', { class: 'order-refunds' }, el('h3', null, 'Devoluciones pendientes'),
          ...refunds.map((r) => el('div', { class: 'order-refund' }, el('span', null, `${formatEuros(-r.amount_cents)} · ${r.method ? (CHECKOUT_METHOD_LABELS as Record<string, string>)[r.method] ?? SETTLE_METHOD_LABELS[r.method as 'cash'] : ''}`),
            act({ class: 'ghost' }, 'Ya devuelto', async () => { try { await actions.confirmRefund(r.id); toast('Devolución confirmada.'); } catch (e) { toast(describeError(e)); } }))))] : []));
      replace(totalEl, `Cobrado: ${formatEuros(o.total_cents ?? 0)}`);
    }
    shape = nextShape;
    paintFoot(o);
  }

  function methodLabel(o: Order): string {
    if (o.pay_method !== 'account') return o.pay_method ? (CHECKOUT_METHOD_LABELS as Record<string, string>)[o.pay_method] ?? PAY_METHOD_LABELS[o.pay_method as 'cash'] : '';
    const a = data?.accounts.find((x) => x.id === o.account_id);
    return a ? `a cuenta: ${accountLabel(data!, a)}${a.status === 'settled' ? ' (liquidada)' : ''}` : 'a cuenta';
  }

  function paintFoot(o: Order): void {
    paintFootButtons(o);
    if (busy) for (const b of foot.querySelectorAll('button')) (b as HTMLButtonElement).disabled = true;
  }

  function paintFootButtons(o: Order): void {
    const moneyBack = role === 'owner' || (o.paid_by !== null && o.paid_by === me);
    if (!canEdit) { replace(foot); return; }
    if (o.status === 'open') {
      const empty = lines().length === 0;
      const pay = (method: PayMethod) => act({ class: 'primary', 'data-method': method }, `Cobrado: ${PAY_METHOD_LABELS[method].toLowerCase()}`, async () => {
        if (!isOnline(client)) { toast('Cobrar necesita conexión. Usa la comanda de papel si no vuelve.'); return; }
        const fresh = order();
        if (!fresh) return;
        try {
          const out = await actions.confirmPayment(fresh.id, method, fresh.revision);
          toast(`Cobrado: pedido ${out.pay_seq}, ${formatEuros(out.total_cents)}.`);
        } catch (error) { toast(describeError(error)); }
      });
      const cash = pay('cash'); const bizum = pay('bizum');
      const onAccount = data?.accountsEnabled ? [act({ class: 'ghost', 'data-method': 'account' }, 'A cuenta', async () => {
        if (!isOnline(client)) { toast('Cargar a cuenta necesita conexión.'); return; }
        const fresh = order();
        if (!fresh || !data) return;
        const accountId = await chooseAccount(client, data, fresh.customer_id);
        if (!accountId) return;
        try {
          const out = await actions.chargeToAccount(fresh.id, accountId, order()?.revision ?? fresh.revision);
          toast(`A cuenta: pedido ${out.pay_seq}, ${formatEuros(out.total_cents)}.`);
        } catch (error) { toast(describeError(error)); }
      })] : [];
      // Caja profunda (v2, 0917): «Pagar» abre la pantalla de pago (metálico, Bizum, tarjeta, Bitcoin).
      const deep = data?.deepCheckout.has(o.project_id)
        ? [el('button', { type: 'button', class: 'primary', onclick: () => { sheet.close(); openPaySheet(client, o.project_id, [o.id]); } }, 'Pagar')] as HTMLButtonElement[] : null;
      for (const b of [cash, bizum, ...onAccount, ...(deep ?? [])]) b.disabled = empty || lines().some((l) => l._pending);
      if (deep) replace(foot, ...deep, ...onAccount); else replace(foot, cash, bizum, ...onAccount);
    } else if (mode === 'correct') {
      const save = (method: PayMethod) => act({ class: 'primary' }, `Guardar (${PAY_METHOD_LABELS[method].toLowerCase()})`, () => saveCorrection(method));
      replace(foot, el('button', { type: 'button', class: 'ghost', onclick: () => { mode = 'view'; correction = null; shape = ''; paint(); } }, 'Cancelar'), save('cash'), save('bizum'));
    } else {
      replace(foot,
        el('button', { type: 'button', class: 'ghost', onclick: () => { sheet.close(); openDeliverySheet(client, o.id, { onClose: () => openOrderSheet(client, o.id) }); } }, 'Entrega'),
        ...(accountOpen(o) ? [el('small', { class: 'muted' }, 'En una cuenta abierta: se corrige al liquidarla.')]
          : [el('button', { type: 'button', class: 'ghost', onclick: () => { mode = 'correct'; correction = { lines: new Map(), extra: new Map() }; shape = ''; paint(); } }, 'Corregir pedido')]),
        ...(o.status === 'paid' && moneyBack && !o.account_id ? [act({ class: 'ghost danger-text' }, 'Anular cobro', async () => {
          const reason = await askReason('Anular el cobro', 'Se anota la devolución de lo cobrado y se cancelan los montaditos sin terminar. El cobro original no se borra.', 'Anular cobro', true);
          if (!reason) return;
          const fresh = order();
          try { await actions.reversePayment(o.id, reason, fresh?.revision ?? o.revision); toast('Cobro anulado.'); } catch (error) { toast(describeError(error)); }
        })] : []));
    }
  }

  function accountOpen(o: Order): boolean {
    return !!o.account_id && data?.accounts.find((a) => a.id === o.account_id)?.status === 'open';
  }

  const offData = watchData(client, (d) => { data = d; paint(); });
}
