/**
 * Cocina (`#/cocina`; tanda 27, MUELA-006 con la composición de 068 §1 «Un día, por servicios»): lo de hoy del retiro en
 * casa, para quien cocina. Arriba el selector de días; debajo, la línea plegable con el retiro, las personas y **todas**
 * las alergias e intolerancias con su número (la grave destacada); las tarjetas de los servicios con sus platos y pasos;
 * el reparto, los pasos sueltos y lo hecho con su consumo. «Pase»: un plato por pantalla, para cocinar a un metro.
 *
 * Seguridad (regla de VG del 19-10-2026): por plato, solo «⚠ lleva…», «Alérgenos sin revisar» (si hay alergias en el
 * grupo) o la preferencia; nunca «apto» ni «✓ sin…». El cruce es el de siempre (`dishNotes`, `crossRestriction`).
 * Escribe lo mismo que Preparación (hecho, responsable, hora) y el consumo con la hoja compartida. Sin datos nuevos.
 */
import {
  dishNotes, isMenuStale, isOverdue, nextStep, restrictionLines, scaledIngredients, serviceConsumption, servicePhases, stepDay, stepService, untilText,
  type Consumption, type DishNotes, type FoodEvent, type Menu, type MenuGraph, type MenuService, type ServicePhase,
} from '@ikisai/domain-food';
import { el, focusFirst, icon, lockScroll, openSheet, renderMedal, replace, toast, trackOverlay, trapFocus, type Sheet } from '@ikisai/ui-kit';
import { ALLERGEN_LABELS, T, UNIT_LABELS, describeError, formatQuantity, type Mirror } from '../app/client.ts';
import { loadInventory, type InventoryData } from '../app/consumption.ts';
import { guestsLabel, longDay, refreshEvents, restrictionLabel, shortTime, sortedRestrictions, todayKey, watchEvents, type EventsSnapshot } from '../app/events.ts';
import { HOUSE_MENU_HASH } from '../app/house.ts';
import { kitchenDays, kitchenMenus, type KitchenMenu } from '../app/kitchen-data.ts';
import { MENU_TABLES, loadMenuData, type MenuData, type RecipeRow } from '../app/menu-data.ts';
import { photoUrl } from '../app/photos.ts';
import { usage } from '../app/usage.ts';
import { openConsumptionSheet } from './consumption-sheet.ts';
import { SERVICE_LABELS } from './events.ts';
import { methodStepsView } from './method-steps.ts';
import { shareText } from './menu-preparation.ts';
import { dayChoiceLabel, daySelector, openMoveSheet, purposeText, stepRow, type PrepRow } from './prep-row.ts';
import type { ViewMount } from './shell.ts';

export const KITCHEN_HASH = '#/cocina';

/** `#/cocina?menu=<id>&dia=<YYYY-MM-DD>`: abre Cocina en ese menú y ese día. */
export const kitchenHash = (menuId?: string | null, day?: string | null) => {
  const params = new URLSearchParams();
  if (menuId) params.set('menu', menuId);
  if (day) params.set('dia', day);
  const query = params.toString();
  return query ? `${KITCHEN_HASH}?${query}` : KITCHEN_HASH;
};

/** Por hora (sin hora, al final) y, a igual hora, por el orden a mano. */
const byTime = (a: PrepRow, b: PrepRow) => (a.scheduled_time ?? '99').localeCompare(b.scheduled_time ?? '99') || Number(a.position) - Number(b.position);

