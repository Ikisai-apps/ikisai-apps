/**
 * Food · la carta (decisión de VG del 26-10-2026; docs/food/API.md §2.10). Tanda 2: su vista.
 *
 * - En Menús, el bloque «Cartas» con las cartas guardadas y «Nueva carta» (el alta elige el tipo: el menú cerrado se crea
 *   desde Eventos, la carta desde aquí o desde la ficha del evento).
 * - `#/cartas/<id>`: los bloques Clásicos, Gourmet y Barra; cada línea con su código, su imagen (las sirve Flow), el
 *   precio de venta editable, el coste (inventario de Recursos, `food.carta_projection`) y el margen, y «Disponible».
 *   Los cambios de precio y de disponibilidad quedan en el historial del núcleo con su autor.
 * - «Usar en otro evento» copia la carta (cada evento conserva sus precios y sus ventas); la carta se liga o se desliga
 *   de su evento con el selector de la cabecera.
 */
import type { RowOperation } from '@ikisai/sync-client';
import {
  CARTA_SCOPES, CARTA_SCOPE_LABELS, cartaLinesInOrder, cartaPrevisionEmpty, defaultOfferFields, cartaMargin, copyCartaOperations, formatCents, freeCartaCodes, isCartaMenu,
  parseEurosToCents, validateOperations, type CartaCode, type CartaLine, type CartaScope, type FoodEvent, type Menu, type Recipe, type ResourceItem,
} from '@ikisai/domain-food';
import { closeSheet, el, listRow, openSheet, renderMedal, replace, toast, type Sheet } from '@ikisai/ui-kit';
import type { SyncClient } from '@ikisai/sync-client';
import { T, describeError, type Mirror } from '../app/client.ts';
import { dateRange, todayKey, watchEvents, type EventsSnapshot } from '../app/events.ts';
import { R, resourcesClient } from '../app/resources.ts';
import { usage } from '../app/usage.ts';
import { fbRows } from './feedback.ts';
import type { ViewMount } from './shell.ts';
import { mountPrevision } from './carta-prevision.ts';
import { mountShopping } from './menu-shopping.ts';

export type CartaTab = 'carta' | 'prevision' | 'compra';
export const cartaHash = (id: string, tab: CartaTab = 'carta') => (tab === 'carta' ? `#/cartas/${id}` : `#/cartas/${id}/${tab}`);
/** Las imágenes de la carta las sirve Flow (assets de VG del 26-10): miniatura de cada clave. */
export const FLOW_ORIGIN = 'https://flow.ikisai.com';
export const cartaImage = (key: string | null | undefined) => (key ? `${FLOW_ORIGIN}/assets/${key}/miniatura.webp` : null);

type CartaMenu = Mirror<Menu>;
type LineRow = Mirror<CartaLine>;
interface ProjectionRow { line_id: string; cost_cents: number | null; allergens: string[]; allergens_checked: boolean }

const canWrite = (client: SyncClient) => { const role = client.bootstrap()?.membership.role; return role === 'editor' || role === 'owner'; };

async function commit(client: SyncClient, operations: RowOperation[]): Promise<boolean> {
  const issue = validateOperations(operations);
  if (issue) { toast(issue.message); return false; }
  try {
    await client.commit(operations);
    return true;
  } catch (error) {
    toast(describeError(error));
    return false;
  }
}

/** Nombre de una línea: el suyo, el público de la receta o el del artículo. */
function lineName(line: CartaLine, recipes: Map<string, Recipe>, items: Map<string, ResourceItem>): string {
  if (line.name) return line.name;
  const recipe = line.recipe_id ? recipes.get(line.recipe_id) : undefined;
  return recipe?.public_name || recipe?.name || (line.item_id ? items.get(line.item_id)?.name : undefined) || 'Sin nombre';
}

