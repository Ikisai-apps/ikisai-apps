import { confirmDialog, el, fieldAttrs, icon, openSheet, toast } from '@ikisai/ui-kit';
import { formatEuros, TABLES } from '@ikisai/domain-flow';
import { isOnline } from '../app/actions.ts';
import { loadProjects } from '../app/data.ts';
import { pickMenu, planSync, readFoodMenus, type CartaMenu } from '../app/food-sync.ts';
import { describeError } from '../app/client.ts';
import { byPaySeq, customerNumber, orderTotal, pendingOf, watchData, type FlowData, type Order } from '../app/data.ts';
import { openDeliverySheet } from './delivery-sheet.ts';
import { openOrderSheet } from './order-sheet.ts';
import { accountLabel, openAccountsSheet } from './accounts.ts';
import { openCustomerSheet } from './checkout.ts';
import { createStableList } from './stable-list.ts';
import type { ViewMount } from './shell.ts';

/**
 * Columnas de pedidos completos (comportamiento `inspect_confirm`, canon V1 §10.2): un toque abre la ficha; las acciones
 * se ejecutan dentro, expresamente.
 * - **Pedido y cobro** (§4; FLOW-DIR-001 §1): arriba los pendientes de cobro por llegada, debajo los cobrados por número de
 *   cobro, en gris y más bajos, sin moverse. Buscar por número de cliente («Soy el 142») enseña solo sus pedidos.
 *   «Nuevo pedido» para quien llega sin pedido preparado. Con cuentas (v2, 0910), «Cuentas» abre, enseña y liquida.
 * - **Servicio y entrega** (§6): los cobrados por número de cobro, con lo que falta; abre la ficha de entrega. Bebidas y
 *   extras van aquí (no hay columna de bebidas).
 */
