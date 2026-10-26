import { el, icon, toast } from '@ikisai/ui-kit';
import { formatEuros, TABLES } from '@ikisai/domain-flow';
import { describeError } from '../app/client.ts';
import { byPaySeq, customerNumber, orderTotal, pendingOf, watchData, type FlowData, type Order } from '../app/data.ts';
import { openDeliverySheet } from './delivery-sheet.ts';
import { openOrderSheet } from './order-sheet.ts';
import { createStableList } from './stable-list.ts';
import type { ViewMount } from './shell.ts';

/**
 * Columnas de pedidos completos (comportamiento `inspect_confirm`, canon V1 §10.2): un toque abre la ficha; las acciones
 * se ejecutan dentro, expresamente.
 * - **Pedido y cobro** (§4; FLOW-DIR-001 §1): arriba los pendientes de cobro por llegada, debajo los cobrados por número de
 *   cobro, en gris y más bajos, sin moverse. Buscar por número de cliente («Soy el 142») enseña solo sus pedidos.
 *   «Nuevo pedido» para quien llega sin pedido preparado.
 * - **Servicio y entrega** (§6): los cobrados por número de cobro, con lo que falta; abre la ficha de entrega. Bebidas y
 *   extras van aquí (no hay columna de bebidas).
 */
export function mountOrders(kind: 'order' | 'service'): ViewMount {
  return (ctx) => {
    const { main, client } = ctx;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    let data: FlowData | null = null;
    let search = '';

    const searchInput = el('input', { type: 'search', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Número de cliente', 'aria-label': 'Buscar por número de cliente', autocomplete: 'off',
      oninput: () => { search = searchInput.value.replace(/\D/g, ''); paint(); } });
    const newButton = el('button', { type: 'button', class: 'primary', onclick: newOrder }, icon('plus', 18), el('span', null, 'Nuevo pedido'));
    const found = el('p', { class: 'muted small', role: 'status' });
    const listEl = el('div', { class: 'queue', role: 'list' });
    const empty = el('p', { class: 'muted queue-empty', hidden: true });
    main.append(
      el('h1', { class: 'col-title' }, kind === 'order' ? 'Pedido y cobro' : 'Servicio y entrega'),
      el('div', { class: 'orders-tools' }, searchInput, ...(kind === 'order' && canEdit ? [newButton] : [])),
      found, listEl, empty,
    );

    const list = createStableList<Order>({ element: listEl, key: (o) => o.id, render: (o) => { const n = shell(o); fill(n, o); return n; }, update: fill });

    function orders(): Order[] {
      if (!data) return [];
      let all = data.orders;
      if (kind === 'service') all = all.filter((o) => o.status !== 'open');
      if (search) all = all.filter((o) => String(customerNumber(data!, o) ?? '') === search);
      // Pedido y cobro: los abiertos arriba (por llegada); luego los cobrados por número. Servicio: por número.
      const open = all.filter((o) => o.status === 'open').sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
      const paid = all.filter((o) => o.status !== 'open').sort(byPaySeq);
      return [...open, ...paid];
    }

    function shell(o: Order): HTMLElement {
      return el('div', { class: 'qcard order-card', role: 'listitem' },
        el('button', { type: 'button', class: 'qcard-main', onclick: () => open(o.id) },
          el('span', { class: 'order-badge' }),
          el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }), el('small', { class: 'qcard-sub muted' })),
          el('span', { class: 'qcard-state' })));
    }

    function fill(node: HTMLElement, o: Order): void {
      if (!data) return;
      const number = customerNumber(data, o);
      const p = pendingOf(data, o);
      const finished = kind === 'order' ? o.status !== 'open' : o.status === 'delivered';
      node.className = `qcard order-card is-${o.status}${finished ? ' is-done' : ''}${o._pending ? ' is-unconfirmed' : ''}`;
      node.querySelector('.order-badge')!.textContent = o.pay_seq ? String(o.pay_seq) : '·';
      const items = (data.linesByOrder.get(o.id) ?? []).map((l) => `${l.quantity} ${data!.products.get(l.product_id)?.code ?? ''}`).join(' · ');
      node.querySelector('.qcard-title')!.textContent = [number ? `Cliente ${number}` : o.origin === 'public' ? 'Desde la carta' : 'Caja', o.parent_id ? 'ampliación' : ''].filter(Boolean).join(' · ');
      node.querySelector('.qcard-sub')!.textContent = `${items || 'sin productos'} · ${formatEuros(orderTotal(data, o))}`;
      const state = o.status === 'open' ? 'Por cobrar'
        : o.status === 'delivered' ? (o.delivery_exception ? 'Entregado con excepción' : 'Entregado')
        : p.prepPending ? `Preparando ${p.prepTotal - p.prepPending}/${p.prepTotal}` : p.undelivered ? 'Listo para entregar' : 'Todo entregado';
      node.querySelector('.qcard-state')!.textContent = o._pending ? `${state} · pendiente de confirmar` : state;
    }

    function open(id: string): void {
      const o = data?.orders.find((x) => x.id === id);
      if (!o) return;
      if (kind === 'service') openDeliverySheet(client, id);
      else openOrderSheet(client, id);
    }

    async function newOrder(): Promise<void> {
      if (!data?.project) return;
      const id = crypto.randomUUID();
      try {
        await client.commit([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: data.project.id, origin: 'counter' } }]);
        openOrderSheet(client, id);
      } catch (error) { toast(describeError(error)); }
    }

    function paint(): void {
      const items = orders();
      list.set(items);
      found.textContent = search ? (items.length ? `Pedidos del cliente ${search}: ${items.length}` : `No hay pedidos del cliente ${search}.`) : '';
      empty.hidden = items.length > 0 || !!search;
      empty.textContent = kind === 'order' ? 'Aún no hay pedidos.' : 'Aún no hay pedidos cobrados.';
    }

    const offData = watchData(client, (d) => { data = d; paint(); });
    return () => offData();
  };
}
