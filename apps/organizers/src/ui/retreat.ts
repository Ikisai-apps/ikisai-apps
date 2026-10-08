/**
 * Ficha del retiro (API.md §9.3, §9.4 y §9.7): cabecera con fechas, horas y estado, y tres pestañas. Las tres lecturas de
 * Booking (detalle, asistentes, cocina) van en paralelo; sin red se pinta la última copia con el aviso.
 */
import { el, icon, replace, type Child } from '@ikisai/ui-kit';
import { t } from '../app/i18n.ts';
import type { Coorganizer, GuestList, KitchenSummary, Loaded, PortalDates, PortalLink, ReservationDetail } from '../app/api.ts';
import { organizersLine } from '../app/texts.ts';
import { dateRange, hourLabel, isCancelled, mealPlanLabel, menuStyleLabel, restrictionText, statusLabel, STATUS_TONE } from '../app/labels.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import { renderGuestList } from './guests.ts';
import { renderDates } from './dates.ts';
import { renderDesign } from './design.ts';
import { renderProposal } from './proposal.ts';
import { renderPayments } from './payments.ts';
import type { ViewContext, ViewMount } from './shell.ts';

export type RetreatTab = 'resumen' | 'fechas' | 'diseno' | 'propuesta' | 'pagos' | 'asistentes' | 'cocina';

/** Estados en que el retiro se está diseñando: las fechas aún se pueden proponer (fase 2). */
export const DESIGN_STATUSES = new Set(['en_estudio', 'negociacion', 'pre_reservada']);
/** Estados en que el borrador se puede editar desde el portal (Booking B7d; si no, `DRAFT_LOCKED`). */
export const DRAFT_STATUSES = new Set(['en_estudio', 'negociacion']);


export interface RetreatData {
  detail: Loaded<ReservationDetail>;
  guests: Loaded<GuestList>;
  kitchen: Loaded<KitchenSummary>;
  links: Loaded<{ items: PortalLink[] }> | null;
  /** Coorganizadores (B11); si la lectura falla, la cabecera sigue sin esa línea. */
  organizers: Coorganizer[];
  /** Fechas (fase 2), solo mientras el retiro se diseña; null si no aplica o no se pudo leer. */
  dates: PortalDates | null;
}

/** Completo: sin datos que falten y, con registro de viajeros, firmado. */
export const guestComplete = (g: { missing: string[]; signed: boolean }, mode: string) => g.missing.length === 0 && (mode !== 'ses' || g.signed);

