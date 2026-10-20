/**
 * Ficha del retiro (API.md §9.3, §9.4 y §9.7; pasada única, zona 1): portada con fechas, horas y estado, pestañas y el
 * Resumen paso a paso. Las lecturas de Booking (detalle, asistentes, cocina) van en paralelo; sin red se pinta la última
 * copia con el aviso. El Resumen lee además, solo si tocan, los pagos o la propuesta.
 */
import { el, icon, renderCover, renderStages, renderStats, renderSteps, replace, type Child, type Stat } from '@ikisai/ui-kit';
import { i18n, t } from '../app/i18n.ts';
import type { Coorganizer, GuestList, KitchenSummary, Loaded, PortalDates, PortalLink, ReservationDetail } from '../app/api.ts';
import { organizersLine } from '../app/texts.ts';
import { contactLine } from '../app/common-texts.ts';
import { dateRange, dayLabel, hourLabel, isCancelled, mealPlanLabel, menuStyleLabel, restrictionText, statusLabel, STATUS_TONE } from '../app/labels.ts';
import { countdownText, DESIGN_STATUSES, DRAFT_STATUSES, phaseOf, showsCountdown, stageKeyOf, summarySteps, todayMadrid, type SummaryExtra } from '../app/journey.ts';
import { createCoverLoader } from '../app/covers.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import { renderGuestList } from './guests.ts';
import { renderDates } from './dates.ts';
import { renderDesign } from './design.ts';
import { renderProposal } from './proposal.ts';
import { renderPayments } from './payments.ts';
import { renderExperience } from './experience.ts';
import { renderOffers } from './offers.ts';
import { renderKitchen } from './kitchen.ts';
import { pendingJoins, type JoinRequest } from './joins.ts';
import { stagesText } from './retreats.ts';
import type { ViewContext, ViewMount } from './shell.ts';

export type RetreatTab = 'resumen' | 'fechas' | 'diseno' | 'propuesta' | 'pagos' | 'experiencia' | 'ofertas' | 'asistentes' | 'cocina';

export { DESIGN_STATUSES, DRAFT_STATUSES };

export interface RetreatData {
  detail: Loaded<ReservationDetail>;
  guests: Loaded<GuestList>;
  kitchen: Loaded<KitchenSummary>;
  links: Loaded<{ items: PortalLink[] }> | null;
  /** Coorganizadores (B11); si la lectura falla, la cabecera sigue sin esa línea. */
  organizers: Coorganizer[];
  /** Fechas (fase 2), solo mientras el retiro se diseña; null si no aplica o no se pudo leer. */
  dates: PortalDates | null;
  /** Solicitudes para apuntarse que Ikisai pasa al organizador (Booking §26.3); si la lectura falla, ninguna. */
  joinRequests: JoinRequest[];
}

/** Completo: sin datos que falten y, con registro de viajeros, firmado. */
export const guestComplete = (g: { missing: string[]; signed: boolean }, mode: string) => g.missing.length === 0 && (mode !== 'ses' || g.signed);

const day = (date: string) => dayLabel(`${date.slice(0, 10)}T12:00:00Z`);

/** Lecturas extra del Resumen, solo las de la fase: pagos con lo contratado; propuesta y peticiones en el borrador. */
async function loadExtra(ctx: ViewContext, reservationId: string, d: ReservationDetail): Promise<SummaryExtra> {
  const phase = phaseOf(d, todayMadrid());
  if (phase === 'cancelado' || phase === 'finalizado') return {};
  const draft = DRAFT_STATUSES.has(d.status);
  const [money, proposals, requests] = await Promise.all([
    d.contract && !draft ? ctx.api.money(reservationId).then((x) => x.value).catch(() => null) : Promise.resolve(undefined),
    draft ? ctx.api.proposals(reservationId).then((x) => x.value.items).catch(() => null) : Promise.resolve(undefined),
    draft ? ctx.api.myRequests(reservationId).then((x) => x.value.items).catch(() => null) : Promise.resolve(undefined),
  ]);
  return { money, proposals, requests };
}