/** Copia una carta (con sus líneas) para un evento o guardada sin él, y abre la copia. */
async function copyCarta(client: SyncClient, source: CartaMenu, name: string, eventId: string | null, navigate: (hash: string) => void): Promise<boolean> {
  const lines = (await client.list(T.cartaLines)) as LineRow[];
  const newId = crypto.randomUUID();
  const ops = copyCartaOperations({ lines, sourceId: source.id, newId, name, eventId, newLineId: () => crypto.randomUUID(), prepSplit: source.prep_split ?? null }) as unknown as RowOperation[];
  if (eventId) ops.push({ op: 'insert', table: T.eventOffers, id: crypto.randomUUID(), fields: defaultOfferFields({ id: newId, kind: 'carta', name }, eventId) });
  const done = await usage.run('food.carta.copiar', () => commit(client, ops));
  if (done) navigate(cartaHash(newId));
  return done;
}

/** Hoja «Usar en otro evento» (y «Usar esta carta» desde la ficha del evento): nombre y evento de la copia. */
export function openCopySheet(client: SyncClient, source: CartaMenu, events: FoodEvent[], navigate: (hash: string) => void, preset?: FoodEvent): void {
  const upcoming = events.filter((e) => e.end_date >= todayKey()).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const name = el('input', { 'data-feedback-id': 'food.carta.copiar.nombre', 'data-feedback-label': 'Nombre de la copia', id: 'cartaCopyName', type: 'text', maxlength: '120',
    value: preset ? `${source.name ?? 'Carta'} · ${preset.title}` : `${source.name ?? 'Carta'} (copia)` });
  const event = el('select', { 'data-feedback-id': 'food.carta.copiar.evento', 'data-feedback-label': 'Evento de la copia', id: 'cartaCopyEvent', 'aria-label': 'Evento' },
    el('option', { value: '' }, 'Sin evento: guardarla'),
    ...upcoming.map((e) => el('option', { value: e.event_id, selected: preset?.event_id === e.event_id }, `${e.title} · ${dateRange(e)}`)));
  let sheet: Sheet | null = null;
  const save = el('button', { 'data-feedback-id': 'food.carta.copiar.guardar', 'data-feedback-label': 'Crear la copia', class: 'primary', type: 'button', id: 'cartaCopySave',
    onclick: async () => {
      const title = name.value.trim();
      if (!title) { toast('Ponle un nombre a la carta.'); return; }
      save.disabled = true;
      const ok = await copyCarta(client, source, title, event.value || null, navigate);
      save.disabled = false;
      if (ok) await sheet?.close(true);
    } }, 'Crear la copia');
  sheet = openSheet({
    title: 'Usar en otro evento',
    body: el('div', { class: 'formblock' },
      el('p', { class: 'muted' }, 'Se copia con sus precios y su disponibilidad. Las ventas no se copian: cada evento tiene las suyas.'),
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'Evento'), event)),
    foot: [el('button', { 'data-feedback-id': 'food.carta.copiar.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
  });
}

/** Hoja «Nueva carta»: solo el nombre; las líneas se añaden en su vista. */
export function openNewCartaSheet(client: SyncClient, navigate: (hash: string) => void, eventId: string | null = null): void {
  const name = el('input', { 'data-feedback-id': 'food.menus.cartas.nueva_nombre', 'data-feedback-label': 'Nombre de la carta', id: 'cartaNewName', type: 'text', maxlength: '120', placeholder: 'Barra del sábado' });
  let sheet: Sheet | null = null;
  const save = el('button', { 'data-feedback-id': 'food.menus.cartas.crear', 'data-feedback-label': 'Crear carta', class: 'primary', type: 'button', id: 'cartaNewSave',
    onclick: async () => {
      const title = name.value.trim();
      if (!title) { toast('Ponle un nombre a la carta.'); return; }
      const id = crypto.randomUUID();
      const ops: RowOperation[] = [{ op: 'insert', table: T.menus, id, fields: { kind: 'carta', name: title, ...(eventId ? { event_id: eventId } : {}) } }];
      // Para un evento, su oferta (1111): de huéspedes, pagada en barra; se cambia en la ficha del evento.
      if (eventId) ops.push({ op: 'insert', table: T.eventOffers, id: crypto.randomUUID(), fields: defaultOfferFields({ id, kind: 'carta', name: title }, eventId) });
      const ok = await usage.run('food.menus.crear_carta', () => commit(client, ops));
      if (!ok) return;
      await sheet?.close(true);
      navigate(cartaHash(id));
    } }, 'Crear carta');
  sheet = openSheet({
    title: 'Nueva carta',
    body: el('div', { class: 'formblock' },
      el('p', { class: 'muted' }, 'Una carta tiene líneas (montaditos de una receta, bebidas o extras del inventario) con su precio de venta. Se guarda y se reutiliza en otros eventos.'),
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name)),
    foot: [el('button', { 'data-feedback-id': 'food.menus.cartas.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
    initialFocus: name,
  });
}

/** Bloque «Cartas» de Menús: las cartas guardadas y «Nueva carta». */
export function paintCartas(host: HTMLElement, args: { client: SyncClient; cartas: CartaMenu[]; lines: LineRow[]; events: FoodEvent[]; navigate: (hash: string) => void }): void {
  const { client, cartas, lines, events, navigate } = args;
  const byEvent = new Map(events.map((e) => [e.event_id, e]));
  const live = cartas.filter((m) => !m.deleted_at && isCartaMenu(m)).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'es'));
  const list = el('ul', { class: 'list', id: 'cartaList', 'aria-label': 'Cartas' }, ...live.map((menu) => {
    const own = lines.filter((l) => l.menu_id === menu.id && !l.deleted_at);
    const event = menu.event_id ? byEvent.get(menu.event_id) : undefined;
    return listRow({
      id: menu.id,
      title: menu.name ?? 'Carta',
      meta: [event ? `${event.title} · ${dateRange(event)}` : menu.event_id ? 'Evento sin datos en este dispositivo' : 'Guardada, sin evento',
        `${own.filter((l) => l.active).length} de ${own.length} disponibles`],
      chips: [el('span', { class: 'chip' }, 'Carta')],
      pending: menu._pending === true,
      label: `Abrir la carta ${menu.name ?? ''}`.trim(),
      onClick: () => navigate(cartaHash(menu.id)),
    });
  }));
  fbRows(list, { feedbackId: 'food.menus.cartas.lista', feedbackLabel: 'Cartas' }, { feedbackId: 'food.menus.cartas.carta', feedbackLabel: 'Carta' });
  replace(host,
    el('div', { class: 'sectionlabel' }, 'Cartas'),
    live.length ? list : el('p', { class: 'muted' }, 'Todavía no hay cartas. Una carta lleva montaditos, bebidas o extras con su precio de venta.'),
    canWrite(client) ? el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.menus.cartas.nueva', 'data-feedback-label': 'Nueva carta', class: 'ghost', type: 'button', id: 'newCarta',
      onclick: () => openNewCartaSheet(client, navigate) }, 'Nueva carta')) : null);
}

