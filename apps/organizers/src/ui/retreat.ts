/**
 * Ficha del retiro (API.md §9.3, §9.4 y §9.7): cabecera con fechas, horas y estado, y tres pestañas. Las tres lecturas de
 * Booking (detalle, asistentes, cocina) van en paralelo; sin red se pinta la última copia con el aviso.
 */
import { el, icon, plural, replace, type Child } from '@ikisai/ui-kit';
import type { GuestList, KitchenSummary, Loaded, PortalLink, ReservationDetail } from '../app/api.ts';
import { dateRange, hourLabel, isCancelled, MEAL_PLAN_LABELS, MENU_STYLE_LABELS, restrictionText, STATUS_LABELS, STATUS_TONE } from '../app/labels.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import { renderGuestList } from './guests.ts';
import type { ViewContext, ViewMount } from './shell.ts';

export type RetreatTab = 'resumen' | 'asistentes' | 'cocina';


export interface RetreatData {
  detail: Loaded<ReservationDetail>;
  guests: Loaded<GuestList>;
  kitchen: Loaded<KitchenSummary>;
  links: Loaded<{ items: PortalLink[] }> | null;
}

/** Completo: sin datos que falten y, con registro de viajeros, firmado. */
export const guestComplete = (g: { missing: string[]; signed: boolean }, mode: string) => g.missing.length === 0 && (mode !== 'ses' || g.signed);

export const mountRetreat = (reservationId: string, tab: RetreatTab): ViewMount => (ctx) => {
  const { api, main } = ctx;
  let alive = true;
  const head = el('div', { id: 'retreatHead' });
  const tabs = el('div', { id: 'retreatTabs' });
  const body = el('div', { id: 'retreatBody' }, loading());
  replace(main,
    el('a', { class: 'backlink', href: '#/', id: 'backToRetreats', 'data-feedback-id': 'organizers.retiro.cabecera.volver', 'data-feedback-label': 'Mis retiros' }, icon('chevronLeft', 16), 'Mis retiros'),
    head, tabs, body);

  async function load(): Promise<void> {
    try {
      const [detail, guests, kitchen] = await Promise.all([api.detail(reservationId), api.guests(reservationId), api.kitchen(reservationId)]);
      // Los enlaces de huésped solo hacen falta en la pestaña Asistentes; si fallan, la lista sigue sin su estado.
      const links = tab === 'asistentes' && guests.value.confirmed ? await api.links(reservationId).catch(() => null) : null;
      if (!alive) return;
      paint({ detail, guests, kitchen, links });
    } catch (error) {
      if (alive) replace(body, failure(error, () => void load()));
    }
  }

  function paint(data: RetreatData): void {
    const d = data.detail.value;
    document.title = `${d.title} · Ikisai Organizers`;
    const hours = [hourLabel(d.arrival_time) && `llegada a las ${hourLabel(d.arrival_time)}`, hourLabel(d.departure_time) && `salida a las ${hourLabel(d.departure_time)}`].filter(Boolean).join(' · ');
    replace(head, el('div', { class: 'pagehead orghead', 'data-feedback-id': 'organizers.retiro.cabecera', 'data-feedback-label': 'Cabecera del retiro' },
      el('div', null,
        el('h2', { id: 'retreatTitle' }, d.title),
        el('p', null, dateRange(d.start_date, d.end_date), hours ? el('span', { class: 'muted' }, ` · ${hours}`) : null),
        el('p', { class: 'chips' },
          el('span', { class: `chip status ${STATUS_TONE[d.status]}`, id: 'retreatStatus' }, STATUS_LABELS[d.status] ?? d.status),
          d.code ? el('span', { class: 'muted small', title: 'Código de tu reserva, para hablar con Ikisai' }, ` Reserva ${d.code}`) : null))));

    const showGuests = data.guests.value.mode !== 'ninguno' && !isCancelled(d.status);
    const tabButton = (id: RetreatTab, label: string) => el('a', {
      href: id === 'resumen' ? `#/retiro/${reservationId}` : `#/retiro/${reservationId}/${id}`, role: 'tab', id: `tab-${id}`,
      class: tab === id ? 'on' : '', 'aria-selected': tab === id ? 'true' : 'false',
    }, label);
    replace(tabs, el('nav', { class: 'segmented orgtabs', role: 'tablist', 'aria-label': 'Secciones del retiro' },
      fbMark(tabButton('resumen', 'Resumen'), 'organizers.retiro.pestanas.resumen', 'Resumen'),
      showGuests ? fbMark(tabButton('asistentes', 'Asistentes'), 'organizers.retiro.pestanas.asistentes', 'Asistentes') : null,
      fbMark(tabButton('cocina', 'Cocina'), 'organizers.retiro.pestanas.cocina', 'Cocina')));

    const stale = [data.detail, data.guests, data.kitchen].find((x) => x.stale);
    const content: Child[] = [stale ? staleNote(stale.at) : null];
    if (tab === 'asistentes' && showGuests) content.push(renderGuestList(ctx, reservationId, data, () => void load()));
    else if (tab === 'cocina') content.push(renderKitchen(data.kitchen.value));
    else content.push(...renderSummary(ctx, reservationId, data, showGuests));
    replace(body, ...content);
  }

  void load();
  return () => { alive = false; };
};