const PHASE_LABEL: Record<ServicePhase, string> = { ahora: 'Ahora', despues: 'Después', hecho: 'Hecho' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** «⚠ lleva frutos de cáscara (pistacho) · 1 persona · alergia grave». */
function allergyText(match: DishNotes['allergies'][number]): string {
  const { restriction, crossing } = match;
  const declared = crossing.declared ? ALLERGEN_LABELS[crossing.declared] : null;
  const what = declared && declared.toLowerCase() !== restriction.subject.toLowerCase() ? `${declared.toLowerCase()} (${restriction.subject})` : restriction.subject;
  return `⚠ lleva ${what} · ${plural(restriction.people, 'persona', 'personas')} · ${restriction.type}${restriction.severe ? ' grave' : ''}`;
}

/** Las marcas de seguridad de un plato, siempre con su texto. Sin coincidencias, nada. */
export function dishSafety(notes: DishNotes | undefined): HTMLElement | null {
  if (!notes) return null;
  const chips = [
    ...notes.allergies.map((m) => el('span', { class: `chip warn fd-allergy${m.restriction.severe ? ' fd-severe' : ''}` }, allergyText(m))),
    notes.unreviewed ? el('span', { class: 'chip fd-unreviewed' }, 'Alérgenos sin revisar') : null,
    ...notes.preferences.map((m) => el('span', { class: 'chip fd-pref' }, `lleva ${m.restriction.subject} · preferencia`)),
  ].filter((c): c is HTMLElement => c !== null);
  return chips.length ? el('span', { class: 'chips fd-safety' }, ...chips) : null;
}

/** El medallón del plato: iniciales al momento y la foto cuando llega (solo las ya descargadas, sin red). */
function dishMedal(client: Parameters<typeof photoUrl>[0], recipe: RecipeRow | undefined, size = 44): HTMLElement {
  const medal = renderMedal({ name: recipe?.name ?? 'Plato', size });
  const ref = recipe ? recipe.photo_thumb_file_id ?? recipe.photo_file_id : null;
  if (ref) void photoUrl(client, ref).then((url) => { if (url && medal.isConnected) medal.replaceWith(renderMedal({ name: recipe?.name ?? 'Plato', image: url, size })); }).catch(() => undefined);
  return medal;
}

export const mountKitchen: ViewMount = ({ main, client, navigate }) => {
  let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
  let menus: Array<Mirror<Menu>> = [];
  let allServices: Array<Mirror<MenuService>> = [];
  let allSteps: PrepRow[] = [];
  let data: MenuData | null = null;
  let inventory: InventoryData | null = null;
  let consumptions: Array<Mirror<Consumption>> = [];
  let sheet: Sheet | null = null;
  let closePass: (() => void) | null = null;
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let menuId: string | null = params.get('menu');
  let day: string = params.get('dia') ?? todayKey();
  const canWrite = () => { const role = client.bootstrap()?.membership.role; return role === 'editor' || role === 'owner'; };
  const host = el('div', { 'data-feedback-id': 'food.cocina.dia', 'data-feedback-label': 'Día de cocina', id: 'kitchenDay' });
  replace(main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Cocina'), el('p', null, 'Lo de cada día, por servicios: platos, alergias y pasos.'))),
    host);

  const graph = (): MenuGraph => data?.graph ?? { services: [], items: [], recipes: [], recipe_ingredients: [], ingredients: [] };
  const choices = (): KitchenMenu[] => kitchenMenus(menus, allServices, snapshot.events, day);
  const chosen = (): KitchenMenu | null => {
    const list = choices();
    return list.find((m) => m.id === menuId) ?? (menuId ? kitchenMenuById(menuId) : null) ?? list[0] ?? null;
  };
  /** Un menú pedido por enlace aunque ese día no esté «en cocina» (se abre igual). */
  function kitchenMenuById(id: string): KitchenMenu | null {
    const menu = menus.find((m) => m.id === id && !m.deleted_at);
    if (!menu) return null;
    const house = kitchenMenus([menu], [], [], '').find((m) => m.house);
    if (house) return house;
    const event = snapshot.events.find((e) => e.event_id === menu.event_id) ?? null;
    return { id: menu.id, house: false, title: event?.title ?? 'Retiro', event };
  }

  async function commitSafely(operations: Parameters<typeof client.commit>[0]): Promise<boolean> {
    try { await client.commit(operations); await load(); return true; } catch (error) { toast(describeError(error)); return false; }
  }

  const steps = () => allSteps.filter((s) => s.menu_id === data?.menu?.id);
  const dayOf = (s: PrepRow) => (data ? stepDay(s, data.items, data.services) : s.scheduled_date);
  const recipeOf = (recipeId: string) => data?.recipes.find((r) => r.id === recipeId);
  const consumptionOf = (service: Mirror<MenuService>) => (inventory?.kitchen.size ? serviceConsumption(service, graph(), consumptions, inventory.movements, new Date()) : null);

  /** La línea plegable: retiro, personas y todas las alergias e intolerancias con su número; al abrirla, la franja completa. */
  function strip(menu: KitchenMenu): HTMLElement {
    if (menu.house) {
      const people = Number(data?.menu?.house_servings ?? 0);
      return el('div', { 'data-feedback-id': 'food.cocina.franja', 'data-feedback-label': 'Grupo', class: 'card fd-strip fd-strip-house' },
        el('strong', null, 'Menú de casa'), people ? ` · ${plural(people, 'persona en casa', 'personas en casa')}` : '');
    }
    const event = menu.event;
    const lines = restrictionLines(event?.dietary_restrictions);
    const all = sortedRestrictions(event?.dietary_restrictions);
    return el('details', { 'data-feedback-id': 'food.cocina.franja', 'data-feedback-label': 'Grupo y alergias', class: 'card fd-strip', id: 'kitchenStrip' },
      el('summary', null,
        el('span', { class: 'fd-strip-title', 'data-feedback-ignore': '' }, el('strong', null, menu.title), event ? ` · ${guestsLabel(event)}` : ''),
        lines.length
          ? el('span', { class: 'fd-strip-allergies', id: 'kitchenAllergies' }, ...lines.map((l) => el(l.severe ? 'strong' : 'span', { class: `fd-line${l.severe ? ' fd-severe' : ''}` },
              `${l.type === 'alergia' ? 'Alergia' : 'Intolerancia'}${l.severe ? ' grave' : ''}: ${l.subject} (${l.people})`)))
          : el('span', { class: 'muted', id: 'kitchenAllergies' }, event ? 'Sin alergias ni intolerancias comunicadas' : 'Los datos del retiro llegan con conexión')),
      el('div', { class: 'fd-strip-body', 'data-feedback-ignore': '' },
        all.length ? el('ul', { class: 'plainlist' }, ...all.map((r) => el('li', { class: r.type === 'alergia' || r.type === 'intolerancia' ? 'warnline' : '' }, restrictionLabel(r))))
          : el('p', { class: 'muted' }, 'Ninguna restricción comunicada.'),
        el('p', null, el('a', { 'data-feedback-id': 'food.cocina.franja.menu', 'data-feedback-label': 'Abrir el menú', href: `#/menus/${menu.id}`, onclick: (e: Event) => { e.preventDefault(); navigate(`#/menus/${menu.id}`); } }, 'Abrir el menú completo'))));
  }

  /** La ficha compacta del plato: cantidades a sus raciones, seguridad y elaboración; «Pase» desde aquí. */
  function openDish(itemId: string, list: string[], notes: Map<string, DishNotes>): void {
    const item = data?.items.find((i) => i.id === itemId);
    const recipe = item && recipeOf(item.recipe_id);
    if (!item || !recipe) return;
    const service = data?.services.find((s) => s.id === item.service_id);
    sheet = openSheet({
      title: recipe.name,
      meta: [`${formatQuantity(item.servings)} raciones`, service ? `${SERVICE_LABELS[service.service_type]} · ${shortTime(service.service_time)}` : null].filter(Boolean).join(' · '),
      body: el('div', { 'data-feedback-id': 'food.cocina.plato', 'data-feedback-label': 'Ficha del plato', class: 'fd-dishsheet' }, ...dishBody(item.id, recipe, notes.get(item.id))),
      foot: [
        el('button', { class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cerrar'),
        el('button', { 'data-feedback-id': 'food.cocina.plato.pase', 'data-feedback-label': 'Abrir el pase', class: 'primary', type: 'button', onclick: () => { void sheet?.close(true); openPass(list, list.indexOf(itemId), notes); } }, 'Pase'),
      ],
      onClose: () => { sheet = null; },
    });
  }

  function dishBody(itemId: string, recipe: RecipeRow, notes: DishNotes | undefined): Array<HTMLElement | null> {
    const names = new Map((data?.ingredients ?? []).map((i) => [i.id, i.name]));
    const scaled = scaledIngredients(graph(), itemId);
    return [
      dishSafety(notes),
      recipe.allergens.length
        ? el('p', { class: 'warnline' }, `Alérgenos declarados: ${recipe.allergens.map((a) => ALLERGEN_LABELS[a]).join(', ')}${recipe.allergens_checked ? ' · revisados por cocina' : ' · sin revisar'}`)
        : el('p', { class: 'muted' }, recipe.allergens_checked ? 'Alérgenos revisados por cocina.' : 'Alérgenos sin revisar.'),
      scaled.length ? el('table', { class: 'ingredients fd-qty' }, el('tbody', null, ...scaled.map((line) => el('tr', null,
        el('td', null, names.get(line.ingredient_id) ?? '—'), el('td', { class: 'num' }, formatQuantity(line.quantity)), el('td', null, UNIT_LABELS[line.unit])))))
        : el('p', { class: 'muted' }, 'La receta no tiene ingredientes.'),
      methodStepsView(recipe),
      recipe.service_notes ? el('p', null, el('strong', null, 'Servicio: '), recipe.service_notes) : null,
      canWrite() ? el('p', null, el('a', { 'data-feedback-id': 'food.cocina.plato.receta', 'data-feedback-label': 'Editar la receta', href: `#/recetario?receta=${recipe.id}`,
        onclick: (e: Event) => { e.preventDefault(); void sheet?.close(true); closePass?.(); navigate(`#/recetario?receta=${recipe.id}`); } }, 'Editar la receta (cambia en todos los menús)')) : null,
    ];
  }

  /** El pase: un plato por pantalla, a pantalla completa. Flechas, ← → o deslizar; «‹ Cocina», Escape o «Atrás» vuelven. */
  function openPass(list: string[], start: number, notes: Map<string, DishNotes>): void {
    if (!list.length) return;
    closePass?.();
    let at = Math.max(0, start);
    const before = document.activeElement as HTMLElement | null;
    const body = el('div', { class: 'fd-pass-body' });
    const counter = el('span', { class: 'fd-pass-count', 'aria-live': 'polite' });
    const prev = el('button', { 'data-feedback-id': 'food.cocina.pase.anterior', 'data-feedback-label': 'Plato anterior', class: 'ghost fd-pass-nav', type: 'button', 'aria-label': 'Plato anterior', onclick: () => go(-1) }, '‹ Anterior');
    const next = el('button', { 'data-feedback-id': 'food.cocina.pase.siguiente', 'data-feedback-label': 'Plato siguiente', class: 'ghost fd-pass-nav', type: 'button', 'aria-label': 'Plato siguiente', onclick: () => go(1) }, 'Siguiente ›');
    const close = () => { handle.release(); release(); overlay.remove(); document.removeEventListener('keydown', onKey, true); closePass = null; before?.focus?.(); };
    const overlay = el('div', { 'data-feedback-id': 'food.cocina.pase', 'data-feedback-label': 'El pase', class: 'fd-pass', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'El pase', id: 'kitchenPass' },
      el('div', { class: 'fd-pass-head' },
        el('button', { 'data-feedback-id': 'food.cocina.pase.volver', 'data-feedback-label': 'Volver a Cocina', class: 'ghost fd-pass-back', type: 'button', onclick: close }, '‹ Cocina'), counter),
      body,
      el('div', { class: 'fd-pass-foot' }, prev, next));
    const paint = () => {
      const itemId = list[at]!;
      const item = data?.items.find((i) => i.id === itemId);
      const recipe = item && recipeOf(item.recipe_id);
      counter.textContent = `${at + 1} de ${list.length}`;
      prev.toggleAttribute('disabled', at === 0);
      next.toggleAttribute('disabled', at === list.length - 1);
      const photo = el('div', { class: 'fd-pass-photo' }, dishMedal(client, recipe, 72));
      replace(body, photo, el('h2', { class: 'fd-pass-name' }, recipe?.name ?? 'Plato'),
        el('p', { class: 'muted' }, item ? `${formatQuantity(item.servings)} raciones` : ''),
        ...(recipe ? dishBody(itemId, recipe, notes.get(itemId)) : []));
      body.scrollTop = 0;
    };
    const go = (delta: number) => { const to = at + delta; if (to < 0 || to >= list.length) return; at = to; paint(); };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
      trapFocus(e, overlay);
    };
    let startX = 0; let startY = 0;
    overlay.addEventListener('pointerdown', (e) => { startX = e.clientX; startY = e.clientY; });
    overlay.addEventListener('pointerup', (e) => {
      const dx = e.clientX - startX; const dy = e.clientY - startY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1);
    });
    document.body.append(overlay);
    const release = lockScroll();
    const handle = trackOverlay(close);
    document.addEventListener('keydown', onKey, true);
    closePass = close;
    paint();
    focusFirst(overlay);
  }

  function serviceCard(service: Mirror<MenuService>, phase: ServicePhase, notes: Map<string, DishNotes>, next: PrepRow | null, now: Date): HTMLElement {
    const items = (data?.items ?? []).filter((i) => i.service_id === service.id).sort((a, b) => Number(a.position) - Number(b.position));
    const own = steps().filter((s) => stepService(s, data!.items, data!.services)?.id === service.id && dayOf(s) === day).sort(byTime);
    const done = own.filter((s) => s.done).length;
    const label = SERVICE_LABELS[service.service_type];
    const until = phase === 'ahora' ? untilText(service.service_date, service.service_time, now) : null;
    const list = items.map((i) => i.id);
    const consumption = consumptionOf(service);
    const consumeBar = !consumption ? null
      : consumption.state === 'automatico' ? el('div', { class: 'chips consumebar' }, el('span', { class: 'chip warn' }, 'Se está descontando solo'))
      : consumption.state === 'por_confirmar' && canWrite()
        ? el('div', { class: 'consumebar' },
            el('button', { 'data-feedback-id': 'food.cocina.servicio.confirmar_consumo', 'data-feedback-label': 'Confirmar consumo', class: 'ghost consumebtn', type: 'button', 'aria-label': `Confirmar consumo de ${label}`,
              onclick: () => { if (!inventory || !data) return; sheet = openConsumptionSheet({ client, service, graph: graph(), inventory, items: data.items, recipes: data.recipes, state: () => consumptionOf(service), onDone: () => load(), onClose: () => { sheet = null; } }); } },
              icon('check', 18), 'Confirmar consumo'),
            el('span', { class: 'hint' }, 'Si nadie lo confirma, se descuenta solo a las 24 h.'))
        : consumption.state === 'hecho' ? el('div', { class: 'chips consumebar' }, el('span', { class: 'chip ok' }, 'Consumo anotado')) : null;
    return el('section', { 'data-feedback-id': 'food.cocina.servicio', 'data-feedback-label': 'Servicio', class: 'card fd-service', 'data-phase': phase, 'data-id': service.id },
      el('header', { class: 'fd-service-head' },
        el('div', null,
          el('h3', null, [PHASE_LABEL[phase], label, shortTime(service.service_time)].filter(Boolean).join(' · ')),
          el('p', { class: 'muted' }, [until, own.length ? `${done} de ${plural(own.length, 'paso', 'pasos')}` : null].filter(Boolean).join(' · ') || ' ')),
        list.length ? el('button', { 'data-feedback-id': 'food.cocina.servicio.pase', 'data-feedback-label': 'Pase', class: 'ghost fd-passbtn', type: 'button', 'aria-label': `Pase de ${label}`, onclick: () => openPass(list, 0, notes) }, 'Pase') : null),
      items.length
        ? el('ul', { class: 'fd-dishes' }, ...items.map((item) => {
            const recipe = recipeOf(item.recipe_id);
            return el('li', null, el('button', { 'data-feedback-id': 'food.cocina.servicio.plato', 'data-feedback-label': 'Plato', class: 'fd-dish', type: 'button', onclick: () => openDish(item.id, list, notes) },
              dishMedal(client, recipe),
              el('span', { class: 'fd-dish-text' },
                el('strong', null, recipe?.name ?? 'Receta retirada'),
                el('span', { class: 'muted' }, `${formatQuantity(item.servings)} rac.`),
                dishSafety(notes.get(item.id)))));
          }))
        : el('p', { class: 'muted' }, 'Sin platos todavía.'),
      own.length ? el('ul', { class: 'preplist' }, ...own.map((s) => el('li', null, rowFor(s, next, now, false)))) : null,
      consumeBar);
  }

  function rowFor(step: PrepRow, next: PrepRow | null, now: Date, withPurpose: boolean): HTMLElement {
    const service = data ? stepService(step, data.items, data.services) : null;
    const item = step.menu_item_id ? data?.items.find((i) => i.id === step.menu_item_id) : undefined;
    const names = Array.from(new Set(steps().map((s) => s.responsible?.trim()).filter((n): n is string => !!n)));
    return stepRow(step, {
      writable: canWrite(),
      purpose: withPurpose && service ? purposeText(SERVICE_LABELS[service.service_type], service.service_time) : null,
      dish: recipeOf(item?.recipe_id ?? step.recipe_id ?? '')?.name ?? null,
      flag: isOverdue(step, dayOf(step), now) ? 'atrasado' : next?.id === step.id ? 'siguiente' : null,
      names,
      onDone: (row, done) => void commitSafely([{ op: 'update', table: T.preparation, id: row.id, expectedRevision: row.revision, fields: { done } }]).then((ok) => usage.track('food.cocina.marcar_hecho', ok ? 'success' : 'error')),
      onEdit: (row) => navigate(`#/menus/${row.menu_id}/preparacion`),
      onMove: (row) => { sheet = openMoveSheet(row, kitchenDays(chosen()!, allServices, steps().map(dayOf), todayKey()), commitSafely); },
      onResponsible: (row, name) => void commitSafely([{ op: 'update', table: T.preparation, id: row.id, expectedRevision: row.revision, fields: { responsible: name } }]),
    });
  }

  function paint(): void {
    const menu = chosen();
    const today = todayKey();
    if (!menu) {
      replace(host, el('div', { class: 'empty', id: 'kitchenEmpty' }, el('strong', null, 'Nada en cocina este día'),
        'Ni retiros ni menú de casa. Los menús se crean desde Eventos; el de casa, desde Menús.',
        el('p', { style: 'margin-top:10px' }, el('button', { 'data-feedback-id': 'food.cocina.ir_casa', 'data-feedback-label': 'Abrir el menú de casa', class: 'ghost', type: 'button', onclick: () => navigate(HOUSE_MENU_HASH) }, 'Abrir el menú de casa'))));
      return;
    }
    if (!data || data.menu?.id !== menu.id) { void loadMenu(menu.id); return; }
    const now = new Date();
    const all = steps();
    const days = kitchenDays(menu, allServices, all.map(dayOf), today);
    if (!days.includes(day)) { days.push(day); days.sort(); }
    const dayChoices = days.map((d) => {
      const rows = all.filter((s) => dayOf(s) === d);
      const late = rows.filter((s) => isOverdue(s, d, now)).length;
      return { key: d, label: dayChoiceLabel(d, today), sub: rows.length ? `${rows.filter((s) => s.done).length}/${rows.length}${late ? ` · ${late} ${late === 1 ? 'atrasado' : 'atrasados'}` : ''}` : null, alert: late > 0 };
    });
    const event: FoodEvent | null = menu.event;
    const notes = new Map(dishNotes({ dietary_restrictions: event?.dietary_restrictions ?? [] }, graph()).map((n) => [n.itemId, n]));
    const phases = servicePhases(data.services, day, now);
    const ofDay = all.filter((s) => dayOf(s) === day);
    // Pasos sueltos: los del día sin servicio, o cuyo servicio es de otro día (una antelación).
    const shown = new Set(phases.map((p) => p.service.id));
    const loose = ofDay.filter((s) => { const service = stepService(s, data!.items, data!.services); return !service || !shown.has(service.id); }).sort(byTime);
    const next = nextStep(all, dayOf, now);
    const options = choices();
    const stale = !!event && !!data.menu && isMenuStale(data.menu, event);
    const card = (phase: ServicePhase) => phases.filter((p) => p.phase === phase).map((p) => serviceCard(p.service, p.phase, notes, next, now));
    const done = card('hecho');
    replace(host,
      options.length > 1 ? el('div', { 'data-feedback-id': 'food.cocina.elegir', 'data-feedback-label': 'Elegir menú', class: 'segmented fd-choose', role: 'group', 'aria-label': 'Menú en cocina' },
        ...options.map((o) => el('button', { type: 'button', 'aria-pressed': String(o.id === menu.id), 'data-feedback-ignore': '', onclick: () => { menuId = o.id; data = null; paint(); } }, o.title))) : null,
      stale ? el('div', { 'data-feedback-id': 'food.cocina.aviso_evento', 'data-feedback-label': 'Aviso de evento cambiado', class: 'banner warn notice', role: 'status' },
        el('div', null, el('strong', null, 'La información del evento ha cambiado.'), ' Revísala en el menú antes de cocinar.'),
        el('div', { class: 'btnrow' }, el('button', { class: 'ghost', type: 'button', onclick: () => navigate(`#/menus/${menu.id}`) }, 'Abrir el menú'))) : null,
      daySelector(dayChoices, day, (key) => { day = key; history.replaceState(null, '', kitchenHash(menuId, day)); paint(); }, 'food.cocina.dias'),
      strip(menu),
      ...card('ahora'),
      ofDay.length ? el('p', { class: 'fd-share', id: 'kitchenShare', 'data-feedback-ignore': '' }, shareText(ofDay)) : null,
      ...card('despues'),
      loose.length ? el('section', { 'data-feedback-id': 'food.cocina.sueltos', 'data-feedback-label': 'Pasos sueltos', class: 'card fd-service fd-loose' },
        el('h3', null, `Pasos sueltos · ${loose.filter((s) => s.done).length} de ${loose.length}`),
        el('ul', { class: 'preplist' }, ...loose.map((s) => el('li', null, rowFor(s, next, now, true))))) : null,
      done.length ? el('details', { 'data-feedback-id': 'food.cocina.hecho', 'data-feedback-label': 'Lo hecho', class: 'fd-done', open: !phases.some((p) => p.phase !== 'hecho') },
        el('summary', null, `Lo hecho (${done.length})`), ...done) : null,
      !phases.length ? el('div', { class: 'empty plain' }, el('strong', null, 'Sin servicios este día'),
        el('p', null, el('a', { href: `#/menus/${menu.id}`, onclick: (e: Event) => { e.preventDefault(); navigate(`#/menus/${menu.id}`); } }, 'Abrir el menú'))) : null,
      !all.length && phases.length ? el('p', { class: 'hint' }, 'Este menú todavía no tiene plan de preparación. ',
        el('a', { href: `#/menus/${menu.id}/preparacion`, onclick: (e: Event) => { e.preventDefault(); navigate(`#/menus/${menu.id}/preparacion`); } }, 'Ir a Preparación')) : null,
    );
  }

  async function loadMenu(id: string): Promise<void> {
    data = await loadMenuData(client, id);
    paint();
  }

  async function load(): Promise<void> {
    [menus, allServices, allSteps, consumptions] = await Promise.all([
      client.list(T.menus) as Promise<Array<Mirror<Menu>>>, client.list(T.menuServices) as Promise<Array<Mirror<MenuService>>>,
      client.list(T.preparation) as Promise<PrepRow[]>, client.list(T.consumptions) as Promise<Array<Mirror<Consumption>>>,
    ]);
    inventory = await loadInventory(client).catch(() => null);
    const menu = chosen();
    data = menu ? await loadMenuData(client, menu.id) : null;
    paint();
  }

  void load();
  const offEvents = watchEvents(client, (next) => { snapshot = next; paint(); });
  const offs = [...MENU_TABLES, T.preparation, T.consumptions].map((table) => client.onTable(table, () => { if (!sheet) void load(); }));
  const offStatus = client.onStatus(() => void refreshEvents(client));
  // Cada minuto cambian «Ahora», «en 2 h» y «Atrasado».
  const timer = setInterval(() => { if (!sheet && !closePass) paint(); }, 60_000);
  return () => {
    offEvents();
    offs.forEach((off) => off());
    offStatus();
    clearInterval(timer);
    closePass?.();
    void sheet?.close(true);
  };
};
