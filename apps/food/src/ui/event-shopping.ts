/**
 * Food · la lista de la compra única por evento (encargo de Core, 28-10-2026; 1117; docs/food/API.md §2.15;
 * diseño en MUELA/equipo/feedback/food/LISTA_COMPRA.md).
 *
 * Suma las listas ya generadas de los menús del evento (el menú cerrado y sus cartas), por tienda y pasillo. Lo que falta
 * por generar se dice arriba, para que no salga corta en silencio. Desde aquí se compra (el carrito, que entra en la
 * Despensa como en la lista de un menú) o se pide a Tasks como compras (`tasks.request_purchase`, una por fila y una sola
 * vez); «Ver cómo va en Tasks» marca lo que Tasks ya ha comprado. Leer y pedir necesitan red.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  groupEventShopping, menusWithoutList, unrequestedQuantity, validateOperations,
  type EventShopping, type EventShoppingRow, type FoodEvent, type Ingredient,
} from '@ikisai/domain-food';
import { el, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { T, describeError, formatQuantity } from '../app/client.ts';
import { recordShoppingPurchases } from '../app/shopping-stock.ts';
import { usage } from '../app/usage.ts';
import { cartaHash } from './carta.ts';
import type { ViewMount } from './shell.ts';

export const eventShoppingHash = (eventId: string) => `#/eventos/${eventId}/compra`;

const canWrite = (client: SyncClient) => { const role = client.bootstrap()?.membership.role; return role === 'editor' || role === 'owner'; };
const PROJECT_KEY = 'ikisai-food-tasks-project';
const rememberedProject = (): string | null => { try { return localStorage.getItem(PROJECT_KEY); } catch { return null; } };
const rememberProject = (id: string) => { try { localStorage.setItem(PROJECT_KEY, id); } catch { /* sin almacenamiento: se vuelve a elegir */ } };

