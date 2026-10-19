/**
 * Tarifas, pasos 2 y 3 (tanda 27, MUELA-052 y 067 §5): «Probar un caso» con las líneas y los totales del dominio real
 * (`suggestLines` → `proposalTotals` → `applyMinimum`), la llegada en un campo grande que abre el calendario de precios
 * (`priceCalendar`, con la regla de disponibilidad de siempre, `rangeAvailability`), y «Lo que ve el organizador»: el
 * mismo caso solo con lo visible en su portal, y lo que no ve. No guarda nada.
 */
import { el, openSheet, plural, replace, type Sheet } from '@ikisai/ui-kit';
import {
  EVENT_TYPES, applyMinimum, priceCalendar, proposalTotals, round2, suggestLines,
  type AvailabilityInput, type ConditionsLike, type PriceMonth, type RateLike, type ReservationForRates, type WeekendPrice,
} from '@ikisai/domain-booking';
import { EVENT_TYPE_LABELS, fullDay, today } from '../app/client.ts';
import { eur, type Row } from '../app/rates.ts';

export interface CaseState { persons: number; start: string; nights: number; eventType: string; conditionsId: string | null }

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
const shortRange = (w: Pick<WeekendPrice, 'start' | 'end'>) => {
  const d = (iso: string) => Number(iso.slice(8, 10));
  const m = (iso: string) => MONTHS[Number(iso.slice(5, 7)) - 1]!.slice(0, 3);
  return w.start.slice(5, 7) === w.end.slice(5, 7) ? `${d(w.start)}–${d(w.end)} ${m(w.end)}` : `${d(w.start)} ${m(w.start)} – ${d(w.end)} ${m(w.end)}`;
};

/** El caso como reserva: servicios típicos de un retiro (alojamiento y comidas), sin fechas propias. */
export function caseReservation(c: CaseState): ReservationForRates {
  return { event_type: c.eventType, start_date: c.start, end_date: addDays(c.start, c.nights), expected_guests: c.persons, uses_accommodation: c.nights > 0, requires_meals: true };
}

export function caseTotals(c: CaseState, rates: readonly RateLike[], conditions: (ConditionsLike & { minimum_total?: number | string | null }) | null) {
  const lines = suggestLines(caseReservation(c), rates, { persons: c.persons });
  const totals = proposalTotals(lines, conditions);
  const payable = applyMinimum(totals.total, conditions?.minimum_total ?? null);
  return { lines, totals, payable, perPerson: c.persons > 0 ? round2(payable.total / c.persons) : null };
}

/**
 * Hoja «Elige la llegada viendo su precio» / «Fines de semana libres»: los meses con «n libres», cada fin de semana
 * (llegada en viernes) con su precio por persona y el total; el más barato en verde, la temporada alta en ámbar; los
 * ocupados tachados y desactivados; los que están en opción, con su chip. `onPick` recibe el fin de semana elegido.
 */
