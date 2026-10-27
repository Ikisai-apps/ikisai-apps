import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, createCoverCarousel, el, icon, listRow, openSheet, plural, renderMedal, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  COMMERCIAL_STAGES, EVENT_TYPES, PHASES, PHASE_LABELS, TABLES, canHoldStatus, commercialStageLabel, dayNumber, foldText, missingForConfirmation, nextText, nights, validateFields,
  type CommercialStage, type Phase, type ReservationStatus,
} from '@ikisai/domain-booking';
import { guard } from '../app/guard.ts';
import {
  DATE_OPTIONS, EVENT_TYPE_LABELS, EVENTS, FINANCE, GUESTS, NEEDS, PROPOSALS, RESERVATIONS, ASSIGNMENTS, PORTAL_REQUESTS, canRead, canWrite, dateRange, describeError, statusLabel, today,
  type ReservationRow,
} from '../app/client.ts';
import { PHASE_COLORS, loadExperiences, onSesPending, resetSesWatch, requestBlock, type ExperienceSet, type ReservationView } from '../app/experience.ts';
import { onLogos, retreatLogos } from '../app/logos.ts';
import type { ViewMount } from './shell.ts';
import { fbIgnore, fbMark } from './feedback.ts';

type Filter = 'proximas' | 'activas' | 'pre' | 'confirmadas' | 'cerradas' | 'canceladas';

const FILTERS: Array<[Filter, string]> = [
  ['proximas', 'Próximas'], ['activas', 'Activas'], ['pre', 'Pre-reservas'], ['confirmadas', 'Confirmadas'], ['cerradas', 'Cerradas'], ['canceladas', 'Canceladas'],
];
const OPEN: ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada', 'confirmada', 'en_ejecucion'];
const MISSING_LABELS = { start_date: 'la fecha de entrada', end_date: 'la fecha de salida', expected_guests: 'el número de personas' } as const;
const RUSH_MAX = 4;
const COVER_MAX = 5;

function matches(row: ReservationRow, filter: Filter, now: number): boolean {
  switch (filter) {
    case 'proximas': return OPEN.includes(row.status) && (dayNumber(row.end_date) ?? Infinity) >= now;
    case 'activas': return OPEN.includes(row.status);
    case 'pre': return row.status === 'pre_reservada';
    case 'confirmadas': return row.status === 'confirmada' || row.status === 'en_ejecucion';
    case 'cerradas': return row.status === 'cerrada';
    case 'canceladas': return row.status === 'cancelada' || row.status === 'perdida';
  }
}

interface FormValues {
  title: string;
  event_type: string;
  status: string;
  start_date: string;
  end_date: string;
  expected_guests: string;
  contact_name: string;
  contact_phone: string;
  /** Jornadas abiertas (0499): cómo se pagan las noches que se piden por el QR. */
  lodging_pay_mode: string;
  lodging_hold_hours: string;
}

function valuesOf(dates: { start?: string; end?: string } = {}): FormValues {
  return { title: '', event_type: 'retiro', status: 'en_estudio', start_date: dates.start ?? '', end_date: dates.end ?? '', expected_guests: '', contact_name: '', contact_phone: '', lodging_pay_mode: 'hold', lodging_hold_hours: '2' };
}

/** «Nueva reserva con estas fechas» desde el Calendario: el alta se abre al montar Reservas con las fechas puestas. */
let requestedDates: { start: string; end: string } | null = null;
export function requestNewReservation(start: string, end: string): void { requestedDates = { start, end }; }

function toFields(values: FormValues): Record<string, unknown> {
  const guests = values.expected_guests.trim();
  return {
    title: values.title.trim(),
    event_type: values.event_type,
    status: values.status,
    start_date: values.start_date || null,
    end_date: values.end_date || null,
    expected_guests: guests === '' ? null : Number(guests),
    contact_name: values.contact_name.trim() || null,
    contact_phone: values.contact_phone.trim() || null,
    ...(values.event_type === 'jornadas_abiertas' ? {
      lodging_pay_mode: values.lodging_pay_mode,
      ...(values.lodging_pay_mode === 'hold' ? { lodging_hold_hours: Number(values.lodging_hold_hours) || 2 } : {}),
    } : {}),
  };
}