/** La vista de una carta: `#/cartas/<id>`. */
export function mountCarta(menuId: string, tab: CartaTab = 'carta'): ViewMount {
  return ({ main, client, navigate }) => {
    const resources = resourcesClient(client);
    let menu: CartaMenu | null = null;
    let lines: LineRow[] = [];
    let recipes = new Map<string, Recipe>();
    let items = new Map<string, ResourceItem>();
    let projection = new Map<string, ProjectionRow>();
    let projectionAt: string | null = null;
    let snapshot: EventsSnapshot = { events: [], fetchedAt: null };
    const writable = canWrite(client);

    const head = el('div', { class: 'pagehead' });
    const settings = el('section', { 'data-feedback-id': 'food.carta.cabecera', 'data-feedback-label': 'Datos de la carta', class: 'card formblock', id: 'cartaSettings' });
    const blocks = el('div', { id: 'cartaBlocks' });
    const note = el('p', { class: 'muted', id: 'cartaCostNote' });
    // Pestañas: la carta, su previsión (unidades esperadas, reparto y plan de bandejas) y su lista de la compra.
    const TABS: Array<{ key: CartaTab; label: string; mark: string }> = [
      { key: 'carta', label: 'Carta', mark: 'food.carta.pestanas.carta' },
      { key: 'prevision', label: 'Previsión', mark: 'food.carta.pestanas.prevision' },
      { key: 'compra', label: 'Compra', mark: 'food.carta.pestanas.compra' },
    ];
    const tabs = el('nav', { 'data-feedback-id': 'food.carta.pestanas', 'data-feedback-label': 'Partes de la carta', class: 'segmented menutabs', 'aria-label': 'Partes de la carta' },
      ...TABS.map((t) => el('a', { 'data-feedback-id': t.mark, 'data-feedback-label': t.label, href: cartaHash(menuId, t.key), 'data-tab': t.key,
        'aria-current': t.key === tab ? 'page' : 'false', onclick: (e: Event) => { e.preventDefault(); navigate(cartaHash(menuId, t.key)); } }, t.label)));
    const content = el('div', { id: 'cartaTab' });
    replace(main,
      el('p', { class: 'crumb' }, el('a', { 'data-feedback-id': 'food.carta.volver', 'data-feedback-label': 'Volver a Menús', href: '#/menus', onclick: (e: Event) => { e.preventDefault(); navigate('#/menus'); } }, '← Menús')),
      head, tabs, content);
    let unmountTab: (() => void) | null = null;
    if (tab === 'carta') replace(content, settings, blocks, note);
    else if (tab === 'prevision') unmountTab = mountPrevision({ client, menuId, host: content, canWrite: writable, navigate });
    else unmountTab = mountShopping({ client, menuId, host: content, canWrite: () => writable, carta: true, navigate });

    function paintHead(): void {
      if (!menu) {
        replace(head, el('div', null, el('h2', null, 'Carta'), el('p', null, 'Esta carta no existe o está en la papelera.')));
        replace(settings); replace(blocks); return;
      }
      const event = menu.event_id ? snapshot.events.find((e) => e.event_id === menu!.event_id) : undefined;
      const live = cartaLinesInOrder(lines, menu.id);
      replace(head, el('div', null,
        el('h2', { id: 'cartaTitle' }, menu.name ?? 'Carta'),
        el('p', null, [event ? `${event.title} · ${dateRange(event)}` : menu.event_id ? 'Ligada a un evento sin datos en este dispositivo' : 'Guardada, sin evento',
          `${live.filter((l) => l.active).length} de ${live.length} disponibles`].join(' · '))));
    }

    function paintSettings(): void {
      if (!menu) return;
      if (!writable) { replace(settings); settings.hidden = true; return; }
      settings.hidden = false;
      const current = menu;
      const name = el('input', { 'data-feedback-id': 'food.carta.cabecera.nombre', 'data-feedback-label': 'Nombre de la carta', id: 'cartaName', type: 'text', maxlength: '120', value: current.name ?? '' });
      const saveName = el('button', { 'data-feedback-id': 'food.carta.cabecera.guardar_nombre', 'data-feedback-label': 'Guardar el nombre', class: 'ghost', type: 'button', id: 'cartaNameSave',
        onclick: async () => {
          const title = name.value.trim();
          if (!title || title === current.name) return;
          if (await commit(client, [{ op: 'update', table: T.menus, id: current.id, expectedRevision: current.revision, fields: { name: title } }])) toast('Nombre guardado.');
        } }, 'Guardar');
      const upcoming = snapshot.events.filter((e) => e.end_date >= todayKey() || e.event_id === current.event_id).sort((a, b) => a.start_date.localeCompare(b.start_date));
      const event = el('select', { 'data-feedback-id': 'food.carta.cabecera.evento', 'data-feedback-label': 'Evento de la carta', id: 'cartaEvent', 'aria-label': 'Evento de la carta',
        onchange: async () => {
          const next = event.value || null;
          if (next === current.event_id) return;
          if (await commit(client, [{ op: 'update', table: T.menus, id: current.id, expectedRevision: current.revision, fields: { event_id: next } }])) toast(next ? 'Carta ligada al evento.' : 'Carta guardada sin evento.');
          else event.value = current.event_id ?? '';
        } },
        el('option', { value: '' }, 'Sin evento: guardada'),
        ...upcoming.map((e) => el('option', { value: e.event_id, selected: e.event_id === current.event_id }, `${e.title} · ${dateRange(e)}`)));
      if (current.event_id && !upcoming.some((e) => e.event_id === current.event_id)) event.append(el('option', { value: current.event_id, selected: true }, 'Evento sin datos en este dispositivo'));
      replace(settings,
        el('label', { class: 'field' }, el('span', null, 'Nombre'), el('span', { class: 'carta-inline' }, name, saveName)),
        el('label', { class: 'field' }, el('span', null, 'Evento'), event),
        el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.cabecera.usar_en_evento', 'data-feedback-label': 'Usar en otro evento', class: 'ghost', type: 'button', id: 'cartaCopy',
          onclick: () => openCopySheet(client, current, snapshot.events, navigate) }, 'Usar en otro evento')));
    }

    function lineCard(line: LineRow): HTMLElement {
      const name = lineName(line, recipes, items);
      const cost = projection.get(line.id)?.cost_cents ?? null;
      const margin = cartaMargin(line.sale_price_cents, cost);
      const recipe = line.recipe_id ? recipes.get(line.recipe_id) : undefined;
      const price = el('input', { 'data-feedback-id': 'food.carta.linea.precio', 'data-feedback-label': 'Precio de venta', type: 'text', inputmode: 'decimal', class: 'carta-price',
        'aria-label': `Precio de ${name} en euros`, value: (line.sale_price_cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }), disabled: !writable,
        onchange: async () => {
          const cents = parseEurosToCents(price.value);
          if (cents === null) { toast('Escribe un precio como 2,50.'); price.value = (line.sale_price_cents / 100).toLocaleString('es-ES', { minimumFractionDigits: 2 }); return; }
          if (cents === line.sale_price_cents) return;
          const ok = await usage.run('food.carta.precio', () => commit(client, [{ op: 'update', table: T.cartaLines, id: line.id, expectedRevision: line.revision, fields: { sale_price_cents: cents } }]));
          if (ok) toast(`${name}: ${formatCents(cents)}.`);
        } });
      const available = el('input', { 'data-feedback-id': 'food.carta.linea.disponible', 'data-feedback-label': 'Disponible', type: 'checkbox', checked: line.active, disabled: !writable,
        id: `carta-active-${line.id}`,
        onchange: async () => {
          const ok = await usage.run('food.carta.disponible', () => commit(client, [{ op: 'update', table: T.cartaLines, id: line.id, expectedRevision: line.revision, fields: { active: available.checked } }]));
          if (!ok) available.checked = line.active;
          else toast(available.checked ? `${name}, disponible.` : `${name}, agotado: no sale en las cestas nuevas.`);
        } });
      return el('article', { 'data-feedback-id': 'food.carta.linea', 'data-feedback-label': 'Línea de la carta', class: 'card carta-line' + (line.active ? '' : ' carta-off'), id: `carta-line-${line.id}`, 'data-pending': String(line._pending === true) },
        el('div', { class: 'carta-line-head' },
          renderMedal({ image: cartaImage(line.image_key), name, initials: line.code, size: 44 }),
          el('span', { class: 'carta-code', 'aria-label': `Código ${line.code}` }, line.code),
          el('span', { class: 'carta-line-title' }, el('strong', null, name),
            el('small', { class: 'muted' }, line.description || recipe?.public_description || (line.item_id ? 'Del inventario' : 'Receta')))),
        el('div', { class: 'carta-line-money' },
          el('label', { class: 'field' }, el('span', null, 'Precio (€)'), price),
          el('span', { class: 'carta-cost' }, el('span', { class: 'muted' }, 'Coste'), el('strong', null, cost === null ? (projectionAt ? 'falta precio' : 'sin datos') : '≈ ' + formatCents(cost))),
          el('span', { class: 'carta-margin' }, el('span', { class: 'muted' }, 'Margen'), el('strong', { class: margin && margin.cents < 0 ? 'warnline' : '' },
            margin ? `${formatCents(margin.cents)} · ${Math.round(margin.ratio * 100)} %` : '—'))),
        el('div', { class: 'carta-line-foot' },
          el('label', { class: 'checkline', for: available.id }, available, el('span', null, 'Disponible')),
          recipe && !recipe.allergens_checked ? el('span', { class: 'chip warn' }, 'Alérgenos sin revisar') : null,
          writable ? el('button', { 'data-feedback-id': 'food.carta.linea.quitar', 'data-feedback-label': 'Quitar de la carta', class: 'ghost', type: 'button',
            onclick: async () => {
              if (await commit(client, [{ op: 'delete', table: T.cartaLines, id: line.id, expectedRevision: line.revision }])) toast(`${name}, fuera de la carta.`);
            } }, 'Quitar') : null));
    }

    function openAdd(scope: CartaScope): void {
      if (!menu) return;
      const codes = freeCartaCodes(lines, menu.id, scope);
      if (!codes.length) { toast(`${CARTA_SCOPE_LABELS[scope]} ya tiene los ocho códigos.`); return; }
      const liveRecipes = [...recipes.values()].filter((r) => !r.deleted_at && r.status !== 'archivada').sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const liveItems = [...items.values()].filter((i) => i.active !== false && !(i as { deleted_at?: string | null }).deleted_at).sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const origin = el('select', { 'data-feedback-id': 'food.carta.anadir.origen', 'data-feedback-label': 'Receta o artículo', id: 'cartaAddOrigin', 'aria-label': 'De dónde sale',
        onchange: () => paintPick() },
        el('option', { value: 'receta', selected: scope !== 'barra' }, 'Una receta (se prepara)'),
        el('option', { value: 'articulo', selected: scope === 'barra' }, 'Un artículo del inventario (bebida, extra)'));
      const pickHost = el('div');
      let pick = el('select');
      function paintPick(): void {
        const list = origin.value === 'receta' ? liveRecipes.map((r) => [r.id, r.name] as const) : liveItems.map((i) => [i.id, i.name] as const);
        pick = el('select', { 'data-feedback-id': 'food.carta.anadir.producto', 'data-feedback-label': 'Producto', id: 'cartaAddPick', 'aria-label': 'Producto' },
          ...list.map(([id, label]) => el('option', { value: id }, label)));
        replace(pickHost, el('label', { class: 'field' }, el('span', null, origin.value === 'receta' ? 'Receta' : 'Artículo'), list.length ? pick : el('span', { class: 'muted' }, origin.value === 'receta' ? 'No hay recetas.' : 'No hay artículos en este dispositivo.')));
      }
      paintPick();
      const code = el('select', { 'data-feedback-id': 'food.carta.anadir.codigo', 'data-feedback-label': 'Código', id: 'cartaAddCode', 'aria-label': 'Código' }, ...codes.map((c) => el('option', { value: c }, c)));
      const price = el('input', { 'data-feedback-id': 'food.carta.anadir.precio', 'data-feedback-label': 'Precio de venta', id: 'cartaAddPrice', type: 'text', inputmode: 'decimal', placeholder: '2,50' });
      let sheet: Sheet | null = null;
      const save = el('button', { 'data-feedback-id': 'food.carta.anadir.guardar', 'data-feedback-label': 'Añadir a la carta', class: 'primary', type: 'button', id: 'cartaAddSave',
        onclick: async () => {
          const cents = parseEurosToCents(price.value);
          if (cents === null) { toast('Escribe un precio como 2,50.'); return; }
          if (!pick.value) { toast('Elige qué se vende.'); return; }
          const position = Math.max(0, ...lines.filter((l) => l.menu_id === menu!.id && !l.deleted_at).map((l) => Number(l.position))) + 1;
          const fields: Record<string, unknown> = { menu_id: menu!.id, scope, code: code.value as CartaCode, sale_price_cents: cents, position,
            ...(origin.value === 'receta' ? { recipe_id: pick.value } : { item_id: pick.value }) };
          if (await usage.run('food.carta.anadir', () => commit(client, [{ op: 'insert', table: T.cartaLines, id: crypto.randomUUID(), fields }]))) await sheet?.close(true);
        } }, 'Añadir');
      sheet = openSheet({
        title: `Añadir a ${CARTA_SCOPE_LABELS[scope]}`,
        body: el('div', { class: 'formblock' },
          el('label', { class: 'field' }, el('span', null, 'Qué se vende'), origin), pickHost,
          el('label', { class: 'field' }, el('span', null, 'Código'), code),
          el('label', { class: 'field' }, el('span', null, 'Precio de venta (€)'), price)),
        foot: [el('button', { 'data-feedback-id': 'food.carta.anadir.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void closeSheet() }, 'Cancelar'), save],
      });
    }

    function paintBlocks(): void {
      if (!menu) return;
      const live = cartaLinesInOrder(lines, menu.id);
      // Sin previsión, Flow no puede preparar existencias (hueco S3 de la QA de Flow): se dice aquí y lleva a Previsión.
      const empty = live.some((l) => l.active) && cartaPrevisionEmpty(lines, menu.id);
      replace(blocks,
        empty ? el('div', { 'data-feedback-id': 'food.carta.sin_prevision', 'data-feedback-label': 'Sin previsión', class: 'banner warn notice', role: 'note', id: 'cartaNoPrevision' },
          el('div', null, el('strong', null, 'Sin previsión: Flow no podrá preparar existencias.'), ' Pon las unidades a cubrir en Previsión.'),
          el('div', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.ir_prevision', 'data-feedback-label': 'Ir a Previsión', class: 'ghost', type: 'button',
            onclick: () => navigate(cartaHash(menuId, 'prevision')) }, 'Ir a Previsión'))) : null, ...CARTA_SCOPES.map((scope) => {
        const own = live.filter((l) => l.scope === scope);
        return el('section', { 'data-feedback-id': 'food.carta.bloque', 'data-feedback-label': 'Bloque de la carta', class: 'carta-block', id: `carta-${scope}` },
          el('div', { class: 'sectionlabel' }, `${CARTA_SCOPE_LABELS[scope]} · ${own.length}`),
          own.length ? el('div', { class: 'carta-grid' }, ...own.map(lineCard)) : el('p', { class: 'muted' }, 'Nada en este bloque.'),
          writable ? el('p', { class: 'btnrow' }, el('button', { 'data-feedback-id': 'food.carta.anadir', 'data-feedback-label': 'Añadir línea', class: 'ghost', type: 'button',
            id: `carta-add-${scope}`, onclick: () => openAdd(scope) }, `Añadir a ${CARTA_SCOPE_LABELS[scope]}`)) : null);
      }));
      note.textContent = projectionAt
        ? 'Coste por unidad con el coste medio del inventario (Recursos). Los cambios de precio y de disponibilidad quedan en el historial.'
        : 'El coste necesita conexión: se calcula con el inventario del servidor.';
    }

    function paint(): void { paintHead(); if (tab === 'carta') { paintSettings(); paintBlocks(); } }

    async function loadCosts(): Promise<void> {
      try {
        const out = await client.api<{ rows: ProjectionRow[] }>(`/read/food.carta_projection?where[menu_id]=${encodeURIComponent(menuId)}&limit=500`);
        projection = new Map(out.rows.map((r) => [r.line_id, r]));
        projectionAt = new Date().toISOString();
      } catch {
        projectionAt = null;
      }
      paintBlocks();
    }

    async function load(): Promise<void> {
      const [row, allLines, allRecipes, allItems] = await Promise.all([
        client.get(T.menus, menuId) as Promise<CartaMenu | null>,
        client.list(T.cartaLines) as Promise<LineRow[]>,
        client.list(T.recipes, { includeDeleted: true }) as Promise<Array<Mirror<Recipe>>>,
        resources.list(R.items).catch(() => []) as unknown as Promise<Array<Mirror<ResourceItem>>>,
      ]);
      menu = row && !row.deleted_at && isCartaMenu(row) ? row : null;
      lines = allLines;
      recipes = new Map(allRecipes.map((r) => [r.id, r]));
      items = new Map(allItems.map((i) => [i.id, i]));
      paint();
    }

    void load().then(() => (tab === 'carta' ? loadCosts() : undefined));
    const offEvents = watchEvents(client, (next) => { snapshot = next; paintHead(); if (tab === 'carta') paintSettings(); });
    const offTables = [T.menus, T.cartaLines, T.recipes].map((table) => client.onTable(table, () => void load().then(() => (tab === 'carta' ? loadCosts() : undefined))));
    const offItems = resources.onTable(R.items, () => void load());
    return () => { unmountTab?.(); offEvents(); offTables.forEach((off) => off()); offItems(); };
  };
}