export function openPriceSheet(o: {
  title: string; months: PriceMonth[]; persons: number; onPersons?: (n: number) => void;
  onPick: (w: WeekendPrice) => void; extra?: (w: WeekendPrice) => HTMLElement | null; manualDate?: (iso: string) => void; feedbackId: string;
}): Sheet {
  const body = el('div', { class: 'bk-fd-sheet', 'data-feedback-id': o.feedbackId, 'data-feedback-label': o.title });
  const persons = o.onPersons ? el('input', { type: 'number', id: 'priceSheetPersons', min: 1, step: 1, value: String(o.persons), inputmode: 'numeric', 'aria-label': 'Para cuántas personas',
    onchange: () => { const n = Number(persons!.value); if (n > 0) o.onPersons!(n); } }) : null;
  const weekend = (w: WeekendPrice) => {
    const busy = w.availability === 'ocupado';
    const name = `${shortRange(w)}${w.total !== null ? ` · ${eur(w.total)}` : ''}`;
    return el('li', null, el('button', {
      type: 'button', class: `bk-fd-weekend${w.cheapest ? ' bk-fd-cheapest' : ''}${w.high ? ' bk-fd-high' : ''}${busy ? ' bk-fd-busy' : ''}`, disabled: busy, dataset: { start: w.start, availability: w.availability },
      'aria-label': [name, w.perPerson !== null ? `${eur(w.perPerson)} por persona` : 'sin precio', w.cheapest ? 'el más barato' : null, w.high ? 'temporada alta' : null, busy ? 'ocupado' : w.availability === 'en_opcion' ? 'en opción' : 'libre'].filter(Boolean).join(', '),
      onclick: () => o.onPick(w),
    },
    el('span', { class: 'bk-fd-dates' }, shortRange(w)),
    el('span', { class: 'bk-fd-price' }, w.perPerson !== null ? `${eur(w.perPerson)} por persona` : 'Sin tarifas que apliquen'),
    el('span', { class: 'bk-fd-total' }, w.total !== null ? `${eur(w.total)}${w.minimumApplied ? ' (mínimo)' : ''}` : ''),
    el('span', { class: 'bk-fd-tags' }, w.cheapest ? el('span', { class: 'chip ok' }, 'El más barato') : null, w.high ? el('span', { class: 'chip warn' }, 'Temporada alta') : null,
      busy ? el('span', { class: 'chip' }, 'Ocupado') : w.availability === 'en_opcion' ? el('span', { class: 'chip pending' }, 'En opción') : null)),
    o.extra?.(w) ?? null);
  };
  const manual = o.manualDate ? el('details', { class: 'bk-fold' }, el('summary', null, 'Escribir otra fecha'),
    el('label', { class: 'field' }, el('span', null, 'Llegada'), el('input', { type: 'date', id: 'priceSheetDate', onchange: (e: Event) => { const v = (e.target as HTMLInputElement).value; if (v) o.manualDate!(v); } }))) : null;
  replace(body,
    persons ? el('label', { class: 'field' }, el('span', null, 'Para cuántas personas'), persons) : null,
    ...o.months.map((m) => el('section', { class: 'bk-fd-month', 'aria-label': monthName(m.month) },
      el('h4', null, monthName(m.month), el('span', { class: 'hint' }, ` · ${plural(m.free, 'libre', 'libres')}`)),
      el('ul', { class: 'bk-fd-list' }, m.weekends.map(weekend)))),
    el('p', { class: 'hint' }, 'Llegada en viernes. Ocupado: reserva confirmada, pre-reserva con fecha definitiva o bloqueo. En opción: una reserva abierta con esa fecha propuesta.'),
    manual);
  return openSheet({ title: o.title, body });
}

export interface RatesCaseData { rates: Row[]; conditions: Row[]; availability: AvailabilityInput }

