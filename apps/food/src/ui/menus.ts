import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, LOCKED_MENU_STATUSES, SERVICE_TYPES, dishCost, priceFor, eventChanges, eventSnapshot, isMenuStale, menuWarnings, scaledIngredients, serviceCosts, validateOperations,
  type Equipment, type EventChange, type FoodEvent, type Ingredient, type Menu, type MenuGraph, type MenuItem, type MenuService, type MenuWarning, type RecipeEquipment,
  type RecipeIngredient,
} from '@ikisai/domain-food';
import { closeSheet, confirmDialog, createSortableList, el, formatDate, icon, listRow, openSheet, renderMoneyBreakdown, replace, toast, type Sheet, type Sortable } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { ALLERGEN_LABELS, CATEGORY_LABELS, DIET_LABELS, T, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import {
  dateRange, eventDays, guestsLabel, longDay, mealPlanLabel, refreshEvents, restrictionLabel, shortTime, sortedRestrictions, watchEvents, type EventsSnapshot,
} from '../app/events.ts';
import { loadMenuData, type RecipeRow } from '../app/menu-data.ts';
import { showPhoto } from '../app/photos.ts';
import { loadPurchases, type PurchasesSnapshot } from '../app/purchases.ts';
import { mountClosing } from './menu-closing.ts';
import { mountOrganizer } from './menu-organizer.ts';
import { mountPreparation } from './menu-preparation.ts';
import { mountShopping } from './menu-shopping.ts';
import { MENU_STATUS_LABELS, SERVICE_LABELS, menuChip } from './events.ts';
import type { ViewContext, ViewMount } from './shell.ts';

type MenuRow = Mirror<Menu>;
type ServiceRow = Mirror<MenuService>;
type ItemRow = Mirror<MenuItem>;

export type MenuTab = 'menu' | 'compra' | 'preparacion' | 'organizador' | 'cierre';
const TABS: Array<[MenuTab, string]> = [['menu', 'Menú'], ['compra', 'Compra'], ['preparacion', 'Preparación'], ['organizador', 'Organizador'], ['cierre', 'Cierre']];

const removeOp = (table: (typeof T)[keyof typeof T], row: SyncedRow): RowOperation => ({ op: 'delete', table, id: row.id, expectedRevision: row.revision });

/** Menús: uno por evento, con su estado. */
export const mountMenus: ViewMount = ({ main, client, navigate }) => {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: MenuRow[] = [];
  const list = el('ul', { class: 'list', id: 'menuList', 'aria-label': 'Menús' });
  const host = el('div');
  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Menús'), el('p', null, 'El menú de cada evento. Se crean desde Eventos.'))),
    host,
  );

  function paint(): void {
    const events = new Map(snapshot.events.map((e) => [e.event_id, e]));
    const rows = menus.filter((m) => !m.deleted_at)
      .map((menu) => ({ menu, event: events.get(menu.event_id) }))
      .sort((a, b) => (b.event?.start_date ?? '').localeCompare(a.event?.start_date ?? ''));
    replace(list, ...rows.map(({ menu, event }) => listRow({
      id: menu.id,
      title: event?.title ?? 'Evento no disponible',
      meta: event ? [dateRange(event), guestsLabel(event), mealPlanLabel(event.meal_plan)] : ['Sin datos del evento en este dispositivo'],
      chips: [event ? menuChip(event, menu) : el('span', { class: 'chip' }, MENU_STATUS_LABELS[menu.status])],
      pending: menu._pending === true,
      label: `Abrir el menú de ${event?.title ?? 'este evento'}`,
      onClick: () => navigate(`#/menus/${menu.id}`),
    })));
    replace(host, rows.length ? list : el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay menús'),
      'Elige un evento y pulsa «Crear menú».', el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/eventos') }, 'Ir a Eventos'))));
  }

  async function load(): Promise<void> {
    menus = (await client.list(T.menus)) as MenuRow[];
    paint();
  }
  void load();
  const offEvents = watchEvents(client, (next) => { snapshot = next; paint(); });
  const offMenus = client.onTable(T.menus, () => void load());
  return () => { offEvents(); offMenus(); };
};

const CHANGE_LABELS: Record<EventChange['field'], string> = { guest_count: 'Personas', dates: 'Fechas', meal_plan: 'Régimen', menu_style: 'Tipo de menú', restrictions: 'Restricciones' };

function changeText(change: EventChange): string {
  const show = (value: unknown): string => {
    if (change.field === 'dates') { const [start, end] = value as [string, string]; return dateRange({ start_date: start, end_date: end }); }
    if (change.field === 'meal_plan') return mealPlanLabel(value as string | null);
    if (change.field === 'restrictions') return (value as FoodEvent['dietary_restrictions']).map(restrictionLabel).join(', ') || 'ninguna';
    return value === null || value === undefined ? '—' : String(value);
  };
  return `${CHANGE_LABELS[change.field]}: ${show(change.before)} → ${show(change.after)}`;
}

/** Ficha de un menú: cabecera con el evento y sus restricciones siempre a la vista, y pestañas Menú · Compra · Preparación · Organizador · Cierre. */
export function mountMenu(menuId: string, tab: MenuTab = 'menu'): ViewMount {
  return ({ main, client, navigate }: ViewContext) => {
    let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
    let menu: MenuRow | null = null;
    let services: ServiceRow[] = [];
    let items: ItemRow[] = [];
    let recipes: RecipeRow[] = [];
    let recipeLines: Mirror<RecipeIngredient>[] = [];
    let ingredients: Mirror<Ingredient>[] = [];
    let equipment: Mirror<Equipment>[] = [];
    let needs: Mirror<RecipeEquipment>[] = [];
    let menuGraph: MenuGraph = { services: [], items: [], recipes: [], recipe_ingredients: [], ingredients: [] };
    let sheet: Sheet | null = null;
    let busy = false;
    // Listas reordenables del constructor (kit): servicios de cada día y, dentro, platos de cada servicio.
    // Se conservan entre repintados y se actualizan con `setItems`: así cada movimiento lleva revisiones al día y no se pierde el foco.
    const dayLists = new Map<string, Sortable<ServiceRow>>();
    const dishLists = new Map<string, Sortable<ItemRow>>();
    const listSigs = new Map<string, string>();
    let builderShape = '';
    let cook = false; // vista de cocinero: cada plato con sus ingredientes escalados, maquinaria y elaboración
    let unmountTab: (() => void) | null = null;
    const canWrite = () => client.bootstrap()?.membership.role !== 'reader';
    const event = () => snapshot.events.find((e) => e.event_id === menu?.event_id) ?? null;
    const locked = () => !menu || LOCKED_MENU_STATUSES.includes(menu.status) || !canWrite();

    const head = el('div', { class: 'pagehead' });
    const banner = el('div', { id: 'menuStale' });
    const restrictionsHost = el('section', { class: 'restrictions card', id: 'menuRestrictions' });
    const builder = el('div', { class: 'menubuilder', id: 'menuBuilder' });
    const costHost = el('section', { class: 'card menucost', id: 'menuCost', hidden: true });
    let purchases: PurchasesSnapshot = { purchases: [], prices: new Map(), fetchedAt: null };
    const actions = el('div', { class: 'btnrow menuactions', id: 'menuActions' });
    const cookToggle = el('button', { class: 'linkbtn', type: 'button', id: 'cookView', 'aria-pressed': 'false',
      onclick: () => { cook = !cook; cookToggle.setAttribute('aria-pressed', String(cook)); cookToggle.textContent = cook ? 'Volver al constructor' : 'Vista de cocinero'; paintBuilder(); } }, 'Vista de cocinero');
    const tabs = el('nav', { class: 'segmented menutabs', 'aria-label': 'Secciones del menú' }, ...TABS.map(([value, label]) => {
      const hash = `#/menus/${menuId}${value === 'menu' ? '' : `/${value}`}`;
      return el('a', { href: hash, 'data-tab': value, 'aria-current': value === tab ? 'page' : 'false', onclick: (e: Event) => { e.preventDefault(); navigate(hash); } }, label);
    }));
    const tabHost = el('div', { id: 'menuTab' });
    replace(main, head, banner, restrictionsHost, tabs, tab === 'menu' ? el('div', null, actions, el('div', { class: 'btnrow' }, cookToggle), costHost, builder) : tabHost);

    const graph = (): MenuGraph => menuGraph;
    const warnings = (): MenuWarning[] => { const e = event(); return e ? menuWarnings(e, graph()) : []; };

    async function commitSafely(operations: RowOperation[]): Promise<boolean> {
      const issue = validateOperations(operations);
      if (issue) { toast(issue.message); return false; }
      try {
        await client.commit(operations);
        await load();
        return true;
      } catch (error) {
        toast(describeError(error));
        return false;
      }
    }

    /** Acción de servidor: solo con red; al terminar refresca eventos y espejo. */
    async function call(procedure: string, args: Record<string, unknown>, okMessage: string): Promise<boolean> {
      if (busy) return false;
      busy = true;
      paintActions();
      try {
        await runCall(client, procedure, args);
        toast(okMessage);
        return true;
      } catch (error) {
        toast(describeError(error));
        if ((error as { code?: string }).code === 'EVENT_CHANGED') await refreshEvents(client, true);
        return false;
      } finally {
        busy = false;
        await load();
      }
    }

    // --- Cabecera, aviso de evento cambiado y restricciones ---------------------------------
    function paintHead(): void {
      const e = event();
      replace(head, el('div', null,
        el('p', { class: 'crumb' }, el('a', { href: '#/menus', onclick: (ev: Event) => { ev.preventDefault(); navigate('#/menus'); } }, '← Menús')),
        el('h2', null, e?.title ?? 'Menú'),
        el('p', null, e ? `${dateRange(e)} · ${guestsLabel(e)} · ${mealPlanLabel(e.meal_plan)}` : 'Los datos del evento no están en este dispositivo todavía.'),
        el('div', { class: 'chips', style: 'margin-top:8px' },
          menu ? el('span', { class: menu.status === 'validado' || menu.status === 'cerrado' ? 'chip ok' : 'chip', id: 'menuStatus' }, MENU_STATUS_LABELS[menu.status]) : null,
          menu?._pending ? el('span', { class: 'chip pending' }, el('span', null, 'Pendiente de sincronizar')) : null),
      ));
    }

    function paintBanner(): void {
      const e = event();
      if (!menu || !e || !isMenuStale(menu, e)) { replace(banner); return; }
      const changes = eventChanges(menu.source_event_snapshot, e).map(changeText);
      const isLocked = LOCKED_MENU_STATUSES.includes(menu.status);
      replace(banner, el('div', { class: 'banner warn notice', role: 'status' },
        el('div', null,
          el('strong', null, 'La información del evento ha cambiado.'), ' Revisar antes de validar.',
          changes.length ? el('ul', { class: 'plainlist' }, ...changes.map((c) => el('li', null, c))) : null),
        canWrite() ? el('div', { class: 'btnrow' },
          isLocked
            ? el('button', { class: 'ghost', type: 'button', id: 'revalidate', disabled: busy, onclick: () => void validate() }, 'Sigue siendo válido')
            : el('button', { class: 'ghost', type: 'button', id: 'acknowledgeEvent', disabled: busy,
                onclick: () => void call(FOOD_PROCEDURES.acknowledgeEvent, { menu_id: menu!.id, expectedRevision: menu!.revision, event_revision: e.event_revision, event_snapshot: eventSnapshot(e) }, 'Cambios del evento revisados.') },
                'He revisado los cambios'),
          menu.status === 'validado' ? el('button', { class: 'ghost', type: 'button', id: 'reopenStale', disabled: busy, onclick: () => void setStatus('revisar', 'Menú reabierto.') }, 'Reabrir para cambiar') : null,
        ) : null,
      ));
    }

    function paintRestrictions(): void {
      const e = event();
      const list = sortedRestrictions(e?.dietary_restrictions);
      const found = warnings();
      replace(restrictionsHost,
        el('h3', null, icon('warn', 18), ' Restricciones'),
        list.length ? el('ul', { class: 'plainlist' }, ...list.map((r) => el('li', { class: r.type === 'alergia' || r.type === 'intolerancia' ? 'warnline' : '' }, restrictionLabel(r))))
          : el('p', { class: 'muted' }, e ? 'Ninguna comunicada.' : '—'),
        found.length ? el('ul', { class: 'warninglist', id: 'menuWarnings' }, ...found.map((w) =>
          el('li', { class: w.requiresAck ? 'warnline' : 'muted' }, w.text))) : null,
      );
    }

    // --- Estados ----------------------------------------------------------------------------
    const setStatus = (status: Menu['status'], okMessage: string) =>
      call(FOOD_PROCEDURES.setMenuStatus, { menu_id: menu!.id, expectedRevision: menu!.revision, status }, okMessage);

    function paintActions(): void {
      if (!menu || !canWrite()) { replace(actions); return; }
      const button = (id: string, label: string, kind: 'primary' | 'ghost', onclick: () => void) => el('button', { class: kind, type: 'button', id, disabled: busy, onclick }, label);
      const validateButton = button('validateMenu', 'Validar', 'primary', () => void validate());
      const byStatus: Record<Menu['status'], HTMLElement[]> = {
        borrador: [button('toReview', 'Pasar a revisar', 'ghost', () => void setStatus('revisar', 'Menú listo para revisar.')), validateButton],
        revisar: [button('toDraft', 'Volver a borrador', 'ghost', () => void setStatus('borrador', 'Menú de nuevo en borrador.')), validateButton],
        validado: [button('reopenMenu', 'Reabrir para cambiar', 'ghost', () => void setStatus('revisar', 'Menú reabierto.')), button('closeMenu', 'Cerrar menú', 'ghost', () => void setStatus('cerrado', 'Menú cerrado.'))],
        cerrado: [button('uncloseMenu', 'Volver a validado', 'ghost', () => void setStatus('validado', 'Menú de nuevo en validado.'))],
      };
      replace(actions, ...byStatus[menu.status],
        menu.status === 'borrador' || menu.status === 'revisar' ? el('button', { class: 'linkbtn', type: 'button', id: 'deleteMenu', disabled: busy, onclick: () => void deleteMenu() }, 'Borrar menú') : null,
        el('span', { class: 'hint' }, 'Validar y cambiar de estado necesitan conexión.'));
    }

    /** Validar: con los datos del evento recién leídos y aceptando uno a uno los avisos que lo exigen. */
    async function validate(): Promise<void> {
      if (!menu) return;
      if (!navigator.onLine) { toast(describeError({ code: 'OFFLINE' })); return; }
      await refreshEvents(client, true);
      const e = event();
      if (!e) { toast(describeError({ code: 'EVENT_NOT_FOUND' })); return; }
      paintBanner(); paintRestrictions();
      const required = menuWarnings(e, graph()).filter((w) => w.requiresAck);
      const send = () => call(FOOD_PROCEDURES.validateMenu, {
        menu_id: menu!.id, expectedRevision: menu!.revision, event_revision: e.event_revision, event_snapshot: eventSnapshot(e),
        acknowledged: required.map((w) => ({ key: w.key, kind: w.kind, text: w.text })),
      }, 'Menú validado.');
      if (required.length === 0) { await send(); return; }

      const boxes = required.map((w, index) => {
        const box = el('input', { type: 'checkbox', id: `ack-${index}`, onchange: () => { confirm.disabled = !boxes.every((b) => b.box.checked); } });
        return { box, node: el('label', { class: 'checkline ackline', for: box.id }, box, el('span', null, w.text)) };
      });
      const confirm = el('button', { class: 'primary', type: 'button', id: 'confirmValidate', disabled: true,
        onclick: async () => { await sheet?.close(true); await send(); } }, 'Validar menú');
      sheet = openSheet({
        title: 'Antes de validar',
        body: el('div', null,
          el('p', null, 'Hay avisos de restricciones. Marca cada uno para confirmar que lo has tenido en cuenta; quedará anotado en el menú.'),
          el('div', { id: 'ackList' }, ...boxes.map((b) => b.node))),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), confirm],
        onClose: () => { sheet = null; },
      });
    }

    async function deleteMenu(): Promise<void> {
      if (!menu) return;
      if (!(await confirmDialog({ title: '¿Borrar este menú?', text: 'Se va a la papelera con sus servicios y sus platos. El evento queda libre para otro menú.', confirmLabel: 'Borrar menú', danger: true }))) return;
      const live = services.map((s) => s.id);
      const ok = await commitSafely([
        ...items.filter((i) => live.includes(i.service_id)).map((i) => removeOp(T.menuItems, i)),
        ...services.map((s) => removeOp(T.menuServices, s)),
        removeOp(T.menus, menu),
      ]);
      if (ok) navigate('#/menus');
    }

    /** Guarda un orden completo: `position` 1, 2, 3… y solo se envían las filas cuya posición cambia. */
    async function reorder<R extends SyncedRow & { position: number }>(table: (typeof T)[keyof typeof T], ordered: R[]): Promise<void> {
      const operations = ordered
        .map((row, i): RowOperation | null => (Number(row.position) === i + 1 ? null : { op: 'update', table, id: row.id, expectedRevision: row.revision, fields: { position: i + 1 } }))
        .filter((op): op is RowOperation => op !== null);
      if (operations.length) await commitSafely(operations);
    }

    // --- Constructor por días ---------------------------------------------------------------
    const rowSig = (rows: Array<SyncedRow & { position: number; _pending?: boolean }>) => rows.map((r) => `${r.id}:${r.revision}:${r.position}:${r._pending ? 1 : 0}`).join(',');
    const sortServices = (rows: ServiceRow[]) => [...rows].sort((a, b) => a.service_date.localeCompare(b.service_date) || Number(a.position) - Number(b.position) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99'));
    const dishesOf = (service: ServiceRow) => items.filter((i) => i.service_id === service.id).sort((a, b) => Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
    const editable = () => !locked() && !cook;
    const recipeOf = (item: ItemRow) => recipes.find((r) => r.id === item.recipe_id);
    const dropLists = () => {
      for (const list of [...dayLists.values(), ...dishLists.values()]) list.destroy();
      dayLists.clear(); dishLists.clear(); listSigs.clear();
    };

    /** Lo que el cocinero necesita de un plato: cantidades para sus raciones, alérgenos, maquinaria y elaboración. */
    function cookDetails(item: ItemRow): HTMLElement | null {
      const recipe = recipeOf(item);
      if (!recipe) return null;
      const names = new Map(ingredients.map((i) => [i.id, i.name]));
      const machines = new Map(equipment.map((m) => [m.id, m]));
      const scaled = scaledIngredients(graph(), item.id);
      const required = needs.filter((n) => n.recipe_id === recipe.id && !n.deleted_at);
      return el('div', { class: 'cookdetails' },
        scaled.length ? el('table', { class: 'ingredients' }, el('tbody', null, ...scaled.map((line) => el('tr', null,
          el('td', null, names.get(line.ingredient_id) ?? '—'), el('td', { class: 'num' }, formatQuantity(line.quantity)), el('td', null, UNIT_LABELS[line.unit])))))
          : el('p', { class: 'muted' }, 'La receta no tiene ingredientes.'),
        recipe.allergens.length ? el('p', { class: 'warnline' }, `Alérgenos: ${recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ')}`) : null,
        required.length ? el('p', null, el('strong', null, 'Maquinaria: '), required.map((n) => `${n.quantity_required} × ${machines.get(n.equipment_id)?.name ?? 'máquina retirada'}`).join(', ')) : null,
        recipe.method ? el('p', { class: 'pre' }, recipe.method) : null,
        recipe.service_notes ? el('p', null, el('strong', null, 'Servicio: '), recipe.service_notes) : null,
        purchases.fetchedAt ? costLine(item) : null);
    }

    const euros = (n: number) => n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR' });

    /** Coste estimado del plato en la vista de cocinero, con aviso si a algún ingrediente le falta precio. */
    function costLine(item: ItemRow): HTMLElement {
      const cost = dishCost(graph(), item.id, purchases.prices);
      const per = Number(item.servings) > 0 ? cost.amount / Number(item.servings) : 0;
      return el('p', { class: 'dishcost' }, el('strong', null, 'Coste estimado: '), `${euros(cost.amount)} (${euros(per)} por ración)`,
        cost.missing.length ? el('span', { class: 'muted' }, ` · sin precio: ${cost.missing.map((id) => ingredients.find((i) => i.id === id)?.name ?? '—').join(', ')}`) : null,
        cost.stale.length ? el('span', { class: 'muted' }, ` · ${staleText(cost.stale, item)}`) : null);
    }

    /** «precio de la última compra: Arroz (20 jun)»: ingredientes sin compras en los últimos tres meses. */
    function staleText(ids: string[], item?: ItemRow): string {
      const unitOf = (id: string) => (item ? recipeLines.find((l) => l.recipe_id === item.recipe_id && l.ingredient_id === id)?.unit : undefined) ?? recipeLines.find((l) => l.ingredient_id === id)?.unit ?? 'kg';
      const date = (id: string) => { const d = priceFor(id, unitOf(id), purchases.prices)?.lastDate; return d ? ` (${formatDate(d).replace(/,.*$/, '')})` : ''; };
      return `precio de la última compra, de hace más de 3 meses: ${ids.map((id) => `${ingredients.find((i) => i.id === id)?.name ?? '—'}${date(id)}`).join(', ')}`;
    }

    /** Coste estimado del menú con las compras reales de Invoices: total, por persona y por servicio. */
    function paintCost(): void {
      if (!purchases.fetchedAt || items.length === 0) { costHost.hidden = true; return; }
      const costs = serviceCosts(graph(), purchases.prices);
      const total = costs.reduce((sum, c) => sum + c.amount, 0);
      const missing = new Set(costs.flatMap((c) => c.missing));
      const stale = new Set(costs.flatMap((c) => c.stale));
      const people = event()?.guest_count ?? 0;
      const byId = new Map(services.map((s) => [s.id, s]));
      costHost.hidden = false;
      replace(costHost,
        el('h3', null, 'Coste estimado'),
        el('p', { class: 'muted' }, people > 0 ? `${euros(total / people)} por persona · ` : '', `media de las compras de los últimos 3 meses registradas en Invoices (datos de ${formatDate(purchases.fetchedAt)}).`),
        renderMoneyBreakdown({
          totalLabel: 'Total del menú',
          format: euros,
          sort: false,
          emptyText: 'Ningún plato tiene todavía ingredientes con precio.',
          lines: costs.filter((c) => byId.has(c.service_id)).map((c) => {
            const s = byId.get(c.service_id)!;
            return { id: c.service_id, label: `${SERVICE_LABELS[s.service_type]} · ${longDay(s.service_date)}`, amount: c.amount,
              meta: c.servings > 0 ? `${euros(c.amount / c.servings)} por ración` : undefined };
          }),
        }),
        stale.size ? el('p', { class: 'warnline costmissing' }, `${staleText([...stale]).replace(/^p/, 'P')}.`) : null,
        missing.size ? el('p', { class: 'warnline costmissing' }, `Sin precio (no hay compras con unidad compatible): ${[...missing].map((id) => ingredients.find((i) => i.id === id)?.name ?? '—').join(', ')}. El coste real será mayor.`) : null,
      );
    }

    function dishRow(item: ItemRow): HTMLElement {
      const recipe = recipeOf(item);
      const canEdit = editable();
      const img = el('img', { alt: '', hidden: true });
      if (recipe) showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
      const servings = el('input', { type: 'text', inputmode: 'decimal', class: 'servings compact', value: formatQuantity(item.servings), 'aria-label': `Raciones de ${recipe?.name ?? 'plato'}`, disabled: !canEdit,
        onchange: async () => {
          const value = parseQuantity(servings.value);
          if (value === null || value <= 0) { toast('Las raciones deben ser un número mayor que cero.'); servings.value = formatQuantity(item.servings); return; }
          if (value !== Number(item.servings)) await commitSafely([{ op: 'update', table: T.menuItems, id: item.id, expectedRevision: item.revision, fields: { servings: value } }]);
        } });
      return el('div', { class: 'dish', 'data-id': item.id, 'data-pending': String(item._pending === true) },
        el('span', { class: 'dishphoto' }, icon('chef', 20), img),
        el('span', { class: 'dishname' }, el('strong', null, recipe?.name ?? 'Receta retirada'),
          recipe ? el('span', { class: 'recipemeta' }, [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ')) : null),
        el('span', { class: 'dishside' }, servings, el('span', { class: 'muted' }, 'rac.'),
          canEdit ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${recipe?.name ?? 'plato'}`, onclick: () => void commitSafely([removeOp(T.menuItems, item)]) }, icon('close', 18)) : null),
        cook ? cookDetails(item) : null,
      );
    }

    /** Platos de un servicio. Con el constructor abierto y más de uno: lista del kit con arrastre, teclado y subir/bajar. */
    function dishList(service: ServiceRow, dishes: ItemRow[]): HTMLElement {
      if (!editable() || dishes.length < 2) return el('ul', { class: 'dishes' }, ...dishes.map((dish) => el('li', null, dishRow(dish))));
      const key = `s:${service.id}`;
      let list = dishLists.get(service.id);
      if (!list) {
        list = createSortableList<ItemRow>({
          items: dishes,
          key: (dish) => dish.id,
          name: (dish) => recipeOf(dish)?.name ?? 'plato',
          label: `Platos de ${SERVICE_LABELS[service.service_type]}`,
          rowClass: 'dishrow',
          render: (dish) => dishRow(dish),
          onReorder: (ordered) => reorder(T.menuItems, ordered),
        });
        dishLists.set(service.id, list);
      } else if (listSigs.get(key) !== rowSig(dishes)) {
        list.setItems(dishes);
      }
      listSigs.set(key, rowSig(dishes));
      return list.element;
    }

    function serviceBlock(service: ServiceRow): HTMLElement {
      const canEdit = editable();
      const label = SERVICE_LABELS[service.service_type];
      const dishes = dishesOf(service);
      const time = el('input', { type: 'time', class: 'compact', value: shortTime(service.service_time), 'aria-label': `Hora de ${label}`, disabled: !canEdit,
        onchange: () => void commitSafely([{ op: 'update', table: T.menuServices, id: service.id, expectedRevision: service.revision, fields: { service_time: time.value || null } }]) });
      return el('section', { class: 'service', 'data-id': service.id, 'data-type': service.service_type },
        el('header', null, el('h4', null, label), time,
          canEdit ? el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${label}`,
            onclick: async () => {
              if (dishes.length && !(await confirmDialog({ title: `¿Quitar ${label.toLowerCase()}?`, text: `Se quitan también sus ${dishes.length} platos.`, confirmLabel: 'Quitar', danger: true }))) return;
              await commitSafely([...dishes.map((d) => removeOp(T.menuItems, d)), removeOp(T.menuServices, service)]);
            } }, icon('trash', 18)) : null),
        dishes.length ? dishList(service, dishes) : el('p', { class: 'muted' }, 'Sin platos todavía.'),
        canEdit ? el('button', { class: 'ghost addDish', type: 'button', onclick: () => pickRecipe(service, Math.max(0, ...dishesOf(service).map((d) => Number(d.position)))) }, icon('plus', 18), 'Añadir plato') : null,
      );
    }

    /** Servicios de un día. Con más de uno y el constructor abierto: lista del kit (los platos van anidados dentro). */
    function serviceList(day: string, ofDay: ServiceRow[]): HTMLElement | null {
      if (ofDay.length === 0) return el('p', { class: 'muted' }, 'Sin servicios este día.');
      if (!editable() || ofDay.length < 2) return el('div', null, ...ofDay.map(serviceBlock));
      const list = createSortableList<ServiceRow>({
        items: ofDay,
        key: (service) => service.id,
        name: (service) => SERVICE_LABELS[service.service_type],
        label: `Servicios del ${longDay(day)}`,
        rowClass: 'servicerow',
        render: (service) => serviceBlock(service),
        onReorder: (ordered) => reorder(T.menuServices, ordered),
      });
      dayLists.set(day, list);
      listSigs.set(`d:${day}`, rowSig(ofDay));
      return list.element;
    }

    function paintBuilder(): void {
      const e = event();
      const canEdit = editable();
      const sorted = sortServices(services);
      const days = Array.from(new Set([...(e ? eventDays(e) : []), ...sorted.map((s) => s.service_date)])).sort();
      const used = new Set(items.map((i) => i.recipe_id));
      // Todo lo que obliga a rehacer el constructor entero. Lo que no está aquí (orden y datos de las filas de una lista) se actualiza en su lista.
      const shape = JSON.stringify({
        canEdit, cook, days, guests: e?.guest_count ?? null,
        recipes: recipes.filter((r) => used.has(r.id)).map((r) => `${r.id}:${r.revision}`).sort(),
        services: days.map((day) => {
          const ofDay = sorted.filter((s) => s.service_date === day);
          return [ofDay.length > 1 ? ofDay.map((s) => s.id).sort() : rowSig(ofDay), ofDay.map((service) => {
            const dishes = dishesOf(service);
            return dishes.length > 1 ? dishes.map((d) => d.id).sort() : rowSig(dishes);
          })];
        }),
      });

      if (canEdit && shape === builderShape) {
        // Misma estructura: solo han cambiado filas de alguna lista (orden, raciones, hora). Se actualizan en su sitio.
        for (const [day, list] of dayLists) {
          const ofDay = sorted.filter((s) => s.service_date === day);
          if (listSigs.get(`d:${day}`) !== rowSig(ofDay)) { listSigs.set(`d:${day}`, rowSig(ofDay)); list.setItems(ofDay); }
        }
        for (const [serviceId, list] of dishLists) {
          const service = services.find((sv) => sv.id === serviceId);
          const dishes = service ? dishesOf(service) : [];
          if (listSigs.get(`s:${serviceId}`) !== rowSig(dishes)) { listSigs.set(`s:${serviceId}`, rowSig(dishes)); list.setItems(dishes); }
        }
        return;
      }

      dropLists();
      builderShape = shape;
      replace(builder, ...days.map((day) => {
        const ofDay = sorted.filter((s) => s.service_date === day);
        return el('section', { class: 'menuday', 'data-day': day },
          el('h3', null, longDay(day)),
          serviceList(day, ofDay),
          canEdit ? el('button', { class: 'linkbtn addService', type: 'button', onclick: () => addService(day, Math.max(0, ...services.filter((sv) => sv.service_date === day).map((sv) => Number(sv.position)))) }, icon('plus', 18), 'Añadir servicio') : null,
        );
      }));
    }

    function addService(day: string, count: number): void {
      const type = el('select', { id: 's-type' }, ...SERVICE_TYPES.map((t) => el('option', { value: t }, SERVICE_LABELS[t])));
      const time = el('input', { id: 's-time', type: 'time' });
      sheet = openSheet({
        title: `Nuevo servicio · ${longDay(day)}`,
        body: el('div', null, el('label', { class: 'field' }, el('span', null, 'Servicio'), type), el('label', { class: 'field' }, el('span', null, 'Hora'), time)),
        foot: [el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'),
          el('button', { class: 'primary', type: 'button', id: 'saveService', onclick: async () => {
            const ok = await commitSafely([{ op: 'insert', table: T.menuServices, id: crypto.randomUUID(),
              fields: { menu_id: menuId, service_date: day, service_type: type.value, service_time: time.value || null, position: count + 1 } }]);
            if (ok) await sheet?.close(true);
          } }, 'Añadir')],
        onClose: () => { sheet = null; },
      });
    }

    /** Selector de plato: el recetario visual, con las raciones del evento por defecto. */
    function pickRecipe(service: ServiceRow, count: number): void {
      const search = el('input', { type: 'search', placeholder: 'Buscar receta', 'aria-label': 'Buscar receta', autocomplete: 'off', oninput: () => fill() });
      const grid = el('ul', { class: 'recipegrid picker', id: 'recipePicker' });
      const servings = event()?.guest_count ?? 1;
      function fill(): void {
        const query = search.value.trim().toLowerCase();
        const options = recipes.filter((r) => !r.deleted_at && r.status !== 'archivada' && (!query || r.name.toLowerCase().includes(query))).sort((a, b) => a.name.localeCompare(b.name, 'es'));
        replace(grid, ...options.map((recipe) => {
          const img = el('img', { alt: '', loading: 'lazy', hidden: true });
          showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
          return el('li', null, el('button', { class: 'recipecard', type: 'button', 'aria-label': `Añadir ${recipe.name}`,
            onclick: async () => {
              const ok = await commitSafely([{ op: 'insert', table: T.menuItems, id: crypto.randomUUID(), fields: { service_id: service.id, recipe_id: recipe.id, servings, position: count + 1 } }]);
              if (ok) await sheet?.close(true);
            } },
            el('span', { class: 'recipephoto' }, icon('chef', 30), img),
            el('span', { class: 'recipebody' }, el('strong', null, recipe.name),
              el('span', { class: 'recipemeta' }, [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ')),
              recipe.status === 'en_prueba' ? el('span', { class: 'chips' }, el('span', { class: 'chip' }, 'En prueba')) : null)));
        }));
        if (options.length === 0) replace(grid, el('li', { class: 'muted' }, 'No hay recetas que coincidan. Créalas en el Recetario.'));
      }
      fill();
      sheet = openSheet({
        title: `Añadir plato · ${SERVICE_LABELS[service.service_type]}`,
        meta: `${formatQuantity(servings)} raciones por defecto; se pueden cambiar después.`,
        body: el('div', null, el('div', { class: 'toolbar' }, el('div', { class: 'search' }, search)), grid),
        initialFocus: search,
        onClose: () => { sheet = null; },
      });
    }

    function paintActionsAndRest(): void {
      paintHead(); paintBanner(); paintRestrictions();
      if (tab === 'menu') { paintActions(); paintBuilder(); paintCost(); return; }
      if (!unmountTab) {
        const context = { client, menuId, host: tabHost, canWrite };
        unmountTab = tab === 'compra' ? mountShopping(context) : tab === 'preparacion' ? mountPreparation(context) : tab === 'organizador' ? mountOrganizer(context) : mountClosing(context);
      }
    }

    async function load(): Promise<void> {
      const data = await loadMenuData(client, menuId);
      if (!data.menu) {
        menu = null;
        unmountTab?.();
        unmountTab = null;
        replace(main, el('div', { class: 'empty' }, el('strong', null, 'Este menú no existe o está en la papelera'),
          el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost', type: 'button', onclick: () => navigate('#/menus') }, 'Volver a Menús'))));
        return;
      }
      menu = data.menu;
      ({ services, items, recipes, ingredients, equipment, needs } = data);
      recipeLines = data.lines;
      menuGraph = data.graph;
      if (tab === 'menu') void loadPurchases(client).then((next) => { const changed = next.fetchedAt !== purchases.fetchedAt; purchases = next; if (changed) { builderShape = ''; paintActionsAndRest(); } });
      paintActionsAndRest();
    }

    void load();
    const offEvents = watchEvents(client, (next) => { snapshot = next; if (menu) paintActionsAndRest(); });
    const offs = [T.menus, T.menuServices, T.menuItems, T.recipes].map((table) => client.onTable(table, () => { if (!sheet) void load(); }));
    const offStatus = client.onStatus(() => void refreshEvents(client));
    return () => {
      offEvents();
      offs.forEach((off) => off());
      offStatus();
      unmountTab?.();
      dropLists();
      void closeSheet(true);
    };
  };
}