export function mountOrders(kind: 'order' | 'service'): ViewMount {
  return (ctx) => {
    const { main, client } = ctx;
    const canEdit = client.bootstrap()?.membership.role !== 'reader';
    let data: FlowData | null = null;
    let search = '';

    const searchInput = el('input', { ...fieldAttrs({ id: 'flow.caja.buscar_cliente', type: 'search', storage: 'none' }), type: 'search', inputmode: 'numeric', pattern: '[0-9]*', placeholder: 'Número de cliente', 'aria-label': 'Buscar por número de cliente', autocomplete: 'off',
      oninput: () => { search = searchInput.value.replace(/\D/g, ''); paint(); } });
    const newButton = el('button', { type: 'button', class: 'primary', onclick: newOrder }, icon('plus', 18), el('span', null, 'Nuevo pedido'));
    const accountsButton = el('button', { type: 'button', class: 'ghost', hidden: true, onclick: () => { if (ctx.projectId) openAccountsSheet(client, ctx.projectId); } }, 'Cuentas');
    const found = el('p', { class: 'muted small', role: 'status' });
    const customerButton = el('button', { type: 'button', class: 'ghost', hidden: true,
      onclick: () => { if (ctx.projectId && search) openCustomerSheet(client, ctx.projectId, Number(search)); } }, 'Ficha del cliente');
    const listEl = el('div', { class: 'fqueue', role: 'list' });
    const empty = el('p', { class: 'muted fqueue-empty', hidden: true });
    const isOwner = client.bootstrap()?.membership.role === 'owner';
    const ownerTools = kind === 'order' && isOwner ? [el('div', { class: 'orders-owner' },
      el('button', { type: 'button', class: 'ghost', onclick: () => void syncFromFood() }, 'Actualizar carta desde Food'),
      el('a', { class: 'ghost button-link', href: `#/p/${ctx.projectId}/cierre` }, 'Cierre del día'))] : [];
    main.append(
      el('h1', { class: 'col-title' }, ctx.columnLabel ?? (kind === 'order' ? 'Pedido y cobro' : 'Servicio y entrega')),
      ...ownerTools,
      el('div', { class: 'orders-tools' }, searchInput, ...(kind === 'order' && canEdit ? [newButton, accountsButton] : [])),
      el('div', { class: 'orders-found' }, found, customerButton), listEl, empty,
    );

    const list = createStableList<Order>({ element: listEl, key: (o) => o.id, render: (o) => { const n = shell(o); fill(n, o); return n; }, update: fill });

    function orders(): Order[] {
      if (!data) return [];
      let all = data.orders;
      if (kind === 'service') all = all.filter((o) => o.status !== 'open');
      // Un pedido de caja abierto y sin líneas es un «Nuevo pedido» que no se usó: no se enseña.
      all = all.filter((o) => !(o.status === 'open' && o.origin === 'counter' && !(data!.linesByOrder.get(o.id)?.length)));
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
      node.className = `qcard order-card is-${o.status}${finished ? ' is-done' : ''}${o._pending ? ' is-unconfirmed' : ''}${o.test_by ? ' is-test' : ''}`;
      node.querySelector('.order-badge')!.textContent = o.pay_seq ? String(o.pay_seq) : '·';
      const items = (data.linesByOrder.get(o.id) ?? []).map((l) => { const pr = data!.products.get(l.product_id); return `${l.quantity} ${pr ? `${pr.code} ${pr.name}` : ''}`; }).join(' · ');
      const account = o.account_id ? data.accounts.find((a) => a.id === o.account_id) : null;
      // Pedido de un miembro (0952, vg-48): fuera del horario, de prueba (no cuenta); durante el evento, cuenta y Finance lo ajusta.
      node.querySelector('.qcard-title')!.textContent = [o.test_by ? (o.test_excluded ? `Pedido de prueba (${o.test_name ?? 'equipo'})` : `Pedido del equipo (${o.test_name ?? 'equipo'}), se ajusta en Finance`) : '', number ? `Cliente ${number}` : o.origin === 'public' ? 'Desde la carta' : 'Caja', o.parent_id ? 'ampliación' : '',
        account ? `a cuenta: ${accountLabel(data, account)}` : ''].filter(Boolean).join(' · ');
      node.querySelector('.qcard-sub')!.textContent = `${items || 'sin productos'} · ${formatEuros(orderTotal(data, o))}`;
      const state = o.status === 'open' ? 'Por cobrar'
        : o.status === 'delivered' ? (o.delivery_exception ? 'Entregado con excepción' : 'Entregado')
        : p.prepPending ? `${data.completeOnDelivery.has(o.project_id) && kind === 'service' ? 'En cocina' : 'Preparando'} ${p.prepTotal - p.prepPending}/${p.prepTotal}` : p.undelivered ? 'Listo para entregar' : 'Todo entregado';
      node.querySelector('.qcard-state')!.textContent = o._pending ? `${state} · pendiente de confirmar` : state;
    }

    function open(id: string): void {
      const o = data?.orders.find((x) => x.id === id);
      if (!o) return;
      if (kind === 'service') openDeliverySheet(client, id);
      else openOrderSheet(client, id);
    }

    /** «Actualizar carta desde Food»: lee su carta, enseña qué cambia y, si se confirma, lo aplica (food-sync.ts). */
    async function syncFromFood(): Promise<void> {
      if (!isOnline(client)) { toast('Actualizar la carta necesita conexión.'); return; }
      try {
        const project = (await loadProjects(client)).find((p) => p.id === ctx.projectId);
        if (!project || !data) return;
        const menus = await readFoodMenus(client);
        if (!menus.length) { toast('Food aún no tiene ninguna carta.'); return; }
        const menu = pickMenu(menus, project) ?? await chooseMenu(menus);
        if (!menu) return;
        const plan = planSync(project, menu, [...data.products.values()]);
        if (!plan.operations.length) { toast('La carta ya está al día con Food.'); return; }
        const ok = await confirmDialog({ title: `Carta de Food: ${menu.name}`, confirmLabel: 'Actualizar',
          text: [`${plan.created} nuevos`, `${plan.changed} con cambios${plan.priced ? ` (${plan.priced} de precio)` : ''}`, `${plan.deactivated} se retiran`].join(' · ')
            + '. Lo ya cobrado no cambia de precio.' });
        if (!ok) return;
        await client.commit(plan.operations as any);
        toast('Carta actualizada desde Food.');
      } catch (error) { toast(describeError(error)); }
    }

    function chooseMenu(menus: CartaMenu[]): Promise<CartaMenu | null> {
      return new Promise((resolve) => {
        let chosen: CartaMenu | null = null;
        const sheet = openSheet({ title: 'Elige la carta de Food', onClose: () => resolve(chosen),
          body: el('div', { class: 'flow-actions' }, ...menus.map((m) => el('button', { type: 'button', class: 'ghost', onclick: () => { chosen = m; sheet.close(); } }, `${m.name} (${m.lines.length})`))) });
      });
    }

    async function newOrder(): Promise<void> {
      if (!data?.project) return;
      const id = crypto.randomUUID();
      try {
        await client.commit([{ op: 'insert', table: TABLES.orders, id, fields: { project_id: data.project.id, origin: 'counter' } }]);
        // Si se cierra sin poner nada, no queda un pedido vacío «Caja» (VG, 28-10).
        openOrderSheet(client, id, { onClose: () => void dropIfEmpty(id) });
      } catch (error) { toast(describeError(error)); }
    }

    async function dropIfEmpty(id: string): Promise<void> {
      const o = ((await client.list(TABLES.orders)) as unknown as Array<{ id: string; status: string; revision: number; deleted_at: string | null }>).find((x) => x.id === id);
      const lines = ((await client.list(TABLES.orderLines)) as unknown as Array<{ order_id: string; deleted_at: string | null }>).filter((l) => l.order_id === id && !l.deleted_at);
      if (!o || o.deleted_at || o.status !== 'open' || lines.length) return;
      try { await client.commit([{ op: 'delete', table: TABLES.orders, id, expectedRevision: o.revision }]); } catch { /* si no se puede, queda; se oculta abajo */ }
    }

    function paint(): void {
      accountsButton.hidden = !data?.accountsEnabled;
      const items = orders();
      list.set(items);
      customerButton.hidden = !(kind === 'order' && search && items.length && ctx.projectId && data?.deepCheckout.has(ctx.projectId));
      found.textContent = search ? (items.length ? `Pedidos del cliente ${search}: ${items.length}` : `No hay pedidos del cliente ${search}.`) : '';
      empty.hidden = items.length > 0 || !!search;
      empty.textContent = kind === 'order' ? 'Aún no hay pedidos.' : 'Aún no hay pedidos cobrados.';
    }

    const offData = watchData(client, (d) => { data = d; paint(); }, ctx.projectId);
    return () => offData();
  };
}