function renderSummary(ctx: ViewContext, reservationId: string, data: RetreatData, showGuests: boolean): Child[] {
  const d = data.detail.value;
  const people: Child[] = [];
  if (d.final_guests != null) people.push(el('li', null, `${plural(d.final_guests, 'persona confirmada', 'personas confirmadas')}`));
  else if (d.expected_guests != null) people.push(el('li', null, `${plural(d.expected_guests, 'persona prevista', 'personas previstas')}`));
  if (d.minors_count) people.push(el('li', null, `de ellas, ${plural(d.minors_count, 'menor de edad', 'menores de edad')}`));

  const includes: string[] = [];
  includes.push(d.uses_accommodation ? 'Alojamiento' : 'Sin alojamiento');
  if (d.meal_plan && d.meal_plan !== 'no_aplica') {
    const style = d.menu_style ? `, ${MENU_STYLE_LABELS[d.menu_style] ?? d.menu_style}` : '';
    includes.push(`${MEAL_PLAN_LABELS[d.meal_plan] ?? d.meal_plan}${style}${d.meal_plan_confirmed ? '' : ' (por confirmar)'}`);
  } else includes.push(d.requires_meals ? 'Comidas por concretar' : 'Sin comidas');
  if (d.uses_interpretation_center) includes.push('Centro de interpretación');
  if (d.uses_outdoors) includes.push('Zonas exteriores');
  if (d.uses_pool) includes.push('Piscina');

  const out: Child[] = [
    section('Plazas', { id: 'summaryPeople', 'data-feedback-id': 'organizers.retiro.resumen.plazas', 'data-feedback-label': 'Plazas' },
      people.length ? el('ul', { class: 'plainlist' }, ...people) : el('p', { class: 'muted' }, 'Aún sin concretar.')),
    section('Lo que incluye', { id: 'summaryIncludes', 'data-feedback-id': 'organizers.retiro.resumen.incluye', 'data-feedback-label': 'Lo que incluye' },
      el('ul', { class: 'plainlist' }, ...includes.map((text) => el('li', null, text)))),
  ];

  if (showGuests) {
    const g = data.guests.value;
    let text: string;
    if (!g.confirmed) text = 'Podrás añadir a tus asistentes cuando la reserva esté confirmada.';
    else if (!g.items.length) text = 'Aún no has añadido a nadie.';
    else {
      const complete = g.items.filter((x) => guestComplete(x, g.mode)).length;
      const unsigned = g.mode === 'ses' ? g.items.filter((x) => !x.signed).length : 0;
      text = `${complete} de ${g.items.length} con los datos completos${unsigned ? ` · ${plural(unsigned, 'sin firmar', 'sin firmar')}` : ''}`;
    }
    out.push(section('Asistentes', { id: 'summaryGuests', 'data-feedback-id': 'organizers.retiro.resumen.asistentes', 'data-feedback-label': 'Resumen de asistentes' },
      el('p', null, text),
      g.confirmed ? el('button', { type: 'button', class: 'ghost', id: 'goGuests', 'data-feedback-id': 'organizers.retiro.resumen.ver_asistentes', 'data-feedback-label': 'Ver asistentes', onclick: () => ctx.navigate(`#/retiro/${reservationId}/asistentes`) }, 'Ver asistentes') : null));
  }

  const totals = data.kitchen.value.totals;
  out.push(section('Cocina', { id: 'summaryKitchen', 'data-feedback-id': 'organizers.retiro.resumen.cocina', 'data-feedback-label': 'Resumen de cocina' },
    el('p', null, totals.length ? totals.map((t) => `${restrictionText(t)} · ${t.servings}`).join(' · ') : 'Sin requisitos especiales por ahora.'),
    el('button', { type: 'button', class: 'ghost', id: 'goKitchen', 'data-feedback-id': 'organizers.retiro.resumen.ver_cocina', 'data-feedback-label': 'Ver cocina', onclick: () => ctx.navigate(`#/retiro/${reservationId}/cocina`) }, 'Ver cocina')));
  return out;
}

function renderKitchen(k: KitchenSummary): HTMLElement {
  return el('div', { id: 'kitchen', 'data-feedback-id': 'organizers.cocina.resumen', 'data-feedback-label': 'Cocina' },
    section('Para todo el grupo', { id: 'kitchenTotals' },
      k.totals.length
        ? el('ul', { class: 'plainlist' }, ...k.totals.map((t) => el('li', null, el('strong', null, String(t.servings)), ' · ', restrictionText(t))))
        : el('p', { class: 'muted' }, 'Sin requisitos especiales por ahora.')),
    section('Con nombre', { id: 'kitchenNamed' },
      k.named.length
        ? el('ul', { class: 'plainlist', 'data-feedback-ignore': '' }, ...k.named.map((n) => el('li', null, el('strong', null, n.guest), ' · ', restrictionText(n))))
        : el('p', { class: 'muted' }, 'Aquí verás lo que tú indiques de cada asistente y lo que ellos decidan compartir contigo.')),
    el('p', { class: 'muted small' }, 'Si alguien tiene una alergia, añádela en su ficha o pídele que la indique en su enlace personal.'));
}