export function mountEventShopping(eventId: string): ViewMount {
  return ({ main, client, navigate }) => {
    const writable = canWrite(client);
    let alive = true;
    let data: EventShopping | null = null;
    let title = 'Evento';
    let busy = false;
    let sheet: Sheet | null = null;
    const picked = new Set<string>();

    const head = el('div', { class: 'pagehead' });
    const host = el('div', { id: 'eventShopping' }, el('p', { class: 'muted' }, 'Sumando las listas del evento…'));
    replace(main, el('section', { 'data-feedback-id': 'food.eventos.compra', 'data-feedback-label': 'Lista de la compra del evento' }, head, host));

    async function load(): Promise<void> {
      try {
        const [event, out] = await Promise.all([
          client.api<{ event: FoodEvent }>(`/events/${eventId}`).catch(() => null),
          client.api<EventShopping>('/read/food.event_shopping', { method: 'POST', json: { event_id: eventId } }),
        ]);
        if (!alive) return;
        title = event?.event?.title ?? title;
        data = out;
        // Lo que se puede pedir, elegido de partida; lo que ya no se puede, fuera.
        const can = new Set(out.rows.filter((r) => pickable(r)).map((r) => r.key));
        for (const key of [...picked]) if (!can.has(key)) picked.delete(key);
        if (!picked.size) can.forEach((k) => picked.add(k));
        paint();
      } catch (error) {
        if (!alive) return;
        replace(host, el('div', { class: 'banner warn notice', role: 'note', id: 'eventShoppingError' },
          el('div', null, el('strong', null, 'No se ha podido sumar la lista del evento.'), ` ${describeError(error)} Necesita conexión.`)));
      }
    }

    const pickable = (row: EventShoppingRow) => writable && unrequestedQuantity(row) > 0;
    const qty = (n: number | string, unit: string) => `${formatQuantity(Number(n))} ${unit}`;

    function paintHead(): void {
      replace(head,
        el('button', { 'data-feedback-id': 'food.eventos.compra.volver', 'data-feedback-label': 'Volver a Eventos', class: 'ghost', type: 'button', onclick: () => navigate('#/eventos') }, '‹ Eventos'),
        el('h2', { 'data-feedback-ignore': '' }, `Lista de la compra · ${title}`));
    }

    function row(r: EventShoppingRow, index: number): HTMLElement {
      const box = pickable(r) ? el('input', { 'data-field-none': '', 'data-feedback-id': 'food.eventos.compra.elegir', 'data-feedback-label': 'Pedir esta fila a Tasks', type: 'checkbox', id: `evpick-${index}`,
        checked: picked.has(r.key), 'aria-label': `Pedir ${r.name} a Tasks`, onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) picked.add(r.key); else picked.delete(r.key); paintFoot(); } }) : null;
      const requestedShort = r.purchase_ref && Number(r.requested) > 0 && Number(r.pending) > Number(r.requested) + 1e-9;
      return el('li', { class: 'evshop-row', id: `evshop-${index}` },
        box,
        el('div', null,
          el('strong', null, r.name), ` · ${qty(r.status === 'comprado' ? r.bought : r.pending, r.unit)}`,
          r.status === 'pedida' ? el('span', { class: 'chip pending' }, 'Pedida en Tasks') : r.status === 'comprado' ? el('span', { class: 'chip ok' }, 'Comprado') : null,
          el('div', { class: 'muted' }, r.menus.join(' · ')),
          requestedShort ? el('div', { class: 'warnline' }, `Pedidas ${qty(r.requested, r.unit)} a Tasks; ahora hacen falta ${qty(r.pending, r.unit)}. Lo nuevo se puede pedir aparte.`) : null),
        writable && unrequestedQuantity(r) > 0 ? el('button', { 'data-feedback-id': 'food.eventos.compra.comprado', 'data-feedback-label': 'Marcar comprado', class: 'ghost', type: 'button',
          id: `evbuy-${index}`, disabled: busy, onclick: () => void markBought(r) }, 'Comprado') : null);
    }

    const foot = el('div', { class: 'btnrow', id: 'eventShoppingActions' });
    function paintFoot(): void {
      if (!data) return;
      const anyAsked = data.rows.some((r) => r.lines.some((l) => l.purchase_ref && l.status === 'pendiente'));
      replace(foot,
        writable ? el('button', { 'data-feedback-id': 'food.eventos.compra.pedir', 'data-feedback-label': 'Pedir a Tasks', class: 'primary', type: 'button', id: 'eventShoppingRequest',
          disabled: busy || !picked.size, onclick: () => void openRequest() }, picked.size ? `Pedir a Tasks (${picked.size})` : 'Pedir a Tasks') : null,
        writable && anyAsked ? el('button', { 'data-feedback-id': 'food.eventos.compra.ver_tasks', 'data-feedback-label': 'Ver cómo va en Tasks', class: 'ghost', type: 'button', id: 'eventShoppingRefresh',
          disabled: busy, onclick: () => void refresh() }, 'Ver cómo va en Tasks') : null,
        el('button', { 'data-feedback-id': 'food.eventos.compra.imprimir', 'data-feedback-label': 'Imprimir', class: 'ghost', type: 'button', id: 'eventShoppingPrint',
          onclick: () => { usage.track('food.eventos.compra.imprimir'); window.print(); } }, 'Imprimir'));
    }

    function paint(): void {
      paintHead();
      if (!data) return;
      const missing = menusWithoutList(data);
      const groups = groupEventShopping(data.rows);
      let n = 0;
      const pending = data.rows.filter((r) => r.status === 'pendiente').length;
      const asked = data.rows.filter((r) => r.status === 'pedida').length;
      const bought = data.rows.filter((r) => r.status === 'comprado').length;
      paintFoot();
      replace(host,
        !data.menus.length ? el('div', { class: 'empty plain', id: 'eventShoppingEmpty' }, 'Este evento no tiene menú ni carta: no hay nada que comprar todavía.') : null,
        data.menus.length ? el('p', { class: 'muted', id: 'eventShoppingSources' }, `Suma las listas de: ${data.menus.map((m) => m.name).join(', ')}.`) : null,
        missing.length ? el('div', { 'data-feedback-id': 'food.eventos.compra.sin_lista', 'data-feedback-label': 'Menús sin lista', class: 'banner warn notice', role: 'note', id: 'eventShoppingMissing' },
          el('div', null, el('strong', null, `Falta la lista de ${missing.map((m) => m.name).join(', ')}.`), ' Genérala en su pestaña Compra: hasta entonces no suma aquí.'),
          el('div', { class: 'btnrow' }, ...missing.map((m) => el('button', { 'data-feedback-id': 'food.eventos.compra.generar', 'data-feedback-label': 'Ir a generar la lista', class: 'ghost', type: 'button',
            onclick: () => navigate(m.kind === 'carta' ? cartaHash(m.menu_id, 'compra') : `#/menus/${m.menu_id}/compra`) }, `Generar: ${m.name}`)))) : null,
        data.rows.length ? el('p', { id: 'eventShoppingSummary' }, [pending ? `${pending} por comprar` : null, asked ? `${asked} pedidas en Tasks` : null, bought ? `${bought} compradas` : null].filter(Boolean).join(' · ') + '.') : null,
        ...groups.map((g) => el('section', { class: 'card evshop-shop' },
          el('h3', null, g.shop),
          ...g.aisles.map((a) => el('div', null, el('div', { class: 'sectionlabel' }, a.aisle), el('ul', { class: 'plainlist' }, ...a.rows.map((r) => row(r, n++))))))),
        foot);
    }

    /** El carrito: todo lo pendiente sin pedir de esa fila, comprado en un commit y a la Despensa. */
    async function markBought(r: EventShoppingRow): Promise<void> {
      const lines = r.lines.filter((l) => l.status === 'pendiente' && !l.purchase_ref);
      const ops: RowOperation[] = lines.map((l) => ({ op: 'update', table: T.shoppingItems, id: l.id, expectedRevision: Number(l.revision), fields: { status: 'comprado' } }));
      const issue = validateOperations(ops);
      if (issue) { toast(issue.message); return; }
      busy = true; paintFoot();
      try {
        await usage.run('food.eventos.compra.comprado', () => client.commit(ops));
        const ingredients = await client.list(T.ingredients) as unknown as Ingredient[];
        await recordShoppingPurchases(client, lines.map((l) => ({ id: l.id, ingredient_id: r.ingredient_id, purchase_quantity: Number(l.quantity), unit: r.unit as never,
          status: 'comprado', supplier: r.supplier, purchase_ref: null })), ingredients);
        toast(`${r.name}: comprado.`);
      } catch (error) {
        toast(describeError(error));
      } finally {
        busy = false;
        await load();
      }
    }

    async function openRequest(): Promise<void> {
      if (!data) return;
      const rows = data.rows.filter((r) => picked.has(r.key) && pickable(r));
      const select = el('select', { 'data-field-id': 'food.eventos.compra.proyecto', 'data-field-entity': 'food.shopping_list_items', 'data-field-prop': 'purchase_project_id', 'data-feedback-id': 'food.eventos.compra.proyecto', 'data-feedback-label': 'Proyecto de Tasks', id: 'eventShoppingProject', 'aria-label': 'Proyecto de Tasks' },
        el('option', { value: '' }, 'Cargando los proyectos…')) as HTMLSelectElement;
      const send = el('button', { 'data-feedback-id': 'food.eventos.compra.enviar', 'data-feedback-label': 'Pedir', class: 'primary', type: 'button', id: 'eventShoppingSend', disabled: true,
        onclick: async () => {
          if (!select.value) { toast('Elige un proyecto de Tasks.'); return; }
          send.disabled = true;
          try {
            const out = await usage.run('food.eventos.compra.pedir', () => client.api<{ requested: Array<{ created: boolean }> }>(`/events/${eventId}/shopping/request`,
              { method: 'POST', json: { projectId: select.value, keys: rows.map((r) => r.key) } }));
            rememberProject(select.value);
            const n = out?.requested.length ?? 0;
            toast(n ? `Pedido a Tasks: ${n === 1 ? '1 compra' : `${n} compras`}.` : 'No había nada nuevo que pedir.');
            await sheet?.close(true);
            await load();
          } catch (error) {
            toast(describeError(error));
            send.disabled = false;
          }
        } }, 'Pedir');
      sheet = openSheet({
        title: 'Pedir a Tasks',
        body: el('div', { class: 'formblock' },
          el('p', { class: 'muted' }, 'Una compra por fila, en el proyecto que elijas. Pedir otra vez lo mismo no la duplica. El stock entra al recibirla en Tasks.'),
          el('label', { class: 'field' }, el('span', null, 'Proyecto de Tasks'), select),
          el('ul', { class: 'plainlist', id: 'eventShoppingToSend' }, ...rows.map((r) => el('li', null, el('strong', null, r.name), ` · ${qty(unrequestedQuantity(r), r.unit)}`, r.supplier ? el('span', { class: 'muted' }, ` · ${r.supplier}`) : null)))),
        foot: [el('button', { 'data-feedback-id': 'food.eventos.compra.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), send],
        onClose: () => { sheet = null; },
      });
      try {
        const out = await client.api<{ projects: Array<{ id: string; title: string; tabName?: string }> }>(`/events/${eventId}/shopping/projects`);
        const last = rememberedProject();
        replace(select, el('option', { value: '' }, out.projects.length ? 'Elige un proyecto' : 'No ves ningún proyecto abierto en Tasks'),
          ...out.projects.map((p) => el('option', { value: p.id, selected: p.id === last }, p.tabName ? `${p.title} · ${p.tabName}` : p.title)));
        send.disabled = !out.projects.length;
      } catch (error) {
        replace(select, el('option', { value: '' }, 'No se han podido leer los proyectos'));
        toast(describeError(error));
      }
    }

    async function refresh(): Promise<void> {
      busy = true; paintFoot();
      try {
        const out = await usage.run('food.eventos.compra.ver_tasks', () => client.api<{ checked: number; marked: number }>(`/events/${eventId}/shopping/refresh`, { method: 'POST', json: {} }));
        toast(out?.marked ? `Tasks ya ha comprado lo de ${out.marked === 1 ? '1 línea' : `${out.marked} líneas`}: marcado aquí.` : 'Tasks todavía no ha comprado nada de lo pedido.');
      } catch (error) {
        toast(describeError(error));
      } finally {
        busy = false;
        await load();
      }
    }

    paintHead();
    void load();
    return () => { alive = false; void sheet?.close(); };
  };
}