/**
 * Reservas (tanda 27, MUELA-009 y 067 §2): la portada de las próximas que se pasa con flechas, «Corre prisa», la lista
 * por fases con «Siguiente: …» y la preparación por áreas, el grupo comercial como embudo y tablero, filtros con su
 * recuento y búsqueda sin tildes en todas. El alta y la papelera, como siempre; vaciarla, desactivado con su motivo.
 */
export const mountReservations: ViewMount = ({ main, client, navigate }) => {
  let rows: ReservationRow[] = [];
  let set: ExperienceSet | null = null;
  let filter: Filter = 'proximas';
  let query = '';
  let sheet: Sheet | null = null;
  let coverIndex = 0;
  let rushOpen = false;
  const writable = canWrite(client);
  resetSesWatch();

  const search = el('input', { type: 'search', id: 'reservationSearch', 'data-feedback-id': 'booking.reservas.buscador.campo', 'data-feedback-label': 'Buscar reservas', placeholder: 'Buscar por nombre, contacto o código', 'aria-label': 'Buscar reservas', autocomplete: 'off',
    'aria-describedby': 'reservationSearchScope', oninput: () => { query = foldText(search.value); paint(); } });
  const searchScope = el('p', { class: 'hint', id: 'reservationSearchScope', 'aria-live': 'polite' });
  const filterBar = el('div', { class: 'filters bk-filters', role: 'group', 'aria-label': 'Filtrar reservas', 'data-feedback-id': 'booking.reservas.filtros', 'data-feedback-label': 'Filtros' });
  const count = el('span', { class: 'count', id: 'reservationCount' }, '0');
  const coverHost = el('div', { 'data-feedback-id': 'booking.reservas.portada', 'data-feedback-label': 'La próxima' });
  const rushHost = el('div', { 'data-feedback-id': 'booking.reservas.prisa', 'data-feedback-label': 'Corre prisa' });
  const listHost = el('div', { 'data-feedback-id': 'booking.reservas.lista', 'data-feedback-label': 'Lista de reservas' });
  const trashList = el('ul', { class: 'list', 'aria-label': 'Reservas en la papelera', 'data-feedback-id': 'booking.reservas.papelera.lista', 'data-feedback-label': 'Reservas en la papelera' });
  const trashCount = el('span', { class: 'count', id: 'trashCount' }, '0');
  const owner = client.bootstrap()?.membership.role === 'owner';
  // Vaciar borra en el servidor: sin red, o con cambios sin enviar, queda desactivado y dice por qué (se activa solo).
  const emptyWhy = el('p', { class: 'hint', id: 'emptyTrashWhy', hidden: true });
  const emptyButton = owner ? el('button', { class: 'danger small', type: 'button', id: 'emptyTrash', 'data-feedback-id': 'booking.reservas.papelera.vaciar', 'data-feedback-label': 'Vaciar papelera',
    onclick: () => { if (emptyButton!.getAttribute('aria-disabled') !== 'true') void emptyTrash(); } }, icon('trash', 16), 'Vaciar papelera') : null;
  const trash = el('details', { id: 'trash', hidden: true, 'data-feedback-id': 'booking.reservas.papelera', 'data-feedback-label': 'Papelera' }, el('summary', { class: 'sectionlabel', style: 'cursor:pointer' }, 'Papelera', trashCount), trashList,
    emptyButton ? el('div', { style: 'margin-top:10px' }, emptyButton, emptyWhy) : null);

  function paintEmptyState(): void {
    if (!emptyButton) return;
    const status = client.status();
    const why = !navigator.onLine || status.network === 'offline' ? 'Sin conexión: vaciar la papelera borra en el servidor. Se activa sola cuando vuelva la red.'
      : status.pendingCommands > 0 ? 'Hay cambios sin enviar: vaciar la papelera espera a que se envíen. Se activa sola.' : null;
    emptyButton.setAttribute('aria-disabled', String(why !== null));
    if (why) emptyButton.setAttribute('aria-describedby', 'emptyTrashWhy'); else emptyButton.removeAttribute('aria-describedby');
    emptyWhy.hidden = why === null;
    emptyWhy.textContent = why ?? '';
  }

  /**
   * Borrado definitivo de todo lo que hay en la papelera de Booking (contrato §11.2: solo el propietario, con recuento).
   * El orden va de hijos a padres para respetar las claves ajenas.
   */
  async function emptyTrash(): Promise<void> {
    if (!navigator.onLine) return void toast('Vaciar la papelera necesita conexión.');
    if (client.status().pendingCommands > 0) return void toast('Hay cambios sin sincronizar. Espera a que se envíen antes de vaciar la papelera.');
    const tables = [TABLES.checklist, TABLES.restrictions, TABLES.roomAssignments, TABLES.eventExtraBeds, TABLES.staffAssignments, TABLES.staffNeeds, GUESTS, EVENTS, FINANCE, RESERVATIONS, TABLES.beds, TABLES.spaces];
    const counts = await Promise.all(tables.map(async (table) => ((await client.list(table, { includeDeleted: true })).filter((row) => row.deleted_at !== null).length)));
    const reservations = counts[tables.indexOf(RESERVATIONS)]!;
    const others = counts.reduce((sum, n) => sum + n, 0) - reservations;
    const go = await confirmDialog({
      title: 'Vaciar papelera',
      text: `Se borran definitivamente ${plural(reservations, 'reserva', 'reservas')} y ${plural(others, 'elemento asociado', 'elementos asociados')} (eventos, huéspedes, restricciones, tareas, importes, asignaciones de alojamiento, supletorias activadas, turnos y refuerzos del personal, camas y espacios). No se puede deshacer.`,
      confirmLabel: 'Vaciar papelera', danger: true,
    });
    if (!go) return;
    try {
      const out = await client.api<{ purged: number }>('/trash/purge', { method: 'POST', json: { requestId: `purge-${crypto.randomUUID()}`, tables } });
      await client.sync();
      toast(`Papelera vaciada: ${plural(out.purged, 'elemento borrado', 'elementos borrados')}.`);
    } catch (error) {
      const e = error as { code?: string; details?: { reason?: string } };
      if (e.code === 'INVALID_OPERATION' && e.details?.reason === 'calendar event still alive') toast('Alguna reserva de la papelera aún tiene su evento en Google Calendar. Se retira solo en unos minutos; inténtalo después.');
      else if (e.code === 'CONSTRAINT_VIOLATION') toast('No se puede vaciar: algún evento de la papelera tiene un menú en Food. Pide a cocina que lo retire.');
      else toast(describeError(error));
    }
  }
  let deleted: ReservationRow[] = [];

  replace(
    main,
    el('div', { class: 'pagehead' }, el('div', null, el('h2', null, 'Reservas'), el('p', null, 'Del primer contacto al cierre: qué le falta a cada una y qué corre prisa.'))),
    el('div', { class: 'toolbar', 'data-feedback-id': 'booking.reservas.buscador', 'data-feedback-label': 'Buscador' }, el('div', { class: 'search' }, search)),
    searchScope,
    filterBar,
    coverHost,
    rushHost,
    el('div', { class: 'sectionlabel' }, 'Reservas', count),
    listHost,
    trash,
    writable ? el('button', { class: 'fab', type: 'button', id: 'newReservation', 'data-feedback-id': 'booking.reservas.nueva', 'data-feedback-label': 'Nueva reserva', onclick: () => openForm() }, icon('plus'), 'Nueva reserva') : null,
  );

  function paintFilters(): void {
    const now = dayNumber(today())!;
    const live = rows.filter((r) => !r.archived_at);
    replace(filterBar, FILTERS.map(([key, label]) => {
      const n = live.filter((r) => matches(r, key, now)).length;
      return el('button', {
        class: `softbtn${filter === key ? ' active' : ''}`, type: 'button', 'aria-pressed': String(filter === key), dataset: { filter: key }, 'data-feedback-id': 'booking.reservas.filtros.filtro', 'data-feedback-label': 'Filtro',
        'aria-label': `${label}: ${n}`, onclick: () => { filter = key; paintFilters(); paint(); },
      }, label, el('span', { class: 'bk-filter-count', 'aria-hidden': 'true' }, String(n)));
    }));
  }

  const medalOf = (v: ReservationView, size = 44) => renderMedal({ name: v.reservation.title, image: retreatLogos(client).get(v.reservation.id) ?? null, color: PHASE_COLORS[v.x.phase], size });
  const metaOf = (r: ReservationRow) => {
    const n = nights(r.start_date, r.end_date);
    return [dateRange(r), r.expected_guests !== null ? plural(r.expected_guests, 'persona', 'personas') : null, n !== null ? plural(n, 'noche', 'noches') : null,
      EVENT_TYPE_LABELS[r.event_type] ?? r.event_type, r.code ?? 'código pendiente'];
  };
  const chipsOf = (r: ReservationRow) => [el('span', { class: 'chip', dataset: { status: r.status } }, statusLabel(r.status)),
    r.guests_visible ? el('span', { class: 'chip', dataset: { open: '' } }, 'Visible para huéspedes') : null].filter((c): c is HTMLElement => c !== null);
  const open = (v: ReservationView, toStep = false) => { if (toStep) requestBlock(v.reservation.id, v.x.next?.block ?? null); navigate(`#/reservas/${v.reservation.id}`); };

  /** Una fila: medallón, nombre, chips y datos de hoy; debajo, a todo el ancho, «Siguiente», la cuenta atrás y las áreas. */
  function row(v: ReservationView): HTMLElement {
    const r = v.reservation;
    const node = fbMark(listRow({ id: r.id, title: r.title, meta: metaOf(r), chips: chipsOf(r), pending: r._pending === true, onClick: () => open(v), label: `Abrir ${r.title}` }), 'booking.reservas.lista.fila', 'Reserva');
    node.classList.add('bk-res');
    node.querySelector('.row-title')?.prepend(el('span', { class: 'bk-res-medal' }, medalOf(v)));
    node.append(el('div', { class: 'bk-res-next' },
      el('span', { class: `bk-next${v.x.next?.tone ? ` ${v.x.next.tone}` : ''}` }, '› ', nextText(v.x, set?.seesAll ?? false)),
      v.x.rush && v.x.daysLeft !== null ? el('span', { class: 'chip warn' }, v.x.phase === 'curso' ? 'En curso' : v.x.daysLeft <= 1 ? (v.x.daysLeft === 0 ? 'Hoy' : 'Mañana') : `Faltan ${v.x.daysLeft} días`) : null));
    if (v.x.areas.length) node.append(el('span', { class: 'bk-areas' }, v.x.areas.map((a) => el('span', { class: `bk-area ${a.ok ? 'ok' : 'warn'}` }, el('span', { 'aria-hidden': 'true' }, a.ok ? '✓ ' : '! '), el('span', { class: 'vh' }, a.ok ? 'Listo: ' : 'Pendiente: '), a.text))));
    return node;
  }

  /** Comercial como captación: embudo compacto (de Confirmada a Primer contacto) y un tablero por etapa. */
  function commercial(views: ReservationView[], confirmed: ReservationView[]): HTMLElement {
    const seesMoney = set?.seesMoney ?? false;
    const stageOf = (v: ReservationView): CommercialStage => v.x.commercial ?? 'contacto';
    const stages = [...COMMERCIAL_STAGES].reverse();
    const at = (s: CommercialStage) => (s === 'confirmada' ? confirmed : views.filter((v) => stageOf(v) === s));
    const reached = (s: CommercialStage) => stages.slice(0, stages.indexOf(s) + 1).reduce((sum, k) => sum + at(k).length, 0);
    const entered = reached('contacto');
    const pct = entered ? Math.round((at('confirmada').length / entered) * 100) : 0;
    const columns = el('div', { class: 'bk-board', id: 'commercialBoard', tabindex: '0', role: 'region', 'aria-label': 'Tablero comercial' }, stages.map((s) => {
      const list = at(s);
      const people = list.reduce((sum, v) => sum + (v.reservation.expected_guests ?? 0), 0);
      return el('section', { class: 'bk-col', id: `stage-${s}`, 'aria-label': commercialStageLabel(s, seesMoney) },
        el('h4', null, commercialStageLabel(s, seesMoney), el('span', { class: 'count' }, String(list.length)), people ? el('span', { class: 'hint' }, ` · ${plural(people, 'persona', 'personas')}`) : null),
        s === 'confirmada'
          ? el('p', { class: 'hint' }, list.length ? `${list.slice(0, 5).map((v) => v.reservation.title).join(', ')}${list.length > 5 ? ` y ${list.length - 5} más` : ''}. Viven arriba, en ${livesIn(list)}.` : 'Ninguna todavía.')
          : list.length ? el('ul', { class: 'list' }, list.map((v) => {
              const node = row(v);
              const n = COMMERCIAL_STAGES.indexOf(s) + 1;
              node.querySelector('.bk-res-next')?.prepend(el('span', { class: 'bk-dots', role: 'img', 'aria-label': `Paso ${n} de 4` }, [1, 2, 3, 4].map((i) => el('span', { class: i <= n ? 'on' : null }))));
              return node;
            })) : el('p', { class: 'hint' }, 'Ninguna.'));
    }));
    const funnel = el('p', { class: 'bk-funnel', id: 'commercialFunnel' },
      stages.map((s, i) => [i ? el('span', { 'aria-hidden': 'true' }, ' ‹ ') : null,
        el('button', { type: 'button', class: 'linkbtn', 'data-feedback-id': 'booking.reservas.comercial.embudo', 'data-feedback-label': 'Ir a la etapa', 'aria-label': `${commercialStageLabel(s, seesMoney)}: ${reached(s)}`,
          onclick: () => columns.querySelector<HTMLElement>(`#stage-${s}`)?.scrollIntoView({ block: 'nearest', inline: 'start' }) }, String(reached(s)))]),
      el('span', null, entered ? ` · ${pct} % de las que entraron, confirmadas` : ''));
    return el('section', { class: 'bk-phase bk-commercial', id: 'phase-comercial', 'data-feedback-id': 'booking.reservas.comercial', 'data-feedback-label': 'Comercial' },
      el('h3', { class: 'sectionlabel' }, 'Comercial', el('span', { class: 'count' }, String(views.length))),
      el('p', { class: 'hint' }, 'Llegaron ', funnel), columns);
  }

  function paint(): void {
    if (!set) return;
    const now = dayNumber(today())!;
    const searching = query.length > 0;
    // Con búsqueda escrita se busca en todas, sin tildes, y se dice.
    const visible = set.views
      .filter((v) => (searching ? true : matches(v.reservation, filter, now)))
      .filter((v) => !searching || [v.reservation.title, v.reservation.contact_name, v.reservation.code].some((s) => typeof s === 'string' && foldText(s).includes(query)))
      .sort((a, b) => (dayNumber(a.reservation.start_date) ?? Infinity) - (dayNumber(b.reservation.start_date) ?? Infinity) || a.reservation.title.localeCompare(b.reservation.title, 'es'));
    searchScope.textContent = searching ? `Buscando en todas las reservas: ${plural(visible.length, 'resultado', 'resultados')}.` : '';
    count.textContent = String(visible.length);
    trash.hidden = deleted.length === 0;
    trashCount.textContent = String(deleted.length);
    replace(trashList, deleted.map((r) => fbMark(listRow({ id: r.id, title: r.title, meta: [dateRange(r), r.code ?? 'código pendiente'], deleted: true, pending: r._pending === true,
      onClick: () => navigate(`#/reservas/${r.id}`), label: `Abrir ${r.title} en la papelera` }), 'booking.reservas.papelera.fila', 'Reserva en la papelera')));

    // La portada de las próximas (2 a 5, sin canceladas, cerradas ni perdidas). Con búsqueda, no se pinta.
    const nextOnes = set.views.filter((v) => ['comercial', 'preparacion', 'curso'].includes(v.x.phase) && v.reservation.start_date && (dayNumber(v.reservation.end_date) ?? Infinity) >= now)
      .sort((a, b) => (dayNumber(a.reservation.start_date) ?? 0) - (dayNumber(b.reservation.start_date) ?? 0)).slice(0, COVER_MAX);
    if (searching || nextOnes.length === 0) replace(coverHost);
    else {
      coverIndex = Math.min(coverIndex, nextOnes.length - 1);
      const logos = retreatLogos(client);
      const carousel = createCoverCarousel({
        label: 'Las próximas reservas', index: coverIndex, feedbackId: 'booking.reservas.portada.carrusel',
        slides: nextOnes.map((v, i) => ({ id: v.reservation.id, title: v.reservation.title, image: logos.get(v.reservation.id) ?? null, color: PHASE_COLORS[v.x.phase],
          state: `${i === 0 ? 'La próxima' : `${i + 1}.ª`} · ${statusLabel(v.reservation.status)}`, meta: [dateRange(v.reservation), v.x.people, metaOf(v.reservation)[2]].filter(Boolean).join(' · ') })),
        onChange: (_slide, i) => { coverIndex = i; paintCoverOpen(); },
      });
      carousel.element.id = 'nextCover';
      const arrows = carousel.element.querySelectorAll<HTMLButtonElement>('.cover-arrow');
      arrows[0]?.setAttribute('id', 'nextCoverPrev');
      arrows[1]?.setAttribute('id', 'nextCoverNext');
      const openButton = el('button', { type: 'button', class: 'primary', id: 'nextCoverOpen', 'data-feedback-id': 'booking.reservas.portada.abrir', 'data-feedback-label': 'Abrir la reserva', onclick: () => open(nextOnes[carousel.index()]!) }, 'Abrir');
      const paintCoverOpen = () => openButton.setAttribute('aria-label', `Abrir la portada de ${nextOnes[carousel.index()]!.reservation.title}`);
      paintCoverOpen();
      replace(coverHost, carousel.element, el('p', { class: 'bk-cover-open' }, openButton));
    }

    // «Corre prisa»: hasta 4 con su motivo y «y n más».
    const rush = searching ? [] : visible.filter((v) => v.x.rush).sort((a, b) => b.x.score - a.x.score);
    replace(rushHost, rush.length === 0 ? null : el('section', { class: 'bk-rush', id: 'rushBand', 'aria-label': `Corre prisa: ${rush.length}` },
      el('h3', { class: 'sectionlabel' }, 'Corre prisa', el('span', { class: 'count' }, String(rush.length))),
      el('ul', { class: 'bk-rush-list' }, (rushOpen ? rush : rush.slice(0, RUSH_MAX)).map((v) => el('li', null,
        el('button', { type: 'button', class: 'bk-rush-item', 'data-feedback-id': 'booking.reservas.prisa.fila', 'data-feedback-label': 'Reserva con prisa', onclick: () => open(v, true) },
          medalOf(v, 40), el('span', null, el('strong', null, v.reservation.title), el('span', { class: 'bk-rush-why' }, v.x.rush)))))),
      rush.length > RUSH_MAX ? el('button', { type: 'button', class: 'linkbtn', id: 'rushMore', 'aria-expanded': String(rushOpen), 'data-feedback-id': 'booking.reservas.prisa.mas', 'data-feedback-label': 'Ver más con prisa',
        onclick: () => { rushOpen = !rushOpen; paint(); } }, rushOpen ? 'Ver menos' : `y ${rush.length - RUSH_MAX} más ›`) : null));

    if (visible.length === 0) {
      replace(listHost, el('div', { class: 'empty', 'data-feedback-id': 'booking.reservas.lista.vacia', 'data-feedback-label': 'Lista vacía' }, rows.length === 0
        ? [el('strong', null, 'Todavía no hay reservas'), writable ? 'Crea la primera con «Nueva reserva». Funciona también sin conexión.' : 'Cuando alguien cree una reserva aparecerá aquí.']
        : 'Ninguna reserva coincide con el filtro o la búsqueda.'));
      return;
    }
    // Por fases, con su recuento. Con búsqueda, una sola lista.
    const byPhase = new Map<Phase, ReservationView[]>(PHASES.map((p) => [p, visible.filter((v) => v.x.phase === p)]));
    const confirmed = visible.filter((v) => ['preparacion', 'curso', 'cierre'].includes(v.x.phase));
    replace(listHost, el('div', { id: 'reservationList' }, searching
      ? el('ul', { class: 'list', 'aria-label': 'Resultados' }, visible.map(row))
      : PHASES.filter((p) => byPhase.get(p)!.length > 0).map((p) => p === 'comercial'
        ? commercial(byPhase.get(p)!, confirmed)
        : el('section', { class: 'bk-phase', id: `phase-${p}` },
            el('h3', { class: 'sectionlabel' }, PHASE_LABELS[p], el('span', { class: 'count' }, String(byPhase.get(p)!.length))),
            el('ul', { class: 'list', 'aria-label': PHASE_LABELS[p] }, byPhase.get(p)!.map(row))))));
  }

  /** Hoja de alta. La edición de una reserva vive en su ficha. */
  function openForm(dates: { start?: string; end?: string } = {}): void {
    const initial = valuesOf(dates);
    const blank = valuesOf();
    const field = (label: string, control: HTMLElement, key: string) => el('label', { class: 'field', 'data-feedback-id': `booking.reservas.alta.${key}`, 'data-feedback-label': label }, el('span', null, label), control);
    const input = (id: string, type: string, value: string, extra: Record<string, string | number | boolean> = {}) =>
      el('input', { id, type, value, autocomplete: 'off', oninput: onChange, ...extra });
    const select = (id: string, options: Array<[string, string]>, value: string) => {
      const node = el('select', { id, onchange: onChange }, options.map(([v, text]) => el('option', { value: v }, text)));
      node.value = value;
      return node;
    };

    const title = input('resTitle', 'text', initial.title, { maxlength: 200, required: true });
    const type = select('resType', EVENT_TYPES.map((t) => [t, EVENT_TYPE_LABELS[t]]), initial.event_type);
    // «Confirmada» y posteriores solo se alcanzan confirmando desde la ficha (se crea el evento operativo).
    const status = select('resStatus', (['en_estudio', 'negociacion', 'pre_reservada'] as const).map((s): [string, string] => [s, statusLabel(s)]), initial.status);
    const start = input('resStart', 'date', initial.start_date);
    const end = input('resEnd', 'date', initial.end_date);
    const guests = input('resGuests', 'number', initial.expected_guests, { min: 0, step: 1, inputmode: 'numeric' });
    const contact = input('resContact', 'text', initial.contact_name, { maxlength: 200 });
    const phone = input('resPhone', 'tel', initial.contact_phone, { maxlength: 40 });
    // Jornadas abiertas: las noches que se piden por el QR, o reservan la plaza unas horas y se pagan en recepción, o no
    // reservan nada hasta pagar (VG 27-10-2026)
    const payMode = select('resPayMode', [['hold', 'Reserva la plaza unas horas y se paga en recepción'], ['pay_first', 'No reserva hasta pagar']], initial.lodging_pay_mode);
    const holdHours = input('resHoldHours', 'number', initial.lodging_hold_hours, { min: 1, max: 168, step: 1, inputmode: 'numeric' });
    const holdField = field('Horas que se guarda la plaza', holdHours, 'horas_plaza');
    const lodgingRow = el('div', { class: 'row2', id: 'resLodgingPay' }, field('Noches por el QR', payMode, 'pago_noches'), holdField);
    const syncLodging = () => { lodgingRow.hidden = type.value !== 'jornadas_abiertas'; holdField.hidden = payMode.value !== 'hold'; };
    syncLodging();
    const error = el('p', { class: 'formerror', id: 'reservationError', role: 'alert', hidden: true });
    const save = el('button', { class: 'primary', type: 'button', id: 'saveReservation', 'data-feedback-id': 'booking.reservas.alta.guardar', 'data-feedback-label': 'Guardar', onclick: () => void submit() }, 'Guardar');

    function current(): FormValues {
      return { title: title.value, event_type: type.value, status: status.value, start_date: start.value, end_date: end.value, expected_guests: guests.value, contact_name: contact.value, contact_phone: phone.value,
        lodging_pay_mode: payMode.value, lodging_hold_hours: holdHours.value };
    }
    function dirty(): boolean {
      const now = current();
      // Las fechas que trae el Calendario no cuentan como cambio; lo que se escribe, sí.
      return (Object.keys(blank) as Array<keyof FormValues>).some((key) => now[key].trim() !== initial[key].trim());
    }
    function onChange(): void {
      syncLodging();
      guard.dirtyEditor = dirty();
      showError(null);
    }
    function showError(message: string | null): void {
      error.hidden = !message;
      error.textContent = message ?? '';
    }

    async function submit(): Promise<void> {
      const fields = toFields(current());
      const issue = validateFields(RESERVATIONS, fields, 'insert')[0];
      if (issue) return showError(issue.message);
      const id = crypto.randomUUID();
      // Con entrada y salida, la fecha del alta nace como la fecha posible de Ikisai y queda definitiva.
      const dated = typeof fields.start_date === 'string' && typeof fields.end_date === 'string';
      const operations: RowOperation[] = [{ op: 'insert', table: RESERVATIONS, id, fields: dated ? { ...fields, dates_definitive: true } : fields }];
      if (dated && (fields.end_date as string) > (fields.start_date as string) && canRead(client, DATE_OPTIONS)) {
        operations.push({ op: 'insert', table: DATE_OPTIONS, id: crypto.randomUUID(), fields: { reservation_id: id, start_date: fields.start_date, end_date: fields.end_date, proposed_by: 'ikisai', position: 1 } });
      }
      // La fila de importes nace con la reserva (mismo id); un lector no llega aquí.
      if (canRead(client, FINANCE)) operations.push({ op: 'insert', table: FINANCE, id, fields: {} });
      const merged = fields as unknown as ReservationRow;
      if (!canHoldStatus(merged, merged.status)) {
        const missing = missingForConfirmation(merged).map((key) => MISSING_LABELS[key]).join(', ');
        return showError(`Para el estado «${statusLabel(merged.status)}» falta ${missing}.`);
      }
      try {
        save.disabled = true;
        await client.commit(operations);
        guard.dirtyEditor = false;
        await sheet?.close(true);
        toast(navigator.onLine ? 'Reserva guardada.' : 'Guardada en este dispositivo. Se enviará al reconectar.');
      } catch (e) {
        showError(describeError(e));
      } finally {
        save.disabled = false;
      }
    }

    sheet = openSheet({
      title: 'Nueva reserva',
      body: el('form', { id: 'reservationForm', 'data-feedback-id': 'booking.reservas.alta', 'data-feedback-label': 'Nueva reserva', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        field('Nombre del grupo o evento', title, 'nombre'),
        el('div', { class: 'row2' }, field('Tipo', type, 'tipo'), field('Estado', status, 'estado')),
        lodgingRow,
        el('div', { class: 'row2' }, field('Entrada', start, 'entrada'), field('Salida', end, 'salida')),
        field('Personas previstas', guests, 'personas'),
        el('div', { class: 'row2' }, fbIgnore(field('Contacto', contact, 'contacto')), fbIgnore(field('Teléfono', phone, 'telefono'))),
        error,
      ),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'booking.reservas.alta.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar')),
      beforeClose: () => !dirty() || confirm('Hay cambios sin guardar. ¿Cerrar sin guardar?'),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
      initialFocus: title,
    });
  }

  async function load(): Promise<void> {
    const all = (await client.list(RESERVATIONS, { includeDeleted: true })) as ReservationRow[];
    rows = all.filter((r) => r.deleted_at === null);
    deleted = all.filter((r) => r.deleted_at !== null);
    set = await loadExperiences(client);
    paintFilters();
    paint();
  }

  paintFilters();
  paintEmptyState();
  void load();
  if (writable && requestedDates) { const d = requestedDates; requestedDates = null; openForm(d); }
  const reload = () => void load();
  const offs = [
    ...[RESERVATIONS, EVENTS, FINANCE, PROPOSALS, GUESTS, TABLES.checklist, NEEDS, ASSIGNMENTS, PORTAL_REQUESTS].filter((t) => t === RESERVATIONS || canRead(client, t)).map((t) => client.onTable(t, reload)),
    onSesPending(reload), onLogos(() => paint()), client.onStatus(paintEmptyState),
  ];
  window.addEventListener('online', paintEmptyState);
  window.addEventListener('offline', paintEmptyState);
  return () => {
    offs.forEach((off) => off());
    window.removeEventListener('online', paintEmptyState);
    window.removeEventListener('offline', paintEmptyState);
    void sheet?.close(true);
    guard.dirtyEditor = false;
  };
};

/** Dónde viven las confirmadas en la lista por fases: «Preparación», «Preparación y En curso»… */
function livesIn(list: ReservationView[]): string {
  const labels = PHASES.filter((p) => list.some((v) => v.x.phase === p)).map((p) => PHASE_LABELS[p]);
  return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} y ${labels.at(-1)}` : labels[0] ?? PHASE_LABELS.preparacion;
}