/** Pasos 2 y 3 en dos contenedores; `update` con los datos del espejo en cada repintado. */
export function createRatesCase() {
  const state: CaseState = { persons: 24, start: nextFriday(), nights: 2, eventType: 'retiro', conditionsId: null };
  let data: RatesCaseData | null = null;
  let sheet: Sheet | null = null;
  const caseHost = el('div', { id: 'rateCase', 'data-feedback-id': 'booking.tarifas.caso', 'data-feedback-label': 'Probar un caso' });
  const organizerHost = el('div', { id: 'rateOrganizer', 'data-feedback-id': 'booking.tarifas.organizador', 'data-feedback-label': 'Lo que ve el organizador' });

  const conditionsOf = () => {
    const live = (data?.conditions ?? []).filter((c) => c.active !== false);
    return live.find((c) => c.id === state.conditionsId) ?? live.find((c) => c.is_default) ?? live[0] ?? null;
  };
  const activeRates = () => (data?.rates ?? []).filter((r) => r.active) as unknown as RateLike[];

  function linesTable(result: ReturnType<typeof caseTotals>, id: string) {
    return el('div', { id },
      result.lines.length === 0 ? el('p', { class: 'hint' }, 'Ninguna tarifa activa se aplica a este caso.')
        : el('ul', { class: 'list' }, result.lines.map((l) => el('li', { class: 'row' },
            el('div', { class: 'row-title' }, el('span', { class: 'name' }, l.description), el('span', null, eur(round2(Number(l.quantity) * Number(l.unit_amount))))),
            el('div', { class: 'row-meta' }, `${l.quantity} × ${eur(Number(l.unit_amount))}`)))),
      el('dl', { class: 'kv' },
        el('dt', null, 'Subtotal'), el('dd', null, eur(result.totals.subtotal)),
        el('dt', null, 'IVA'), el('dd', null, eur(result.totals.vat_amount)),
        el('dt', null, 'Total'), el('dd', { dataset: { role: 'total' } }, el('strong', null, eur(result.payable.total)), result.payable.minimumApplied ? ' (mínimo aplicado)' : ''),
        el('dt', null, 'Por persona'), el('dd', null, result.perPerson !== null ? eur(result.perPerson) : '—'),
        el('dt', null, 'Señal'), el('dd', null, eur(result.totals.deposit_amount))));
  }

  function openCalendar(): void {
    if (!data) return;
    const months = priceCalendar({ reservation: caseReservation(state), persons: state.persons, nights: state.nights, rates: activeRates(), conditions: conditionsOf() as never, from: today(), months: 6, availability: data.availability });
    sheet = openPriceSheet({
      title: 'Elige la llegada viendo su precio', months, persons: state.persons, feedbackId: 'booking.tarifas.caso.calendario',
      onPick: (w) => { state.start = w.start; void sheet?.close(true); paint(); },
      manualDate: (iso) => { state.start = iso; void sheet?.close(true); paint(); },
    });
  }

  function paint(): void {
    if (!data) return;
    const conditions = conditionsOf();
    const result = caseTotals(state, activeRates(), conditions as never);
    const num = (id: string, label: string, value: number, min: number, set: (n: number) => void) => el('label', { class: 'field' }, el('span', null, label),
      el('input', { id, type: 'number', min, step: 1, inputmode: 'numeric', value: String(value), onchange: (e: Event) => { const n = Number((e.target as HTMLInputElement).value); if (Number.isFinite(n) && n >= min) { set(n); paint(); } } }));
    const type = el('select', { id: 'caseType', onchange: () => { state.eventType = type.value; paint(); } }, EVENT_TYPES.map((t) => el('option', { value: t }, EVENT_TYPE_LABELS[t])));
    type.value = state.eventType;
    const conds = el('select', { id: 'caseConditions', onchange: () => { state.conditionsId = conds.value || null; paint(); } },
      (data.conditions ?? []).filter((c) => c.active !== false).map((c) => el('option', { value: c.id }, `${c.name}${c.is_default ? ' (por defecto)' : ''}`)));
    if (conditions) conds.value = conditions.id;
    replace(caseHost,
      el('p', { class: 'hint' }, 'Un caso de prueba con las tarifas activas: no guarda nada.'),
      el('button', { type: 'button', class: 'bk-casedates', id: 'caseDates', 'data-feedback-id': 'booking.tarifas.caso.llegada', 'data-feedback-label': 'Llegada del caso', onclick: openCalendar },
        el('span', { class: 'hint' }, 'Llegada'), el('strong', null, `${fullDay(state.start)} · ${plural(state.nights, 'noche', 'noches')}`), el('span', { class: 'hint' }, `${eur(result.payable.total)} · ver otros fines de semana ›`)),
      el('div', { class: 'row2' }, num('casePersons', 'Personas', state.persons, 1, (n) => { state.persons = n; }), num('caseNights', 'Noches', state.nights, 0, (n) => { state.nights = n; })),
      el('div', { class: 'row2' }, el('label', { class: 'field' }, el('span', null, 'Tipo'), type), el('label', { class: 'field' }, el('span', null, 'Condiciones'), conds)),
      linesTable(result, 'caseLines'));

    // Lo que ve el organizador: solo las tarifas visibles en su portal, con su nombre público.
    const visible = activeRates().filter((r) => (r as unknown as Row).portal_visible === true).map((r) => ({ ...r, name: (r as unknown as Row).public_name || r.name }));
    const theirs = caseTotals(state, visible, conditions as never);
    const missing = result.lines.filter((l) => !visible.some((r) => r.id === l.rate_id));
    const diff = round2(result.payable.total - theirs.payable.total);
    replace(organizerHost,
      el('p', { class: 'hint' }, 'Su calculadora con el mismo caso, solo con lo que está visible en el portal.'),
      linesTable(theirs, 'organizerLines'),
      el('section', { class: 'card', id: 'organizerMissing' }, el('h3', null, 'Lo que no ve'),
        missing.length === 0 ? el('p', null, 'Ve todo lo que se aplica a este caso.')
          : [el('p', null, `Le salen ${eur(Math.abs(diff))} ${diff > 0 ? 'menos' : 'más'} que en la propuesta.`),
             el('ul', { class: 'list' }, missing.map((l) => el('li', { class: 'row' }, el('div', { class: 'row-title' }, el('span', { class: 'name' }, l.description)), el('div', { class: 'row-meta' }, 'No está visible en el portal'))))]));
  }

  return {
    caseHost, organizerHost,
    update(next: RatesCaseData) { data = next; paint(); },
    destroy() { void sheet?.close(true); },
  };
}

function nextFriday(): string {
  const t = today();
  const d = new Date(`${t}T00:00:00Z`);
  const offset = (5 - d.getUTCDay() + 7) % 7 || 7;
  return addDays(t, offset);
}
