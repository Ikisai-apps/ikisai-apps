/**
 * Food · ofertas de comida de un evento (encargo de VG por Core, 27-10-2026; docs/food/API.md §2.12): el bloque «Ofertas»
 * de la ficha del evento, la hoja para añadir o cambiar una oferta y «Lo que pide el evento» (`food.event_needs`).
 *
 * Una oferta es un menú cerrado o una carta, con cuándo (días × servicios), para qué grupos (etiquetas de Booking; nunca
 * personas), dónde y quién paga. Las internas (equipo, outsiders, familia) no las ven ni el organizador ni los huéspedes.
 */
import type { RowOperation, SyncClient } from '@ikisai/sync-client';
import {
  MEAL_GROUP_SUGGESTIONS, SERVICE_TYPES, isCartaMenu, offerGroupsText, offerPayerText, validateOperations,
  type EventNeed, type EventOffer, type FoodEvent, type Menu, type ServiceType,
} from '@ikisai/domain-food';
import { confirmDialog, el, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { T, describeError, formatQuantity, type Mirror } from '../app/client.ts';
import { eventDays, shortDay } from '../app/events.ts';
import { usage } from '../app/usage.ts';

type OfferRow = Mirror<EventOffer>;
type MenuRow = Mirror<Menu>;

const SERVICE_TEXT: Record<ServiceType, string> = { desayuno: 'Desayuno', comida: 'Comida', cena: 'Cena', picnic: 'Picnic', merienda: 'Merienda', otro: 'Otro' };

async function commit(client: SyncClient, operations: RowOperation[]): Promise<boolean> {
  const issue = validateOperations(operations);
  if (issue) { toast(issue.message); return false; }
  try { await client.commit(operations); return true; } catch (error) { toast(describeError(error)); return false; }
}

/** «Todos los días», «vie 30 y sáb 31»; «todos los servicios», «comida y cena». */
function whenText(offer: Pick<EventOffer, 'days' | 'services'>): string {
  const days = offer.days?.length ? offer.days.map(shortDay).join(', ') : 'todos los días';
  const services = offer.services?.length ? offer.services.map((s) => SERVICE_TEXT[s].toLowerCase()).join(', ') : 'todos los servicios';
  return `${days} · ${services}`;
}

/** Grupos de comensales del evento que da Booking (`meal_groups`, Booking 0485), si los hay. */
function eventGroups(event: FoodEvent): Array<{ group: string; guests: number }> {
  const raw = (event as unknown as { meal_groups?: unknown }).meal_groups;
  return Array.isArray(raw) ? raw.filter((g): g is { group: string; guests: number } => !!g && typeof (g as { group?: unknown }).group === 'string') : [];
}

/** Hoja para añadir (sin `offer`) o cambiar una oferta del evento. */
export function openOfferSheet(args: { client: SyncClient; event: FoodEvent; menus: MenuRow[]; offer?: OfferRow | null; onDone?: () => void }): void {
  const { client, event, menus, offer } = args;
  // Qué se ofrece: el menú cerrado del evento, sus cartas y las cartas guardadas sin evento (se reutilizan tal cual).
  const choices = menus.filter((m) => !m.deleted_at && (m.event_id === event.event_id || (isCartaMenu(m) && !m.event_id)));
  const menu = el('select', { 'data-feedback-id': 'food.eventos.oferta.menu', 'data-feedback-label': 'Menú o carta de la oferta', id: 'offerMenu', 'aria-label': 'Menú o carta' },
    ...choices.map((m) => el('option', { value: m.id, selected: offer?.menu_id === m.id },
      isCartaMenu(m) ? `Carta · ${m.name ?? 'Carta'}${m.event_id ? '' : ' (guardada)'}` : m.kind === 'casa' ? 'Menú de casa' : 'Menú cerrado del evento')));
  const name = el('input', { 'data-feedback-id': 'food.eventos.oferta.nombre', 'data-feedback-label': 'Nombre de la oferta', id: 'offerName', type: 'text', maxlength: '120',
    value: offer?.name ?? '', placeholder: 'Cena de huéspedes, Barra, Equipo…' });
  const audience = el('select', { 'data-feedback-id': 'food.eventos.oferta.para_quien', 'data-feedback-label': 'Para quién', id: 'offerAudience', 'aria-label': 'Para quién',
    onchange: () => paintPay() },
    el('option', { value: 'huespedes', selected: (offer?.audience ?? 'huespedes') === 'huespedes' }, 'Huéspedes'),
    el('option', { value: 'interna', selected: offer?.audience === 'interna' }, 'Interna (equipo, outsiders, familia)'));
  const known = [...new Set([...eventGroups(event).map((g) => g.group), ...MEAL_GROUP_SUGGESTIONS])];
  const groups = el('input', { 'data-feedback-id': 'food.eventos.oferta.grupos', 'data-feedback-label': 'Grupos de comensales', id: 'offerGroups', type: 'text',
    value: (offer?.meal_groups ?? []).join(', '), placeholder: 'Vacío = todos', list: 'offerGroupList' });
  const counts = eventGroups(event);
  const days = eventDays(event);
  const dayBoxes = days.map((d) => el('input', { 'data-feedback-id': 'food.eventos.oferta.dia', 'data-feedback-label': 'Día de la oferta', type: 'checkbox', id: `offer-day-${d}`, value: d,
    checked: !offer?.days || offer.days.includes(d) }) as HTMLInputElement);
  const serviceBoxes = SERVICE_TYPES.map((s) => el('input', { 'data-feedback-id': 'food.eventos.oferta.servicio', 'data-feedback-label': 'Servicio de la oferta', type: 'checkbox', id: `offer-service-${s}`, value: s,
    checked: !offer?.services || offer.services.includes(s) }) as HTMLInputElement);
  const place = el('input', { 'data-feedback-id': 'food.eventos.oferta.lugar', 'data-feedback-label': 'Dónde', id: 'offerPlace', type: 'text', maxlength: '200', value: offer?.place ?? '', placeholder: 'Comedor, terraza, barra…' });
  const payer = el('select', { 'data-feedback-id': 'food.eventos.oferta.paga', 'data-feedback-label': 'Quién paga', id: 'offerPayer', 'aria-label': 'Quién paga', onchange: () => paintPay() },
    el('option', { value: 'organizador', selected: (offer?.payer ?? 'organizador') === 'organizador' }, 'El organizador (incluido)'),
    el('option', { value: 'huesped', selected: offer?.payer === 'huesped' }, 'El huésped'));
  const charge = el('select', { 'data-feedback-id': 'food.eventos.oferta.cobro', 'data-feedback-label': 'Cuándo se cobra', id: 'offerCharge', 'aria-label': 'Cuándo se cobra' },
    el('option', { value: 'barra', selected: (offer?.charge_when ?? 'barra') === 'barra' }, 'En barra, al momento'),
    el('option', { value: 'cuenta', selected: offer?.charge_when === 'cuenta' }, 'A su cuenta, al final'));
  const visible = el('input', { 'data-feedback-id': 'food.eventos.oferta.visitantes', 'data-feedback-label': 'Visible para visitantes', type: 'checkbox', id: 'offerPublic',
    checked: offer?.public === true }) as HTMLInputElement;
  const payHost = el('div');
  function paintPay(): void {
    if (audience.value === 'interna') { replace(payHost, el('p', { class: 'muted' }, 'Interna: no la ven ni el organizador ni los huéspedes, y no se cobra.')); return; }
    replace(payHost, el('label', { class: 'field' }, el('span', null, 'Quién paga'), payer),
      payer.value === 'huesped' ? el('label', { class: 'field' }, el('span', null, 'Cuándo se cobra'), charge) : null,
      el('label', { class: 'checkline', for: visible.id }, visible, el('span', null, 'Visible para visitantes (QR), sin ficha de huésped')));
  }
  paintPay();
  if (!name.value && menu.value) {
    const m = choices.find((c) => c.id === menu.value);
    name.value = m && isCartaMenu(m) ? m.name ?? 'Carta' : 'Menú';
  }

  let sheet: Sheet | null = null;
  const save = el('button', { 'data-feedback-id': 'food.eventos.oferta.guardar', 'data-feedback-label': 'Guardar la oferta', class: 'primary', type: 'button', id: 'offerSave',
    onclick: async () => {
      if (!menu.value) { toast('Elige un menú o una carta.'); return; }
      const pickedDays = dayBoxes.filter((b) => b.checked).map((b) => b.value);
      const pickedServices = serviceBoxes.filter((b) => b.checked).map((b) => b.value);
      if (!pickedDays.length || !pickedServices.length) { toast('Elige al menos un día y un servicio.'); return; }
      const internal = audience.value === 'interna';
      const fields: Record<string, unknown> = {
        menu_id: menu.value, name: name.value.trim(), audience: audience.value,
        meal_groups: groups.value.split(',').map((g) => g.trim()).filter(Boolean),
        days: pickedDays.length === days.length ? null : pickedDays,
        services: pickedServices.length === SERVICE_TYPES.length ? null : pickedServices,
        place: place.value.trim() || null,
        payer: internal ? null : payer.value,
        charge_when: internal || payer.value !== 'huesped' ? null : charge.value,
        public: !internal && visible.checked,
      };
      const op: RowOperation = offer
        ? { op: 'update', table: T.eventOffers, id: offer.id, expectedRevision: offer.revision, fields }
        : { op: 'insert', table: T.eventOffers, id: crypto.randomUUID(), fields: { ...fields, event_id: event.event_id, position: Date.now() / 1e12 } };
      if (await usage.run('food.eventos.oferta', () => commit(client, [op]))) {
        toast(offer ? 'Oferta guardada.' : 'Oferta añadida.');
        await sheet?.close(true);
        args.onDone?.();
      }
    } }, 'Guardar');
  const remove = offer ? el('button', { 'data-feedback-id': 'food.eventos.oferta.quitar', 'data-feedback-label': 'Quitar la oferta', class: 'ghost', type: 'button', id: 'offerRemove',
    onclick: async () => {
      if (!(await confirmDialog({ title: '¿Quitar esta oferta?', text: 'El menú o la carta no se borran: solo dejan de ofrecerse en este evento.', confirmLabel: 'Quitar', danger: true }))) return;
      if (await commit(client, [{ op: 'delete', table: T.eventOffers, id: offer.id, expectedRevision: offer.revision }])) { toast('Oferta quitada.'); await sheet?.close(true); args.onDone?.(); }
    } }, 'Quitar') : null;
  sheet = openSheet({
    title: offer ? 'Cambiar la oferta' : 'Añadir una oferta',
    body: el('div', { class: 'formblock', id: 'offerForm' },
      el('label', { class: 'field' }, el('span', null, 'Qué se ofrece'), choices.length ? menu : el('span', { class: 'muted' }, 'Crea antes el menú o la carta.')),
      el('label', { class: 'field' }, el('span', null, 'Nombre'), name),
      el('label', { class: 'field' }, el('span', null, 'Para quién'), audience),
      el('label', { class: 'field' }, el('span', null, 'Grupos (separados por comas)'), groups,
        el('datalist', { id: 'offerGroupList' }, ...known.map((g) => el('option', { value: g }))),
        counts.length ? el('span', { class: 'hint' }, 'En el evento: ' + counts.map((g) => `${g.group} (${g.guests})`).join(', ') + '.') : el('span', { class: 'hint' }, 'Vacío: todos.')),
      el('fieldset', { class: 'formblock' }, el('legend', null, 'Días'), ...dayBoxes.map((b) => el('label', { class: 'checkline', for: b.id }, b, el('span', null, shortDay(b.value))))),
      el('fieldset', { class: 'formblock' }, el('legend', null, 'Servicios'), ...serviceBoxes.map((b) => el('label', { class: 'checkline', for: b.id }, b, el('span', null, SERVICE_TEXT[b.value as ServiceType])))),
      el('label', { class: 'field' }, el('span', null, 'Dónde'), place),
      payHost),
    foot: [remove, el('button', { 'data-feedback-id': 'food.eventos.oferta.cancelar', 'data-feedback-label': 'Cancelar', class: 'ghost', type: 'button', onclick: () => void sheet?.close() }, 'Cancelar'), save].filter((b): b is HTMLButtonElement => !!b),
  });
}

/** Bloque «Ofertas» de la ficha del evento: cada oferta con qué, cuándo, para quién, dónde y quién paga. */
export function offersBlock(args: { client: SyncClient; event: FoodEvent; menus: MenuRow[]; offers: OfferRow[]; canWrite: boolean; onChange?: () => void }): HTMLElement {
  const { client, event, menus, canWrite } = args;
  const own = args.offers.filter((o) => !o.deleted_at && o.event_id === event.event_id).sort((a, b) => Number(a.position) - Number(b.position));
  const menuName = (o: OfferRow) => {
    const m = menus.find((x) => x.id === o.menu_id);
    return !m ? 'Menú no disponible' : isCartaMenu(m) ? `Carta · ${m.name ?? 'Carta'}` : m.kind === 'casa' ? 'Menú de casa' : 'Menú cerrado';
  };
  const needsHost = el('div', { id: 'eventNeeds' });
  const showNeeds = el('button', { 'data-feedback-id': 'food.eventos.ficha.lo_que_pide', 'data-feedback-label': 'Lo que pide el evento', class: 'ghost', type: 'button', id: 'eventNeedsButton',
    onclick: async () => {
      replace(needsHost, el('p', { class: 'muted' }, 'Sumando las ofertas…'));
      try {
        const out = await client.api<{ items: EventNeed[]; offers: number }>('/read/food.event_needs', { method: 'POST', json: { event_id: event.event_id } });
        replace(needsHost, out.items.length
          ? el('ul', { class: 'plainlist', 'aria-label': 'Lo que pide el evento' }, ...out.items.map((i) => el('li', null, el('strong', null, i.name), `: ${formatQuantity(i.quantity)} ${i.unit}`, i.menus > 1 ? el('span', { class: 'muted' }, ` · de ${i.menus} ofertas`) : null)))
          : el('p', { class: 'muted' }, 'Las ofertas todavía no piden nada (sin platos ni unidades previstas).'));
      } catch (error) {
        replace(needsHost, el('p', { class: 'warnline' }, describeError(error)));
      }
    } }, 'Lo que pide el evento');
  return el('section', { 'data-feedback-id': 'food.eventos.ficha.ofertas', 'data-feedback-label': 'Ofertas de comida', class: 'formblock', id: 'eventOffers' },
    el('h4', null, 'Ofertas de comida'),
    own.length ? el('ul', { class: 'plainlist offerlist' }, ...own.map((o) => el('li', { class: 'offerrow', id: `offer-${o.id}` },
      el('div', null, el('strong', null, o.name), el('span', { class: 'muted' }, ` · ${menuName(o)}`)),
      el('div', { class: 'muted' }, `${offerGroupsText(o)} · ${whenText(o)}${o.place ? ` · ${o.place}` : ''}`),
      el('div', null, el('span', { class: o.audience === 'interna' ? 'chip' : o.payer === 'organizador' ? 'chip ok' : 'chip warn' }, offerPayerText(o)),
        o.public ? el('span', { class: 'chip' }, 'Visitantes (QR)') : null,
        canWrite ? el('button', { 'data-feedback-id': 'food.eventos.ficha.oferta_cambiar', 'data-feedback-label': 'Cambiar la oferta', class: 'ghost', type: 'button',
          onclick: () => openOfferSheet({ client, event, menus, offer: o, onDone: args.onChange }) }, 'Cambiar') : null))))
      : el('p', { class: 'muted' }, 'Sin ofertas todavía. Al crear el menú o la carta del evento, se añade su oferta.'),
    el('p', { class: 'btnrow' },
      canWrite ? el('button', { 'data-feedback-id': 'food.eventos.ficha.oferta_nueva', 'data-feedback-label': 'Añadir una oferta', class: 'ghost', type: 'button', id: 'addOffer',
        onclick: () => openOfferSheet({ client, event, menus, onDone: args.onChange }) }, 'Añadir una oferta') : null,
      showNeeds),
    needsHost);
}
