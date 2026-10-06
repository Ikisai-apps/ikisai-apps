import type { RowOperation, SyncedRow } from '@ikisai/sync-client';
import {
  FOOD_PROCEDURES, LOCKED_MENU_STATUSES, SERVICE_TYPES, eventChanges, eventSnapshot, isMenuStale, menuWarnings, scaledIngredients, validateOperations,
  type Equipment, type EventChange, type FoodEvent, type Ingredient, type Menu, type MenuGraph, type MenuItem, type MenuService, type MenuWarning, type RecipeEquipment,
  type RecipeIngredient,
} from '@ikisai/domain-food';
import { closeSheet, confirmDialog, el, icon, listRow, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { runCall } from '../app/calls.ts';
import { ALLERGEN_LABELS, CATEGORY_LABELS, DIET_LABELS, T, UNIT_LABELS, describeError, formatQuantity, parseQuantity, type Mirror } from '../app/client.ts';
import {
  dateRange, eventDays, guestsLabel, longDay, mealPlanLabel, refreshEvents, restrictionLabel, shortTime, sortedRestrictions, watchEvents, type EventsSnapshot,
} from '../app/events.ts';
import { loadMenuData, type RecipeRow } from '../app/menu-data.ts';
import { showPhoto } from '../app/photos.ts';
import { mountClosing } from './menu-closing.ts';
import { mountPreparation } from './menu-preparation.ts';
import { mountShopping } from './menu-shopping.ts';
import { MENU_STATUS_LABELS, SERVICE_LABELS, menuChip } from './events.ts';
import type { ViewContext, ViewMount } from './shell.ts';

type MenuRow = Mirror<Menu>;
type ServiceRow = Mirror<MenuService>;
type ItemRow = Mirror<MenuItem>;

export type MenuTab = 'menu' | 'compra' | 'preparacion' | 'cierre';
const TABS: Array<[MenuTab, string]> = [['menu', 'Menú'], ['compra', 'Compra'], ['preparacion', 'Preparación'], ['cierre', 'Cierre']];

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

/** Ficha de un menú: cabecera con el evento y sus restricciones siempre a la vista, y pestañas Menú · Compra · Preparación · Cierre. */
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
    let cook = false; // vista de cocinero: cada plato con sus ingredientes escalados, maquinaria y elaboración
    let unmountTab: (() => void) | null = null;
    const canWrite = () => client.bootstrap()?.membership.role !== 'reader';
    const event = () => snapshot.events.find((e) => e.event_id === menu?.event_id) ?? null;
    const locked = () => !menu || LOCKED_MENU_STATUSES.includes(menu.status) || !canWrite();

    const head = el('div', { class: 'pagehead' });
    const banner = el('div', { id: 'menuStale' });
    const restrictionsHost = el('section', { class: 'restrictions card', id: 'menuRestrictions' });
    const builder = el('div', { class: 'menubuilder', id: 'menuBuilder' });
    const actions = el('div', { class: 'btnrow menuactions', id: 'menuActions' });
    const cookToggle = el('button', { class: 'linkbtn', type: 'button', id: 'cookView', 'aria-pressed': 'false',
      onclick: () => { cook = !cook; cookToggle.setAttribute('aria-pressed', String(cook)); cookToggle.textContent = cook ? 'Volver al constructor' : 'Vista de cocinero'; paintBuilder(); } }, 'Vista de cocinero');
    const tabs = el('nav', { class: 'segmented menutabs', 'aria-label': 'Secciones del menú' }, ...TABS.map(([value, label]) => {
      const hash = `#/menus/${menuId}${value === 'menu' ? '' : `/${value}`}`;
      return el('a', { href: hash, 'data-tab': value, 'aria-current': value === tab ? 'page' : 'false', onclick: (e: Event) => { e.preventDefault(); navigate(hash); } }, label);
    }));
    const tabHost = el('div', { id: 'menuTab' });
    replace(main, head, banner, restrictionsHost, tabs, tab === 'menu' ? el('div', null, actions, el('div', { class: 'btnrow' }, cookToggle), builder) : tabHost);

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
      replace(banner, el('div', { class: 'banner warn', role: 'status' },
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

    // --- Constructor por días ---------------------------------------------------------------
    function paintBuilder(): void {
      const e = event();
      const isLocked = locked() || cook;
      const recipeById = new Map(recipes.map((r) => [r.id, r]));
      const ingredientNames = new Map(ingredients.map((i) => [i.id, i.name]));
      const machines = new Map(equipment.map((m) => [m.id, m]));

      /** Lo que el cocinero necesita de un plato: cantidades para sus raciones, alérgenos, maquinaria y elaboración. */
      const cookDetails = (item: ItemRow): HTMLElement | null => {
        const recipe = recipeById.get(item.recipe_id);
        if (!recipe) return null;
        const scaled = scaledIngredients(graph(), item.id);
        const required = needs.filter((n) => n.recipe_id === recipe.id && !n.deleted_at);
        return el('div', { class: 'cookdetails' },
          scaled.length ? el('table', { class: 'ingredients' }, el('tbody', null, ...scaled.map((line) => el('tr', null,
            el('td', null, ingredientNames.get(line.ingredient_id) ?? '—'), el('td', { class: 'num' }, formatQuantity(line.quantity)), el('td', null, UNIT_LABELS[line.unit])))))
            : el('p', { class: 'muted' }, 'La receta no tiene ingredientes.'),
          recipe.allergens.length ? el('p', { class: 'warnline' }, `Alérgenos: ${recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ')}`) : null,
          required.length ? el('p', null, el('strong', null, 'Maquinaria: '), required.map((n) => `${n.quantity_required} × ${machines.get(n.equipment_id)?.name ?? 'máquina retirada'}`).join(', ')) : null,
          recipe.method ? el('p', { class: 'pre' }, recipe.method) : null,
          recipe.service_notes ? el('p', null, el('strong', null, 'Servicio: '), recipe.service_notes) : null);
      };
      const sorted = [...services].sort((a, b) => a.service_date.localeCompare(b.service_date) || (a.service_time ?? '99').localeCompare(b.service_time ?? '99') || Number(a.position) - Number(b.position));
      const days = Array.from(new Set([...(e ? eventDays(e) : []), ...sorted.map((s) => s.service_date)])).sort();

      const dishRow = (item: ItemRow): HTMLElement => {
        const recipe = recipeById.get(item.recipe_id);
        const img = el('img', { alt: '', hidden: true });
        if (recipe) showPhoto(client, img, recipe.photo_thumb_file_id ?? recipe.photo_file_id);
        const servings = el('input', { type: 'text', inputmode: 'decimal', class: 'servings', value: formatQuantity(item.servings), 'aria-label': `Raciones de ${recipe?.name ?? 'plato'}`, disabled: isLocked,
          onchange: async () => {
            const value = parseQuantity(servings.value);
            if (value === null || value <= 0) { toast('Las raciones deben ser un número mayor que cero.'); servings.value = formatQuantity(item.servings); return; }
            if (value !== Number(item.servings)) await commitSafely([{ op: 'update', table: T.menuItems, id: item.id, expectedRevision: item.revision, fields: { servings: value } }]);
          } });
        return el('li', { class: 'dish', 'data-id': item.id, 'data-pending': String(item._pending === true) },
          el('span', { class: 'dishphoto' }, icon('chef', 20), img),
          el('span', { class: 'dishname' }, el('strong', null, recipe?.name ?? 'Receta retirada'),
            recipe ? el('span', { class: 'recipemeta' }, [CATEGORY_LABELS[recipe.category], ...recipe.diet_tags.map((t) => DIET_LABELS[t])].join(' · ')) : null),
          servings, el('span', { class: 'muted' }, 'rac.'),
          isLocked ? null : el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${recipe?.name ?? 'plato'}`, onclick: () => void commitSafely([removeOp(T.menuItems, item)]) }, icon('close', 18)),
          cook ? cookDetails(item) : null,
        );
      };

      const serviceBlock = (service: ServiceRow): HTMLElement => {
        const dishes = items.filter((i) => i.service_id === service.id).sort((a, b) => Number(a.position) - Number(b.position) || a.created_at.localeCompare(b.created_at));
        const time = el('input', { type: 'time', value: shortTime(service.service_time), 'aria-label': `Hora de ${SERVICE_LABELS[service.service_type]}`, disabled: isLocked,
          onchange: () => void commitSafely([{ op: 'update', table: T.menuServices, id: service.id, expectedRevision: service.revision, fields: { service_time: time.value || null } }]) });
        return el('section', { class: 'service', 'data-id': service.id, 'data-type': service.service_type },
          el('header', null, el('h4', null, SERVICE_LABELS[service.service_type]), time,
            isLocked ? null : el('button', { class: 'iconbtn', type: 'button', 'aria-label': `Quitar ${SERVICE_LABELS[service.service_type]}`,
              onclick: async () => {
                if (dishes.length && !(await confirmDialog({ title: `¿Quitar ${SERVICE_LABELS[service.service_type].toLowerCase()}?`, text: `Se quitan también sus ${dishes.length} platos.`, confirmLabel: 'Quitar', danger: true }))) return;
                await commitSafely([...dishes.map((d) => removeOp(T.menuItems, d)), removeOp(T.menuServices, service)]);
              } }, icon('trash', 18))),
          dishes.length ? el('ul', { class: 'dishes' }, ...dishes.map(dishRow)) : el('p', { class: 'muted' }, 'Sin platos todavía.'),
          isLocked ? null : el('button', { class: 'ghost addDish', type: 'button', onclick: () => pickRecipe(service, dishes.length) }, icon('plus', 18), 'Añadir plato'),
        );
      };

      replace(builder, ...days.map((day) => {
        const ofDay = sorted.filter((s) => s.service_date === day);
        return el('section', { class: 'menuday', 'data-day': day },
          el('h3', null, longDay(day)),
          ...ofDay.map(serviceBlock),
          ofDay.length === 0 ? el('p', { class: 'muted' }, 'Sin servicios este día.') : null,
          isLocked ? null : el('button', { class: 'linkbtn addService', type: 'button', onclick: () => addService(day, ofDay.length) }, icon('plus', 18), 'Añadir servicio'),
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
      if (tab === 'menu') { paintActions(); paintBuilder(); return; }
      if (!unmountTab) {
        const context = { client, menuId, host: tabHost, canWrite };
        unmountTab = tab === 'compra' ? mountShopping(context) : tab === 'preparacion' ? mountPreparation(context) : mountClosing(context);
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
      void closeSheet(true);
    };
  };
}