export const mountRetreat = (reservationId: string, tab: RetreatTab): ViewMount => (ctx) => {
  const { api, main } = ctx;
  let alive = true;
  /** Pestañas con estado propio (fechas, diseño, propuesta): se sueltan al salir o repintar. */
  let destroySub: (() => void) | null = null;
  const head = el('div', { id: 'retreatHead' });
  const tabs = el('div', { id: 'retreatTabs' });
  const body = el('div', { id: 'retreatBody' }, loading());
  replace(main,
    el('a', { class: 'backlink', href: '#/', id: 'backToRetreats', 'data-feedback-id': 'organizers.retiro.cabecera.volver', 'data-feedback-label': 'Mis retiros' }, icon('chevronLeft', 16), t('Mis retiros')),
    head, tabs, body);

  async function load(): Promise<void> {
    try {
      const [detail, guests, kitchen, organizers] = await Promise.all([
        api.detail(reservationId), api.guests(reservationId), api.kitchen(reservationId),
        api.organizers(reservationId).then((x) => x.value.items).catch(() => [] as Coorganizer[]),
      ]);
      // Los enlaces de huésped solo hacen falta en la pestaña Asistentes; si fallan, la lista sigue sin su estado.
      const links = tab === 'asistentes' && guests.value.confirmed ? await api.links(reservationId).catch(() => null) : null;
      if (!alive) return;
      const dates = DESIGN_STATUSES.has(detail.value.status) ? await api.dates(reservationId).then((x) => x.value).catch(() => null) : null;
      if (!alive) return;
      paint({ detail, guests, kitchen, links, organizers, dates });
    } catch (error) {
      if (alive) replace(body, failure(error, () => void load()));
    }
  }

  function paint(data: RetreatData): void {
    const d = data.detail.value;
    document.title = `${d.title} · Ikisai Organizers`;
    const hours = [hourLabel(d.arrival_time) && t('llegada a las {hora}', { hora: hourLabel(d.arrival_time) }), hourLabel(d.departure_time) && t('salida a las {hora}', { hora: hourLabel(d.departure_time) })].filter(Boolean).join(' · ');
    replace(head, el('div', { class: 'pagehead orghead', 'data-feedback-id': 'organizers.retiro.cabecera', 'data-feedback-label': 'Cabecera del retiro' },
      el('div', null,
        el('h2', { id: 'retreatTitle' }, d.title),
        el('p', null, dateRange(d.start_date, d.end_date), hours ? el('span', { class: 'muted' }, ` · ${hours}`) : null),
        el('p', { class: 'chips' },
          el('span', { class: `chip status ${STATUS_TONE[d.status]}`, id: 'retreatStatus' }, statusLabel(d.status)),
          d.code ? el('span', { class: 'muted small', title: t('Código de tu reserva, para hablar con Ikisai') }, ` ${t('Reserva {codigo}', { codigo: d.code })}`) : null),
        organizersLine(data.organizers) ? el('p', { class: 'muted small', id: 'retreatOrganizers', 'data-feedback-ignore': '' }, organizersLine(data.organizers)) : null)));

    const showGuests = data.guests.value.mode !== 'ninguno' && !isCancelled(d.status);
    const showDates = DESIGN_STATUSES.has(d.status);
    const showDesign = DRAFT_STATUSES.has(d.status);
    const showProposal = !isCancelled(d.status);
    // Pagos y facturas (fase 3): desde la prerreserva, cuando ya puede haber señal y facturas.
    const showPayments = !isCancelled(d.status) && !DRAFT_STATUSES.has(d.status);
    const showKitchen = data.guests.value.confirmed;
    const tabButton = (id: RetreatTab, label: string) => el('a', {
      href: id === 'resumen' ? `#/retiro/${reservationId}` : `#/retiro/${reservationId}/${id}`, role: 'tab', id: `tab-${id}`,
      class: tab === id ? 'on' : '', 'aria-selected': tab === id ? 'true' : 'false',
    }, label);
    replace(tabs, el('nav', { class: 'segmented orgtabs', role: 'tablist', 'aria-label': t('Secciones del retiro') },
      fbMark(tabButton('resumen', t('Resumen')), 'organizers.retiro.pestanas.resumen', 'Resumen'),
      showDates ? fbMark(tabButton('fechas', t('Fechas')), 'organizers.retiro.pestanas.fechas', 'Fechas') : null,
      showDesign ? fbMark(tabButton('diseno', t('Diseño')), 'organizers.retiro.pestanas.diseno', 'Diseño') : null,
      showProposal ? fbMark(tabButton('propuesta', t('Propuesta')), 'organizers.retiro.pestanas.propuesta', 'Propuesta') : null,
      showPayments ? fbMark(tabButton('pagos', t('Pagos')), 'organizers.retiro.pestanas.pagos', 'Pagos') : null,
      showGuests ? fbMark(tabButton('asistentes', t('Asistentes')), 'organizers.retiro.pestanas.asistentes', 'Asistentes') : null,
      showKitchen ? fbMark(tabButton('cocina', t('Cocina')), 'organizers.retiro.pestanas.cocina', 'Cocina') : null));

    // Con cinco pestañas en un móvil, la activa se centra en la tira desplazable.
    tabs.querySelector<HTMLElement>('a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    const stale = [data.detail, data.guests, data.kitchen].find((x) => x.stale);
    const content: Child[] = [stale ? staleNote(stale.at) : null];
    destroySub?.();
    destroySub = null;
    const sub = (node: HTMLElement) => { destroySub = () => (node as HTMLElement & { destroy?: () => void }).destroy?.(); content.push(node); };
    if (tab === 'fechas' && showDates) sub(renderDates(ctx, reservationId));
    else if (tab === 'diseno' && showDesign) sub(renderDesign(ctx, reservationId, d, data.dates, () => void load()));
    else if (tab === 'propuesta' && showProposal) sub(renderProposal(ctx, reservationId));
    else if (tab === 'pagos' && showPayments) sub(renderPayments(ctx, reservationId, d.contract ?? null));
    else if (tab === 'asistentes' && showGuests) content.push(renderGuestList(ctx, reservationId, data, () => void load()));
    else if (tab === 'cocina' && showKitchen) content.push(renderKitchen(data.kitchen.value));
    else content.push(...renderSummary(ctx, reservationId, data, showGuests, showDates, showDesign));
    replace(body, ...content);
  }

  void load();
  return () => { alive = false; destroySub?.(); };
};

function renderSummary(ctx: ViewContext, reservationId: string, data: RetreatData, showGuests: boolean, showDates: boolean, showDesign: boolean): Child[] {
  const d = data.detail.value;
  const people: Child[] = [];
  if (d.final_guests != null) people.push(el('li', null, d.final_guests === 1 ? t('1 persona confirmada') : t('{n} personas confirmadas', { n: d.final_guests })));
  else if (d.expected_guests != null) people.push(el('li', null, d.expected_guests === 1 ? t('1 persona prevista') : t('{n} personas previstas', { n: d.expected_guests })));
  if (d.minors_count) people.push(el('li', null, d.minors_count === 1 ? t('de ellas, 1 menor de edad') : t('de ellas, {n} menores de edad', { n: d.minors_count })));

  const includes: string[] = [];
  includes.push(d.uses_accommodation ? t('Alojamiento') : t('Sin alojamiento'));
  if (d.meal_plan && d.meal_plan !== 'no_aplica') {
    const style = d.menu_style ? `, ${menuStyleLabel(d.menu_style)}` : '';
    includes.push(`${mealPlanLabel(d.meal_plan)}${style}${d.meal_plan_confirmed ? '' : ` (${t('por confirmar')})`}`);
  } else includes.push(d.requires_meals ? t('Comidas por concretar') : t('Sin comidas'));
  if (d.uses_interpretation_center) includes.push(t('Centro de interpretación'));
  if (d.uses_outdoors) includes.push(t('Zonas exteriores'));
  if (d.uses_pool) includes.push(t('Piscina'));

  const out: Child[] = [
    showDesign ? section(t('Diseña tu retiro'), { id: 'summaryDesign', 'data-feedback-id': 'organizers.retiro.resumen.diseno', 'data-feedback-label': 'Diseña tu retiro' },
      el('p', null, t('Personas, comidas, alojamiento y extras, con el precio orientativo al momento.')),
      el('button', { type: 'button', class: 'primary', id: 'goDesign', 'data-feedback-id': 'organizers.retiro.resumen.ver_diseno', 'data-feedback-label': 'Diseñar', onclick: () => ctx.navigate(`#/retiro/${reservationId}/diseno`) }, t('Diseñar'))) : null,
    showDates ? section(t('Fechas'), { id: 'summaryDates', 'data-feedback-id': 'organizers.retiro.resumen.fechas', 'data-feedback-label': 'Fechas' },
      el('p', null, data.dates?.mode === 'fixed' && data.dates.definitive ? t('Fecha definitiva: {fechas}', { fechas: dateRange(data.dates.definitive.start, data.dates.definitive.end) }) : t('Marca las fechas que te vienen bien; Ikisai confirmará la definitiva.')),
      el('button', { type: 'button', class: 'ghost', id: 'goDates', 'data-feedback-id': 'organizers.retiro.resumen.ver_fechas', 'data-feedback-label': 'Ver fechas', onclick: () => ctx.navigate(`#/retiro/${reservationId}/fechas`) }, data.dates?.mode === 'fixed' ? t('Ver fechas') : t('Elegir fechas posibles'))) : null,
    section(t('Plazas'), { id: 'summaryPeople', 'data-feedback-id': 'organizers.retiro.resumen.plazas', 'data-feedback-label': 'Plazas' },
      people.length ? el('ul', { class: 'plainlist' }, ...people) : el('p', { class: 'muted' }, t('Aún sin concretar.'))),
    section(t('Lo que incluye'), { id: 'summaryIncludes', 'data-feedback-id': 'organizers.retiro.resumen.incluye', 'data-feedback-label': 'Lo que incluye' },
      el('ul', { class: 'plainlist' }, ...includes.map((text) => el('li', null, text)))),
  ];

  if (showGuests) {
    const g = data.guests.value;
    let text: string;
    if (!g.confirmed) text = t('Podrás añadir a tus asistentes cuando la reserva esté confirmada.');
    else if (!g.items.length) text = t('Aún no has añadido a nadie.');
    else {
      const complete = g.items.filter((x) => guestComplete(x, g.mode)).length;
      const unsigned = g.mode === 'ses' ? g.items.filter((x) => !x.signed).length : 0;
      text = `${t('{hechos} de {total} con los datos completos', { hechos: complete, total: g.items.length })}${unsigned ? ` · ${t('{n} sin firmar', { n: unsigned })}` : ''}`;
    }
    out.push(section(t('Asistentes'), { id: 'summaryGuests', 'data-feedback-id': 'organizers.retiro.resumen.asistentes', 'data-feedback-label': 'Resumen de asistentes' },
      el('p', null, text),
      g.confirmed ? el('button', { type: 'button', class: 'ghost', id: 'goGuests', 'data-feedback-id': 'organizers.retiro.resumen.ver_asistentes', 'data-feedback-label': 'Ver asistentes', onclick: () => ctx.navigate(`#/retiro/${reservationId}/asistentes`) }, t('Ver asistentes')) : null));
  }

  const totals = data.kitchen.value.totals;
  out.push(section(t('Cocina'), { id: 'summaryKitchen', 'data-feedback-id': 'organizers.retiro.resumen.cocina', 'data-feedback-label': 'Resumen de cocina' },
    el('p', null, totals.length ? totals.map((t) => `${restrictionText(t)} · ${t.servings}`).join(' · ') : t('Sin requisitos especiales por ahora.')),
    el('button', { type: 'button', class: 'ghost', id: 'goKitchen', 'data-feedback-id': 'organizers.retiro.resumen.ver_cocina', 'data-feedback-label': 'Ver cocina', onclick: () => ctx.navigate(`#/retiro/${reservationId}/cocina`) }, t('Ver cocina'))));
  return out;
}

function renderKitchen(k: KitchenSummary): HTMLElement {
  return el('div', { id: 'kitchen', 'data-feedback-id': 'organizers.cocina.resumen', 'data-feedback-label': 'Cocina' },
    section(t('Para todo el grupo'), { id: 'kitchenTotals' },
      k.totals.length
        ? el('ul', { class: 'plainlist' }, ...k.totals.map((t) => el('li', null, el('strong', null, String(t.servings)), ' · ', restrictionText(t))))
        : el('p', { class: 'muted' }, t('Sin requisitos especiales por ahora.'))),
    section(t('Con nombre'), { id: 'kitchenNamed' },
      k.named.length
        ? el('ul', { class: 'plainlist', 'data-feedback-ignore': '' }, ...k.named.map((n) => el('li', null, el('strong', null, n.guest), ' · ', restrictionText(n))))
        : el('p', { class: 'muted' }, t('Aquí verás lo que tú indiques de cada asistente y lo que ellos decidan compartir contigo.'))),
    el('p', { class: 'muted small' }, t('Si alguien tiene una alergia, añádela en su ficha o pídele que la indique en su enlace personal.')));
}