export const mountRetreat = (reservationId: string, tab: RetreatTab): ViewMount => (ctx) => {
  const { api, main } = ctx;
  let alive = true;
  /** Pestañas con estado propio (fechas, diseño, propuesta): se sueltan al salir o repintar. */
  let destroySub: (() => void) | null = null;
  let coverUrl: string | null = null;
  let lastDetail: { d: ReservationDetail; organizers: Coorganizer[] } | null = null;
  const covers = createCoverLoader({ client: ctx.client, userId: ctx.userId }, (_id, url) => {
    coverUrl = url;
    if (lastDetail) paintHead(lastDetail.d, lastDetail.organizers);
  });
  const head = el('div', { id: 'retreatHead', 'data-feedback-id': 'organizers.retiro.cabecera', 'data-feedback-label': 'Cabecera del retiro' });
  const tabs = el('div', { id: 'retreatTabs', class: 'orgtabs-fade' });
  const body = el('div', { id: 'retreatBody' }, loading());
  replace(main,
    el('a', { class: 'backlink', href: '#/', id: 'backToRetreats', 'data-feedback-id': 'organizers.retiro.cabecera.volver', 'data-feedback-label': 'Mis retiros' }, icon('chevronLeft', 16), t('Mis retiros')),
    head, tabs, body);

  async function load(): Promise<void> {
    try {
      const [detail, guests, kitchen, organizers, joinRequests] = await Promise.all([
        api.detail(reservationId), api.guests(reservationId), api.kitchen(reservationId),
        api.organizers(reservationId).then((x) => x.value.items).catch(() => [] as Coorganizer[]),
        api.readAny<{ items: JoinRequest[] }>('booking.portal_join_requests', { reservation_id: reservationId }).then((x) => x.value.items).catch(() => [] as JoinRequest[]),
      ]);
      // Los enlaces de huésped solo hacen falta en la pestaña Asistentes; si fallan, la lista sigue sin su estado.
      const links = tab === 'asistentes' && guests.value.confirmed ? await api.links(reservationId).catch(() => null) : null;
      if (!alive) return;
      const d = detail.value;
      const [dates, extra] = await Promise.all([
        DESIGN_STATUSES.has(d.status) ? api.dates(reservationId).then((x) => x.value).catch(() => null) : Promise.resolve(null),
        tab === 'resumen' ? loadExtra(ctx, reservationId, d) : Promise.resolve({} as SummaryExtra),
      ]);
      if (!alive) return;
      paint({ detail, guests, kitchen, links, organizers, dates, joinRequests }, extra);
      covers.request(reservationId);
    } catch (error) {
      if (alive) replace(body, failure(error, () => void load()));
    }
  }

  function paintHead(d: ReservationDetail, organizers: Coorganizer[]): void {
    const today = todayMadrid();
    const phase = phaseOf(d, today);
    const hours = [hourLabel(d.arrival_time) && t('llegada a las {hora}', { hora: hourLabel(d.arrival_time) }), hourLabel(d.departure_time) && t('salida a las {hora}', { hora: hourLabel(d.departure_time) })].filter(Boolean).join(' · ');
    const tone = STATUS_TONE[d.status];
    const cover = renderCover({
      title: d.title, image: coverUrl, pill: statusLabel(d.status), pillTone: tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : null,
      stats: `${dateRange(d.start_date, d.end_date)}${hours ? ` · ${hours}` : ''}`, compact: true,
    });
    // La pieza no trae encabezado: el título hace de h2 de la ficha y la píldora conserva los ids de siempre.
    const title = cover.querySelector<HTMLElement>('.cover-title');
    if (title) { title.id = 'retreatTitle'; title.setAttribute('role', 'heading'); title.setAttribute('aria-level', '2'); }
    cover.querySelector<HTMLElement>('.cover-pill')?.setAttribute('id', 'retreatStatus');
    const line = organizersLine(organizers);
    const countdown = showsCountdown(phase) && d.start_date ? el('span', { class: 'chip', id: 'retreatCountdown' }, countdownText(d.start_date, d.end_date, today, t)) : null;
    const code = d.code ? el('span', { class: 'small', title: t('Código de tu reserva, para hablar con Ikisai') }, t('Reserva {codigo}', { codigo: d.code })) : null;
    replace(head, cover,
      countdown || code ? el('p', { class: 'orghead-meta chips' }, countdown, code) : null,
      line ? el('p', { class: 'muted small orghead-meta', id: 'retreatOrganizers', 'data-feedback-ignore': '' }, line) : null);
  }

  /** Pista de que la tira de pestañas sigue a la derecha: se quita al llegar al final. */
  function watchFade(strip: HTMLElement): void {
    const update = () => tabs.classList.toggle('end', strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 4);
    strip.addEventListener('scroll', update, { passive: true });
    requestAnimationFrame(update);
    update();
  }

  function paint(data: RetreatData, extra: SummaryExtra): void {
    const d = data.detail.value;
    document.title = `${d.title} · Ikisai Organizers`;
    lastDetail = { d, organizers: data.organizers };
    paintHead(d, data.organizers);

    const joinsPending = pendingJoins(data.joinRequests).length;
    // Con solicitudes para apuntarse, Asistentes se ve aunque el retiro no recoja datos de huéspedes.
    const showGuests = (data.guests.value.mode !== 'ninguno' || data.joinRequests.length > 0) && !isCancelled(d.status);
    const showDates = DESIGN_STATUSES.has(d.status);
    const showDesign = DRAFT_STATUSES.has(d.status);
    const showProposal = !isCancelled(d.status);
    // Pagos y facturas (fase 3): desde la prerreserva, cuando ya puede haber señal y facturas.
    const showPayments = !isCancelled(d.status) && !DRAFT_STATUSES.has(d.status);
    const showKitchen = data.guests.value.confirmed;
    // Experiencia de Guests (fase 4): desde la prerreserva, como los pagos. Ofertas y cartel (fase 5): en cualquier momento.
    const showExperience = showPayments;
    const showOffers = !isCancelled(d.status);
    const tabButton = (id: RetreatTab, label: string, count = 0) => el('a', {
      href: id === 'resumen' ? `#/retiro/${reservationId}` : `#/retiro/${reservationId}/${id}`, role: 'tab', id: `tab-${id}`,
      class: tab === id ? 'on' : '', 'aria-selected': tab === id ? 'true' : 'false',
    }, label, count ? el('span', { class: 'orgtab-count', 'aria-label': t('{n} por decidir', { n: count }) }, String(count)) : null);
    const strip = el('nav', { class: 'segmented orgtabs', role: 'tablist', 'aria-label': t('Secciones del retiro') },
      fbMark(tabButton('resumen', t('Resumen')), 'organizers.retiro.pestanas.resumen', 'Resumen'),
      showDates ? fbMark(tabButton('fechas', t('Fechas')), 'organizers.retiro.pestanas.fechas', 'Fechas') : null,
      showDesign ? fbMark(tabButton('diseno', t('Diseño')), 'organizers.retiro.pestanas.diseno', 'Diseño') : null,
      showProposal ? fbMark(tabButton('propuesta', t('Propuesta')), 'organizers.retiro.pestanas.propuesta', 'Propuesta') : null,
      showPayments ? fbMark(tabButton('pagos', t('Pagos')), 'organizers.retiro.pestanas.pagos', 'Pagos') : null,
      showExperience ? fbMark(tabButton('experiencia', t('Experiencia')), 'organizers.retiro.pestanas.experiencia', 'Experiencia') : null,
      showOffers ? fbMark(tabButton('ofertas', t('Ofertas')), 'organizers.retiro.pestanas.ofertas', 'Ofertas') : null,
      showGuests ? fbMark(tabButton('asistentes', t('Asistentes'), joinsPending), 'organizers.retiro.pestanas.asistentes', 'Asistentes') : null,
      showKitchen ? fbMark(tabButton('cocina', t('Cocina')), 'organizers.retiro.pestanas.cocina', 'Cocina') : null);
    replace(tabs, strip);
    // Las mismas pestañas, en la sección «Este retiro» del menú lateral.
    const menuTabs: Array<[RetreatTab, string, boolean]> = [
      ['resumen', t('Resumen'), true], ['fechas', t('Fechas'), showDates], ['diseno', t('Diseño'), showDesign], ['propuesta', t('Propuesta'), showProposal],
      ['pagos', t('Pagos'), showPayments], ['experiencia', t('Experiencia'), showExperience], ['ofertas', t('Ofertas'), showOffers],
      ['asistentes', t('Asistentes'), showGuests], ['cocina', t('Cocina'), showKitchen]];
    ctx.setMenuRetreat({ id: reservationId, title: d.title, tabs: menuTabs.filter((x) => x[2]).map(([tab, label]) => ({ tab, label, count: tab === 'asistentes' ? joinsPending : 0 })) });
    watchFade(strip);

    // Con muchas pestañas en un móvil, la activa se centra en la tira desplazable.
    tabs.querySelector<HTMLElement>('a.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    const stale = [data.detail, data.guests, data.kitchen].find((x) => x.stale);
    const content: Child[] = [stale ? staleNote(stale.at, () => void load()) : null];
    destroySub?.();
    destroySub = null;
    const sub = (node: HTMLElement) => { destroySub = () => (node as HTMLElement & { destroy?: () => void }).destroy?.(); content.push(node); };
    if (tab === 'fechas' && showDates) sub(renderDates(ctx, reservationId, d));
    else if (tab === 'diseno' && showDesign) sub(renderDesign(ctx, reservationId, d, data.dates, () => void load()));
    else if (tab === 'propuesta' && showProposal) sub(renderProposal(ctx, reservationId));
    else if (tab === 'pagos' && showPayments) sub(renderPayments(ctx, reservationId, d.contract ?? null));
    else if (tab === 'experiencia' && showExperience) sub(renderExperience(ctx, reservationId, d.status));
    else if (tab === 'ofertas' && showOffers) sub(renderOffers(ctx, reservationId, d));
    else if (tab === 'asistentes' && showGuests) sub(renderGuestList(ctx, reservationId, data, () => void load()));
    else if (tab === 'cocina' && showKitchen) sub(renderKitchen(ctx, reservationId, data));
    else content.push(...renderSummary(ctx, reservationId, data, extra, { showGuests, showKitchen }));
    replace(body, ...content);
  }

  void load();
  return () => { alive = false; destroySub?.(); covers.destroy(); };
};

/** Los pasos del kit llevan `organizers.retiro.resumen.{id}`: aquí se repasan con su id literal (catálogo) y su id del DOM. */
function markSteps(box: HTMLElement): void {
  for (const node of box.querySelectorAll<HTMLElement>('[data-feedback-id]')) {
    switch (node.getAttribute('data-feedback-id')) {
      case 'organizers.retiro.resumen.ver_solicitudes': fbMark(node, 'organizers.retiro.resumen.ver_solicitudes', 'Ver solicitudes'); node.id = 'goJoins'; break;
      case 'organizers.retiro.resumen.ver_fechas': fbMark(node, 'organizers.retiro.resumen.ver_fechas', 'Ver fechas'); node.id = 'goDates'; break;
      case 'organizers.retiro.resumen.ver_diseno': fbMark(node, 'organizers.retiro.resumen.ver_diseno', 'Diseñar'); node.id = 'goDesign'; break;
      case 'organizers.retiro.resumen.paso_propuesta': fbMark(node, 'organizers.retiro.resumen.paso_propuesta', 'Paso de la propuesta'); break;
      case 'organizers.retiro.resumen.paso_pagos': fbMark(node, 'organizers.retiro.resumen.paso_pagos', 'Paso de los pagos'); break;
      case 'organizers.retiro.resumen.paso_asistentes': fbMark(node, 'organizers.retiro.resumen.paso_asistentes', 'Paso de los asistentes'); break;
      default: break;
    }
  }
}

function renderSummary(ctx: ViewContext, reservationId: string, data: RetreatData, extra: SummaryExtra, show: { showGuests: boolean; showKitchen: boolean }): Child[] {
  const d = data.detail.value;
  const g = data.guests.value;
  const today = todayMadrid();
  const phase = phaseOf(d, today);
  const go = (tab: string) => () => ctx.navigate(`#/retiro/${reservationId}/${tab}`);
  const out: Child[] = [];

  // 1-2 · Paso a paso, o el fin del recorrido.
  if (phase === 'cancelado') {
    out.push(section(t('Este retiro está cancelado'), { id: 'summaryEnd', 'data-feedback-id': 'organizers.retiro.resumen.fin', 'data-feedback-label': 'Fin del recorrido' },
      el('p', null, t('Si quieres repetirlo, escríbenos y lo volvemos a preparar.')),
      el('p', { class: 'muted' }, contactLine())));
  } else if (phase === 'finalizado') {
    out.push(section(t('Tu retiro ha terminado'), { id: 'summaryEnd', 'data-feedback-id': 'organizers.retiro.resumen.fin', 'data-feedback-label': 'Fin del recorrido' },
      el('p', null, t('Puedes repetirlo con una oferta nueva o compartir los materiales.')),
      el('button', { type: 'button', class: 'primary', id: 'goOffers', 'data-feedback-id': 'organizers.retiro.resumen.preparar_oferta', 'data-feedback-label': 'Preparar una oferta', onclick: go('ofertas') }, t('Preparar una oferta'))));
  } else {
    const joins = pendingJoins(data.joinRequests);
    const steps = summarySteps({
      detail: d, guests: g, dates: data.dates,
      joins: { requests: joins.length, persons: joins.reduce((n, j) => n + j.persons.length, 0) },
    }, extra, today, { t, money: (n) => i18n.formatMoney(n), day, range: dateRange });
    const box = renderSteps({
      items: steps.map((s) => ({ id: s.id, title: s.title, done: s.done, stateText: s.stateText, action: s.action, onClick: go(s.tab) })),
      readyText: t('Nada pendiente por tu parte. Si algo cambia, lo verás aquí.'),
      feedbackId: 'organizers.retiro.resumen',
    });
    markSteps(box);
    out.push(el('p', { class: 'orgsec' }, t('Tu retiro, paso a paso')), box);
    if (extra.money === null || extra.proposals === null || extra.requests === null) out.push(el('p', { class: 'hint' }, t('Sin conexión: puede que falte algún paso (pagos o propuesta).')));
  }

  // 3 · El recorrido entero.
  out.push(renderStages({ label: t('Recorrido de {titulo}', { titulo: d.title }), stages: stagesText(), current: stageKeyOf(d, today), feedbackId: 'organizers.retiro.resumen.recorrido' }));

  // 4 · Cifras, solo con lo ya leído.
  const stats: Stat[] = [];
  const people = d.final_guests ?? d.expected_guests;
  if (people != null) stats.push({ value: people, label: d.final_guests != null ? t('personas confirmadas') : t('personas previstas') });
  if (g.confirmed && g.items.length) {
    const complete = g.items.filter((x) => guestComplete(x, g.mode)).length;
    stats.push({ value: `${complete}/${g.items.length}`, label: t('asistentes con los datos completos'), onClick: go('asistentes'), feedbackId: 'organizers.retiro.resumen.cifra_asistentes' });
  }
  const totals = data.kitchen.value.totals;
  if (totals.length) {
    stats.push({
      value: totals.reduce((n, x) => n + x.servings, 0), label: t('raciones con requisitos especiales'),
      ...(show.showKitchen ? { onClick: go('cocina'), feedbackId: 'organizers.retiro.resumen.cifra_cocina' } : {}),
    });
  }
  if (stats.length) out.push(renderStats(stats, { label: t('Así va tu retiro') }));

  // 5 · Detalles del retiro: las tarjetas de siempre.
  out.push(el('p', { class: 'orgsec' }, t('Detalles del retiro')));
  if (show.showGuests) {
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
      g.confirmed ? el('button', { type: 'button', class: 'ghost', id: 'goGuests', 'data-feedback-id': 'organizers.retiro.resumen.ver_asistentes', 'data-feedback-label': 'Ver asistentes', onclick: go('asistentes') }, t('Ver asistentes')) : null));
  }
  out.push(section(t('Cocina'), { id: 'summaryKitchen', 'data-feedback-id': 'organizers.retiro.resumen.cocina', 'data-feedback-label': 'Resumen de cocina' },
    el('p', null, totals.length ? totals.map((x) => `${restrictionText(x)} · ${x.servings}`).join(' · ') : t('Sin requisitos especiales por ahora.')),
    el('button', { type: 'button', class: 'ghost', id: 'goKitchen', 'data-feedback-id': 'organizers.retiro.resumen.ver_cocina', 'data-feedback-label': 'Ver cocina', onclick: go('cocina') }, t('Ver cocina'))));

  const peopleList: Child[] = [];
  if (d.final_guests != null) peopleList.push(el('li', null, d.final_guests === 1 ? t('1 persona confirmada') : t('{n} personas confirmadas', { n: d.final_guests })));
  else if (d.expected_guests != null) peopleList.push(el('li', null, d.expected_guests === 1 ? t('1 persona prevista') : t('{n} personas previstas', { n: d.expected_guests })));
  if (d.minors_count) peopleList.push(el('li', null, d.minors_count === 1 ? t('de ellas, 1 menor de edad') : t('de ellas, {n} menores de edad', { n: d.minors_count })));
  out.push(section(t('Plazas'), { id: 'summaryPeople', 'data-feedback-id': 'organizers.retiro.resumen.plazas', 'data-feedback-label': 'Plazas' },
    peopleList.length ? el('ul', { class: 'plainlist' }, ...peopleList) : el('p', { class: 'muted' }, t('Aún sin concretar.'))));

  const includes: string[] = [];
  includes.push(d.uses_accommodation ? t('Alojamiento') : t('Sin alojamiento'));
  if (d.meal_plan && d.meal_plan !== 'no_aplica') {
    const style = d.menu_style ? `, ${menuStyleLabel(d.menu_style)}` : '';
    includes.push(`${mealPlanLabel(d.meal_plan)}${style}${d.meal_plan_confirmed ? '' : ` (${t('por confirmar')})`}`);
  } else includes.push(d.requires_meals ? t('Comidas por concretar') : t('Sin comidas'));
  if (d.uses_interpretation_center) includes.push(t('Centro de interpretación'));
  if (d.uses_outdoors) includes.push(t('Zonas exteriores'));
  if (d.uses_pool) includes.push(t('Piscina'));
  out.push(section(t('Lo que incluye'), { id: 'summaryIncludes', 'data-feedback-id': 'organizers.retiro.resumen.incluye', 'data-feedback-label': 'Lo que incluye' },
    el('ul', { class: 'plainlist' }, ...includes.map((text) => el('li', null, text)))));
  return out;
}
