/**
 * «Diseña tu retiro» (fase 2, API.md §13.2; Booking B7d, B9 y B10; pasada única, zona 2). El borrador es la propia
 * reserva de Booking «en estudio»: lo que cambia aquí lo ve el personal al instante. Se guarda solo, campo a campo.
 * - Banda de precio fija arriba y el veredicto con «Siguiente: …» y lo que falta debajo (`app/design-checks.ts`,
 *   `ui/ready.ts`; MUELA-072:47 y MUELA-084): dice si está todo para pedir la propuesta, sin prometer plazos de Ikisai.
 * - Personas, comidas, alojamiento y espacios, extras y notas para Ikisai.
 * - Precio orientativo con el motor de tarifas de Booking (IVA incluido, mínimo comercial y señal), el precio de cada
 *   fecha en «Calcular para», el precio medio por persona y el diseño frente a la propuesta de Ikisai.
 * - «¿Cuánto ganas?»: calculadora privada, solo en este dispositivo. Lo de Ikisai varía con las plazas (asistentes más
 *   colaboradores); los colaboradores solo cuentan aquí y **nunca** se escriben en Booking (las plazas, en «Personas»).
 */
import { createSaveState, el, fieldAttrs, replace, toast, type CheckItem } from '@ikisai/ui-kit';
import type { DraftFields, ExtraRequest, PortalDates, PortalProposal, PortalRates, ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError, errorCode, online } from '../app/client.ts';
import { commonText } from '../app/common-texts.ts';
import { designChecks, readyVerdict, type DesignCheckTarget } from '../app/design-checks.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { proposalVersions } from '../app/proposal-state.ts';
import { averagePrice, breakEvenAttendees, breakEvenPrice, marginOf, marginPct, priceForMargin, quote, type Quote, type QuoteInput } from '../app/quote.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import { renderReady } from './ready.ts';
import type { ViewContext } from './shell.ts';

const MEAL_PLANS: Array<[string, string]> = [['pension_completa', L('Pensión completa')], ['media_pension', L('Media pensión')], ['desayuno', L('Desayuno')], ['segun_programa', L('Comidas según programa')]];
const MENU_STYLES: Array<[string, string]> = [['vegetariano', L('Vegetariano')], ['vegano', L('Vegano')], ['mixto', L('Omnívoro')], ['otro', L('A medida')]];
/** Campos del formulario del diseño por clave, para el inventario de Uso y cobertura (P15): literales, uno por campo. */
const DESIGN_FIELDS: Partial<Record<string, Record<string, string | null>>> = {
  expected_guests: fieldAttrs({ id: 'organizers.diseno.expected_guests', label: 'Personas previstas', entity: 'booking.reservations', prop: 'expected_guests', type: 'number', sensitivity: 'internal' }),
  minors_count: fieldAttrs({ id: 'organizers.diseno.minors_count', label: 'Menores de edad', entity: 'booking.reservations', prop: 'minors_count', type: 'number', sensitivity: 'internal' }),
  requires_meals: fieldAttrs({ id: 'organizers.diseno.requires_meals', label: 'Con comidas en Ikisai', entity: 'booking.reservations', prop: 'requires_meals', type: 'toggle', sensitivity: 'internal' }),
  meal_plan_requested: fieldAttrs({ id: 'organizers.diseno.meal_plan_requested', label: 'Régimen de comidas', entity: 'booking.reservations', prop: 'meal_plan_requested', type: 'select', sensitivity: 'internal' }),
  menu_style_requested: fieldAttrs({ id: 'organizers.diseno.menu_style_requested', label: 'Orientación del menú', entity: 'booking.reservations', prop: 'menu_style_requested', type: 'select', sensitivity: 'internal' }),
  uses_accommodation: fieldAttrs({ id: 'organizers.diseno.uses_accommodation', label: 'Alojamiento', entity: 'booking.reservations', prop: 'uses_accommodation', type: 'toggle', sensitivity: 'internal' }),
  uses_interpretation_center: fieldAttrs({ id: 'organizers.diseno.uses_interpretation_center', label: 'Centro de interpretación', entity: 'booking.reservations', prop: 'uses_interpretation_center', type: 'toggle', sensitivity: 'internal' }),
  uses_outdoors: fieldAttrs({ id: 'organizers.diseno.uses_outdoors', label: 'Zonas exteriores', entity: 'booking.reservations', prop: 'uses_outdoors', type: 'toggle', sensitivity: 'internal' }),
  uses_pool: fieldAttrs({ id: 'organizers.diseno.uses_pool', label: 'Piscina', entity: 'booking.reservations', prop: 'uses_pool', type: 'toggle', sensitivity: 'internal' }),
  special_setup: fieldAttrs({ id: 'organizers.diseno.special_setup', label: 'Montaje especial', entity: 'booking.reservations', prop: 'special_setup', type: 'toggle', sensitivity: 'internal' }),
  technical_support: fieldAttrs({ id: 'organizers.diseno.technical_support', label: 'Apoyo técnico', entity: 'booking.reservations', prop: 'technical_support', type: 'toggle', sensitivity: 'internal' }),
};

const SPACES: Array<[keyof DraftFields, string]> = [
  ['uses_accommodation', L('Alojamiento (dormir en Ikisai)')], ['uses_interpretation_center', L('Centro de interpretación')],
  ['uses_outdoors', L('Zonas exteriores')], ['uses_pool', L('Piscina')],
  ['special_setup', L('Montaje especial de las salas')], ['technical_support', L('Apoyo técnico (sonido, proyección…)')],
];
const labelOf = (list: Array<[string, string]>, value: string) => { const hit = list.find(([k]) => k === value); return hit ? t(hit[1]) : value; };

/** Lo que guarda la calculadora en el borrador local (todo en texto, tal como se teclea). Nunca viaja. */
interface Margins { price: string; attendees: string; collaborators: string; other: string; pct: string }
const EMPTY_MARGINS: Margins = { price: '', attendees: '', collaborators: '', other: '', pct: '' };

/** Campo al que llevar al abrir Diseño (desde el «Siguiente» de Fechas: «Ir a Personas»…). Se usa una vez. */
let focusOnOpen: string | null = null;
export function openDesignAt(field: string): void { focusOnOpen = field; }

export function renderDesign(ctx: ViewContext, reservationId: string, detail: ReservationDetail, dates: PortalDates | null, reload: () => void): HTMLElement {
  const host = el('div', { id: 'design', 'data-feedback-id': 'organizers.diseno', 'data-feedback-label': 'Diseño' }, loading());
  const saves = createSaveState({ savedMs: 4000 });
  let alive = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingFields: DraftFields = {};
  let pendingExtras: ExtraRequest[] | null = null;

  // Estado del borrador (lo que hay en Booking más lo que se va tecleando).
  const state: Required<Pick<DraftFields, 'expected_guests' | 'minors_count' | 'requires_meals' | 'meal_plan_requested' | 'menu_style_requested' | 'uses_accommodation' | 'uses_interpretation_center' | 'uses_outdoors' | 'uses_pool' | 'special_setup' | 'technical_support'>> & { organizer_notes: string } = {
    expected_guests: detail.expected_guests ?? null, minors_count: detail.minors_count ?? 0, requires_meals: detail.requires_meals,
    meal_plan_requested: detail.meal_plan ?? null, menu_style_requested: detail.menu_style ?? null,
    uses_accommodation: detail.uses_accommodation, uses_interpretation_center: detail.uses_interpretation_center,
    uses_outdoors: detail.uses_outdoors, uses_pool: detail.uses_pool,
    special_setup: detail.special_setup ?? false, technical_support: detail.technical_support ?? false, organizer_notes: detail.organizer_notes ?? '',
  };
  let extras: ExtraRequest[] = [];
  let rates: PortalRates = { available: false, rates: [], conditions: null };
  /** La propuesta vigente de Ikisai (lectura sin historial, con caché), para «Diseño frente a la propuesta». */
  let proposal: PortalProposal | null = null;

  async function save(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const fields = pendingFields;
    const extrasNow = pendingExtras;
    if (!Object.keys(fields).length && !extrasNow) return;
    if (!online()) { saves.set('diseno', 'pending'); return; }
    pendingFields = {};
    pendingExtras = null;
    try {
      await saves.track('diseno', ctx.usage.run('organizers.diseno.guardar', () => ctx.api.updateDraft(reservationId, {
        ...(Object.keys(fields).length ? { fields } : {}), ...(extrasNow ? { extras: extrasNow } : {}),
      })), { retry: () => save() });
    } catch (error) {
      const code = errorCode(error);
      if (code === 'NETWORK' || code === 'BACKEND_UNAVAILABLE' || code === 'OFFLINE') {
        // Se reintenta con lo que había más lo nuevo.
        pendingFields = { ...fields, ...pendingFields };
        pendingExtras = pendingExtras ?? extrasNow;
        return;
      }
      toast(describeError(error));
      // El retiro ha pasado a prerreserva (ya no se diseña) o un extra dejó de ofrecerse: se vuelve a leer.
      if (code === 'DRAFT_LOCKED' || code === 'EXTRA_NOT_OFFERED') reload();
    }
  }
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void save(), 800); };
  // La calculadora (#margin-*) nunca pasa por aquí: no escribe en Booking.
  const change = (fields: DraftFields) => { Object.assign(state, fields); pendingFields = { ...pendingFields, ...fields }; schedule(); paintQuote(); paintChecks(); };
  const changeExtras = (next: ExtraRequest[]) => { extras = next; pendingExtras = next; schedule(); paintQuote(); };
  const resume = () => { if (Object.keys(pendingFields).length || pendingExtras) void save(); };
  window.addEventListener('online', resume);

  const money = (n: number) => i18n.formatMoney(n);
  const averageLine = (total: number, persons: number | null) => {
    const average = averagePrice(total, persons);
    return average === null ? null : t('Precio medio por persona: {importe} · el total entre {n} personas', { importe: money(average), n: persons ?? 0 });
  };

  /** Lleva a un campo del diseño: se desplaza (sin animación si se pide menos movimiento) y le pone el foco. */
  function goField(id: string): void {
    const field = host.querySelector<HTMLElement>(`#${id}`);
    if (!field) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    field.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    field.focus({ preventScroll: true });
  }
  const go = (target: DesignCheckTarget) => (target.kind === 'tab' ? ctx.navigate(`#/retiro/${reservationId}/fechas`) : goField(target.field));

  // --- Veredicto, «Siguiente» y lo que te falta -----------------------------------------------------------------------
  const readyHost = el('div');
  function paintChecks(): void {
    const checks = designChecks(state, dates, { t, mealPlan: (v) => labelOf(MEAL_PLANS, v), menuStyle: (v) => labelOf(MENU_STYLES, v) });
    const items: CheckItem[] = checks.map((c) => ({ ok: c.ok, text: c.text, detail: c.detail, action: c.ok ? null : { ...c.action, onClick: () => go(c.target) } }));
    replace(readyHost, renderReady(readyVerdict(checks, proposal, { t }), items, {
      label: t('Lo que te falta por rellenar'),
      go: (next) => (next.kind === 'check' ? go(next.check.target) : ctx.navigate(`#/retiro/${reservationId}/propuesta`)),
      mark: (button) => fbMark(button, 'organizers.diseno.siguiente', 'Siguiente paso del diseño'),
    }));
  }

  // --- Precio orientativo --------------------------------------------------------------------------------------------
  const priceBar = el('div', { id: 'priceBar', class: 'orgpricebar' });
  const quoteHost = el('div', { id: 'quote', 'data-feedback-id': 'organizers.diseno.precio', 'data-feedback-label': 'Precio orientativo' });
  const marginHost = el('div', { id: 'margin', 'data-feedback-id': 'organizers.diseno.margen', 'data-feedback-label': '¿Cuánto ganas?' });
  // Fechas para el cálculo: la definitiva o una de las posibles (las que vienen bien primero). Nunca un hueco no ofrecido.
  const candidates = dates?.mode === 'fixed' && dates.definitive
    ? [{ id: 'fixed', start: dates.definitive.start, end: dates.definitive.end }]
    : [...(dates?.options ?? [])].sort((a, b) => Number(b.organizer_ok) - Number(a.organizer_ok)).map((o) => ({ id: o.id, start: o.start, end: o.end }));
  let chosen = candidates[0] ?? null;
  let lastQuote: Quote | null = null;

  /** El mismo cálculo para el precio orientativo, cada fecha de «Calcular para» y la calculadora (con n plazas). */
  const quoteInput = (range: { start: string; end: string }, persons: number): QuoteInput => ({
    reservation: { event_type: detail.event_type ?? 'retiro', start_date: range.start, end_date: range.end, expected_guests: persons,
      uses_accommodation: state.uses_accommodation, requires_meals: state.requires_meals, uses_interpretation_center: state.uses_interpretation_center,
      uses_outdoors: state.uses_outdoors, uses_pool: state.uses_pool, special_setup: state.special_setup, technical_support: state.technical_support },
    persons, rates: rates.rates, conditions: rates.conditions, extras,
  });

  function paintBar(q: Quote | null): void {
    if (!rates.available) { priceBar.hidden = true; return; }
    priceBar.hidden = false;
    if (!q || !q.available) {
      replace(priceBar, el('p', { class: 'orgpricebar-empty' }, t('Indica personas y una fecha para ver el precio.')));
      return;
    }
    const average = averageLine(q.payable, state.expected_guests);
    replace(priceBar,
      el('p', { class: 'orgpricebar-main' },
        el('span', null, t('Precio orientativo'), ' ', el('strong', null, money(q.payable))),
        el('span', null, t('Señal'), ' ', el('strong', null, money(q.deposit)))),
      average ? el('p', { class: 'orgpricebar-avg' }, average) : null);
  }

  function versusProposal(q: Extract<Quote, { available: true }>): HTMLElement | null {
    const p = proposal;
    if (!p) return null;
    const guests = state.expected_guests ?? 0;
    const same = Math.round(Number(p.total)) === Math.round(q.payable) && p.persons === state.expected_guests;
    const text = same
      ? t('Coincide con la propuesta de Ikisai (versión {v}).', { v: p.version })
      : p.persons
        ? t('La propuesta de Ikisai (versión {v}) es de {importe} para {n} personas. Con tu diseño de ahora ({m} personas) saldría {calculado}.', { v: p.version, importe: money(Number(p.total)), n: p.persons, m: guests, calculado: money(q.payable) })
        : t('La propuesta de Ikisai (versión {v}) es de {importe}. Con tu diseño de ahora ({m} personas) saldría {calculado}.', { v: p.version, importe: money(Number(p.total)), m: guests, calculado: money(q.payable) });
    return fbMark(el('p', { id: 'designVsProposal', class: 'orgversus' }, el('span', null, text), ' ',
      el('button', { type: 'button', class: 'linkbtn orgtap', 'aria-label': t('Ver la propuesta de Ikisai'), onclick: () => ctx.navigate(`#/retiro/${reservationId}/propuesta`) }, t('Ver'))),
    'organizers.diseno.frente_propuesta', 'Diseño frente a la propuesta');
  }

  function paintQuote(): void {
    if (!rates.available) {
      replace(quoteHost, el('p', { class: 'muted' }, t('Ikisai te enviará el precio. Aún no hay tarifas publicadas para calcularlo aquí.')));
      lastQuote = null; paintBar(null); paintMargin(); return;
    }
    if (!chosen) {
      replace(quoteHost, el('p', { class: 'muted' }, t('Marca primero alguna fecha posible en «Fechas» para calcular el precio.')));
      lastQuote = null; paintBar(null); paintMargin(); return;
    }
    const persons = state.expected_guests ?? 0;
    const q = quote(quoteInput(chosen, persons));
    lastQuote = q;
    paintBar(q);
    // Cada fecha con su precio (si se puede calcular): sustituye a la hoja del calendario de precios.
    const optionText = (c: { start: string; end: string }) => {
      const each = quote(quoteInput(c, persons));
      return each.available ? `${dateRange(c.start, c.end)} · ${money(each.payable)}` : dateRange(c.start, c.end);
    };
    const picker = candidates.length > 1 ? el('label', { class: 'field' }, el('span', null, t('Calcular para')),
      el('select', { ...fieldAttrs({ id: 'organizers.diseno.precio.fechas', label: 'Calcular para', type: 'select', sensitivity: 'internal', confirm: 'none' }), id: 'quoteDates', onchange: (e: Event) => { chosen = candidates.find((c) => c.id === (e.target as HTMLSelectElement).value) ?? chosen; paintQuote(); } },
        ...candidates.map((c) => el('option', { value: c.id, selected: c.id === chosen?.id ? '' : null }, optionText(c))))) : null;
    if (!q.available) {
      replace(quoteHost, picker, el('p', { class: 'muted' }, q.reason === 'no_persons' ? t('Indica cuántas personas venís para calcular el precio.') : t('Marca primero alguna fecha posible en «Fechas» para calcular el precio.')));
      paintMargin(); return;
    }
    const average = averageLine(q.payable, state.expected_guests);
    replace(quoteHost, picker,
      el('p', { class: 'muted small' }, q.nights === 1 ? t('1 noche') : t('{n} noches', { n: q.nights }),
        q.mealsIncluded ? ` · ${t('{n} comidas incluidas por persona', { n: q.mealsIncluded })}` : ''),
      el('table', { class: 'orgquote' }, el('tbody', null, ...q.lines.map((l) => el('tr', null,
        el('td', null, l.description, el('span', { class: 'muted small' }, ` · ${i18n.formatNumber(l.quantity)} × ${money(l.unit_amount)}`)),
        el('td', { class: 'num' }, l.amount === null ? '' : money(l.amount)))))),
      el('dl', { class: 'kv orgtotals' },
        el('dt', null, t('Total con IVA incluido')), el('dd', { id: 'quoteTotal' }, money(q.payable)),
        el('dt', null, t('de los que IVA ({n} %)', { n: i18n.formatNumber(q.vatRate) })), el('dd', null, money(q.vatAmount)),
        el('dt', null, t('Señal para reservar')), el('dd', { id: 'quoteDeposit' }, money(q.deposit))),
      average ? el('p', { class: 'muted', id: 'quoteAverage' }, average) : null,
      q.minimumApplied && q.minimum !== null ? el('p', { class: 'banner info', id: 'quoteMinimum' }, t('Se aplica el mínimo por retiro de {importe} (el cálculo daba {calculado}).', { importe: money(q.minimum), calculado: money(q.total) })) : null,
      versusProposal(q),
      el('p', { class: 'muted small' }, commonText('organizers.quote_note').body));
    paintMargin();
  }

  // --- «¿Cuánto ganas?»: calculadora privada (solo en el dispositivo) ------------------------------------------------
  const marginKey = `margin:${reservationId}`;
  let margins: Margins = { ...EMPTY_MARGINS };
  /** El máximo del deslizador del precio solo crece (no salta al mover el precio). */
  let rangeMax = 1200;
  let frame = 0;
  let pctTyped = false;
  const persist = () => void cache.saveDraft(ctx.userId, marginKey, margins);

  function paintMargin(): void {
    // Lo de Ikisai por n plazas: el mismo cálculo que el precio orientativo con persons = n. Memorizado mientras no cambie el diseño.
    const memo = new Map<number, number>();
    const ikisaiFor = (n: number): number => {
      if (!(n > 0) || !chosen || !rates.available) return 0;
      const hit = memo.get(n);
      if (hit !== undefined) return hit;
      const q = quote(quoteInput(chosen, n));
      const value = q.available ? q.payable : 0;
      memo.set(n, value);
      return value;
    };
    const expected = state.expected_guests ?? 0;
    const attendeesOf = () => (margins.attendees === '' ? expected : Math.max(0, Math.round(Number(margins.attendees) || 0)));
    const collaboratorsOf = () => (margins.collaborators === '' ? 0 : Math.max(0, Math.round(Number(margins.collaborators) || 0)));
    const otherOf = () => Math.max(0, Number(margins.other) || 0);

    const numberInput = (id: string, value: string, placeholder: string, attrs: Record<string, string | null> = {}) => el('input', {
      type: 'number', min: '0', step: 'any', inputmode: 'decimal', id, value, placeholder, class: 'orgnumber', ...attrs, /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */
    }) as HTMLInputElement;
    const range = (id: string, label: string, max: number, field: Record<string, string | null>) => el('input', { ...field, type: 'range', min: '0', max: String(max), step: '1', id, class: 'orgrange', 'aria-label': label, /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ }) as HTMLInputElement;

    const peopleMax = Math.max(50, Math.ceil((expected * 2) / 10) * 10);
    const attendees = numberInput('margin-attendees', margins.attendees, String(state.expected_guests ?? ''), { step: '1', inputmode: 'numeric', 'aria-describedby': 'margin-attendees-help', ...fieldAttrs({ id: 'organizers.diseno.margen.asistentes', label: 'Asistentes (cálculo)', type: 'number', sensitivity: 'internal', confirm: 'none' }) });
    const attendeesRange = range('margin-attendees-range', t('Asistentes'), peopleMax, fieldAttrs({ id: 'organizers.diseno.margen.asistentes_barra', label: 'Asistentes (barra)', type: 'range', sensitivity: 'internal', confirm: 'none' }));
    const collaborators = numberInput('margin-collaborators', margins.collaborators, '0', { step: '1', inputmode: 'numeric', 'aria-describedby': 'margin-collaborators-help', ...fieldAttrs({ id: 'organizers.diseno.margen.colaboradores', label: 'Colaboradores sin coste', type: 'number', sensitivity: 'internal', confirm: 'none' }) });
    const collaboratorsRange = range('margin-collaborators-range', t('Colaboradores sin coste'), Math.max(20, Math.ceil(expected / 10) * 10), fieldAttrs({ id: 'organizers.diseno.margen.colaboradores_barra', label: 'Colaboradores (barra)', type: 'range', sensitivity: 'internal', confirm: 'none' }));
    const price = numberInput('margin-price', margins.price, '0', fieldAttrs({ id: 'organizers.diseno.margen.precio', label: 'Precio por asistente', type: 'number', sensitivity: 'internal', confirm: 'none' }));
    const priceRange = range('margin-price-range', t('Precio por asistente'), rangeMax, fieldAttrs({ id: 'organizers.diseno.margen.precio_barra', label: 'Precio por asistente (barra)', type: 'range', sensitivity: 'internal', confirm: 'none' }));
    const pct = numberInput('margin-pct', margins.pct, '', { min: '0', max: '500', step: '1', inputmode: 'numeric', 'aria-describedby': 'margin-pct-help', ...fieldAttrs({ id: 'organizers.diseno.margen.porcentaje', label: 'Margen que quieres', type: 'number', sensitivity: 'internal', confirm: 'none' }) });
    const other = numberInput('margin-other', margins.other, '0', fieldAttrs({ id: 'organizers.diseno.margen.otros_gastos', label: 'Otros gastos', type: 'number', sensitivity: 'internal', confirm: 'none' }));

    const seats = el('p', { id: 'marginSeats', class: 'small', 'aria-live': 'polite' });
    const seatsText = el('span');
    const seatsNote = el('p', { id: 'marginSeatsNote', class: 'banner info', hidden: '' }, seatsText,
      fbMark(el('button', { type: 'button', class: 'linkbtn orgtap', onclick: () => goField('d-expected_guests') }, t('Ir a Personas')), 'organizers.diseno.margen.ir_personas', 'Ir a Personas'));
    const beButton = fbMark(el('button', { type: 'button', id: 'marginBreakEvenPrice', class: 'orgbreakeven', onclick: () => {
      const be = breakEvenPrice({ ikisai: ikisaiFor(attendeesOf() + collaboratorsOf()), otherCosts: otherOf(), attendees: attendeesOf() });
      if (be === null) return;
      margins = { ...margins, price: String(be), pct: '0' };
      price.value = margins.price;
      pct.value = '0';
      persist();
      price.focus();
      update();
    } }, el('span', { class: 'orgbreakeven-line', 'aria-hidden': 'true' })), 'organizers.diseno.margen.equilibrio', 'Cubres costes');
    const beLabel = el('span', { id: 'marginBreakEvenLabel', class: 'orgbreakeven-label' });
    const beNone = el('p', { class: 'muted small', id: 'marginBreakEvenNone', hidden: '' }, t('Pon asistentes para ver con qué precio cubres costes.'));
    const noIkisai = el('p', { class: 'banner info', id: 'marginNoIkisai', hidden: '' }, t('Sin precio de Ikisai: esta cuenta solo lleva tus otros gastos.'));
    const results = el('dl', { class: 'kv orgtotals', id: 'marginResults' });

    function compute(): void {
      const a = attendeesOf();
      const c = collaboratorsOf();
      const otherCosts = otherOf();
      const ikisai = ikisaiFor(a + c);
      if (pctTyped && margins.pct !== '') {
        const next = priceForMargin({ ikisai, otherCosts, attendees: a, pct: Number(margins.pct) || 0 });
        if (next !== null) { margins = { ...margins, price: String(next) }; price.value = margins.price; persist(); }
      }
      const p = Number(margins.price) || 0;
      const r = marginOf({ price: p, attendees: a, ikisai, otherCosts });
      // El precio manda: el % se recalcula, salvo mientras se escribe en él.
      if (!pctTyped && document.activeElement !== pct) {
        const m = margins.price === '' ? null : marginPct(r);
        const text = m === null || m < 0 ? '' : String(m);
        if (text !== margins.pct) { margins = { ...margins, pct: text }; persist(); }
        pct.value = text;
      }
      pctTyped = false;

      attendeesRange.value = String(Math.min(a, Number(attendeesRange.max)));
      collaboratorsRange.value = String(Math.min(c, Number(collaboratorsRange.max)));
      seats.textContent = t('En esta cuenta: {plazas} con Ikisai ({asistentes} + {colaboradores}).', {
        plazas: a + c === 1 ? t('1 plaza') : t('{n} plazas', { n: a + c }),
        asistentes: a === 1 ? t('1 asistente') : t('{n} asistentes', { n: a }),
        colaboradores: c === 1 ? t('1 colaborador') : t('{n} colaboradores', { n: c }),
      });
      const asked = state.expected_guests ?? 0;
      seatsNote.hidden = asked > 0 && a + c === asked;
      seatsText.textContent = asked > 0
        ? t('A Ikisai le has pedido {m} plazas. Esta cuenta no las cambia: si van a venir más o menos personas, cámbialo en «Personas».', { m: asked })
        : t('Aún no has dicho a Ikisai cuántas personas venís. Indícalo en «Personas».');
      noIkisai.hidden = ikisai > 0;

      const be = breakEvenPrice({ ikisai, otherCosts, attendees: a });
      rangeMax = Math.max(rangeMax, Math.max(1200, Math.ceil((Math.max(be ?? 0, p) * 1.5) / 100) * 100));
      priceRange.max = String(rangeMax);
      priceRange.value = String(Math.min(p, rangeMax));
      beButton.hidden = be === null;
      beLabel.hidden = be === null;
      beNone.hidden = be !== null;
      if (be !== null) {
        beButton.style.left = `${Math.min(100, (be / rangeMax) * 100)}%`;
        beButton.setAttribute('aria-label', t('Cubres costes: {importe} por asistente. Poner este precio', { importe: money(be) }));
        beLabel.textContent = t('Cubres costes: {importe}', { importe: money(be) });
      }

      const people = breakEvenAttendees({ price: p, collaborators: c, otherCosts, ikisaiFor });
      replace(results,
        el('dt', null, t('Ingresos (solo asistentes)')), el('dd', null, money(r.revenue)),
        el('dt', null, a + c === 1 ? t('Gastos (Ikisai por 1 plaza y otros)') : t('Gastos (Ikisai por {n} plazas y otros)', { n: a + c })), el('dd', null, money(r.cost)),
        el('dt', null, t('Margen')), el('dd', { id: 'marginValue', class: r.margin < 0 ? 'danger-text' : '' }, r.margin < 0 ? `−${money(-r.margin)}` : money(r.margin)),
        el('dt', null, t('Punto de equilibrio')), el('dd', { id: 'marginBreakEven' },
          p <= 0 ? '—' : people === null ? t('Con este precio no se cubren gastos') : people === 1 ? t('1 asistente') : t('{n} asistentes', { n: people })));
    }
    // Hasta 500 cálculos puros por pulsación (punto de equilibrio): se agrupan en un solo fotograma.
    function update(): void {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; if (alive) compute(); });
    }
    const typed = (key: keyof Margins, input: HTMLInputElement, mirror?: HTMLInputElement) => input.addEventListener('input', () => {
      margins = { ...margins, [key]: input.value };
      if (mirror) mirror.value = input.value;
      if (key === 'pct') pctTyped = true;
      persist();
      update();
    });
    typed('attendees', attendees);
    typed('collaborators', collaborators);
    typed('price', price);
    typed('pct', pct);
    typed('other', other);
    typed('attendees', attendeesRange, attendees);
    typed('collaborators', collaboratorsRange, collaborators);
    typed('price', priceRange, price);

    // La etiqueta va solo con su número; el deslizador lleva la suya (`aria-label`) y la ayuda, `aria-describedby`.
    const field = (label: string, input: HTMLInputElement, ...children: Array<HTMLElement | null>) => el('div', { class: 'field orgcalcfield' },
      el('label', { class: 'label', for: input.id }, label), input, ...children);
    replace(marginHost,
      el('p', { class: 'muted small' }, t('Solo la ves tú y solo en este dispositivo: Ikisai no recibe nada de lo que pongas aquí.')),
      el('div', { class: 'orggrid' },
        field(t('Asistentes'), attendees, attendeesRange,
          el('small', { class: 'hint', id: 'margin-attendees-help' }, t('Pagan su plaza: suman ingresos y ocupan plaza.'))),
        fbMark(field(t('Colaboradores sin coste'), collaborators, collaboratorsRange,
          el('small', { class: 'hint', id: 'margin-collaborators-help' }, t('No pagan, pero ocupan plaza: Ikisai cobra su alojamiento y su comida. Solo cuentan en esta calculadora.'))),
        'organizers.diseno.margen.colaboradores', 'Colaboradores sin coste')),
      seats,
      seatsNote,
      el('div', { class: 'orgpriceblock' },
        field(t('Precio por asistente'), price,
          el('div', { class: 'orgrangewrap' }, beButton, priceRange), beLabel, beNone),
        fbMark(el('div', { class: 'orgwant' },
          el('label', { class: 'orgwant-row' }, el('span', null, t('Quiero ganar')), pct, el('span', null, t('% sobre los costes'))),
          el('small', { class: 'hint', id: 'margin-pct-help' }, t('Mueve el precio para ganar ese porcentaje por encima de lo que te cuesta todo.'))),
        'organizers.diseno.margen.porcentaje', 'Quiero ganar')),
      field(t('Otros gastos (viajes, materiales…)'), other),
      noIkisai,
      results);
    compute();
  }

  // --- Formulario del diseño ------------------------------------------------------------------------------------------
  function paint(staleAt: string | null): void {
    const numberField = (key: 'expected_guests' | 'minors_count', label: string) => el('label', { class: 'field' }, el('span', null, label),
      el('input', { ...DESIGN_FIELDS[key], /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ type: 'number', min: '0', step: '1', inputmode: 'numeric', id: `d-${key}`, value: state[key] === null ? '' : String(state[key]),
        oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; change({ [key]: v === '' ? (key === 'minors_count' ? 0 : null) : Math.max(0, Math.round(Number(v))) } as DraftFields); } }));
    const check = (key: keyof DraftFields, label: string) => el('label', { class: 'field check' },
      el('input', { ...DESIGN_FIELDS[key], /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ type: 'checkbox', id: `d-${key}`, checked: state[key as keyof typeof state] ? '' : null,
        onchange: (e: Event) => { change({ [key]: (e.target as HTMLInputElement).checked } as DraftFields); if (key === 'requires_meals') paint(staleAt); } }),
      el('span', null, t(label)));
    const select = (key: 'meal_plan_requested' | 'menu_style_requested', label: string, options: Array<[string, string]>) => el('label', { class: 'field' }, el('span', null, label),
      el('select', { ...DESIGN_FIELDS[key], /* data-field-id y demás: los pone fieldAttrs, con literales, en cada llamada */ id: `d-${key}`, onchange: (e: Event) => change({ [key]: (e.target as HTMLSelectElement).value || null } as DraftFields) },
        el('option', { value: '' }, '—'), ...options.map(([v, l]) => el('option', { value: v, selected: state[key] === v ? '' : null }, t(l)))));

    // Las supletorias no se piden aquí: se activan por habitación en Experiencia › Alojamiento (Booking §25).
    const extraRates = rates.rates.filter((r) => r.layer === 'extra' && r.service !== 'cama_supletoria');
    const extraRows = extraRates.map((r) => {
      const current = extras.find((e) => e.rate_id === r.id);
      const qty = el('input', { ...fieldAttrs({ id: 'organizers.diseno.extra.cantidad', label: 'Cantidad del extra', entity: 'booking.reservation_extra_requests', prop: 'quantity', type: 'number', sensitivity: 'internal' }), type: 'number', min: '1', step: '1', class: 'orgextraqty', value: String(current?.quantity ?? 1), hidden: current ? null : '',
        'aria-label': t('Cantidad'),
        oninput: (e: Event) => { const q = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1)); changeExtras(extras.map((x) => (x.rate_id === r.id ? { ...x, quantity: q } : x))); } }) as HTMLInputElement;
      return el('div', { class: 'orgextra', 'data-rate': r.id },
        el('label', { class: 'field check' },
          el('input', { ...fieldAttrs({ id: 'organizers.diseno.extra.pedir', label: 'Pedir el extra', entity: 'booking.reservation_extra_requests', prop: 'rate_id', type: 'toggle', sensitivity: 'internal' }), type: 'checkbox', checked: current ? '' : null, onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            qty.hidden = !on;
            changeExtras(on ? [...extras, { rate_id: r.id, quantity: Math.max(1, Number(qty.value) || 1) }] : extras.filter((x) => x.rate_id !== r.id));
          } }),
          el('span', null, el('strong', null, r.name), r.description ? el('span', { class: 'muted small' }, ` · ${r.description}`) : null)),
        qty);
    });

    replace(host,
      staleAt ? staleNote(staleAt) : null,
      priceBar,
      fbMark(section(t('Cómo vas'), { id: 'designReady' }, readyHost), 'organizers.diseno.falta', 'Lo que te falta por rellenar'),
      el('p', { class: 'muted' }, t('Lo que pongas aquí lo ve el equipo de Ikisai al momento. Se guarda solo.')),
      section(t('Personas'), { id: 'designPeople' }, el('div', { class: 'orggrid' },
        numberField('expected_guests', t('Personas previstas')), numberField('minors_count', t('De ellas, menores de edad')))),
      section(t('Comidas'), { id: 'designMeals' },
        check('requires_meals', L('Con comidas en Ikisai')),
        state.requires_meals ? el('div', { class: 'orggrid' },
          select('meal_plan_requested', t('Régimen'), MEAL_PLANS), select('menu_style_requested', t('Orientación del menú'), MENU_STYLES)) : null,
        el('p', { class: 'muted small' }, t('El menú se adapta después a las alergias e intolerancias de cada asistente.'))),
      section(t('Alojamiento y espacios'), { id: 'designSpaces' }, ...SPACES.map(([key, label]) => check(key, label))),
      fbMark(section(t('Extras'), { id: 'designExtras' },
        extraRows.length ? el('div', { class: 'orgextras' }, ...extraRows) : el('p', { class: 'muted' }, t('Ikisai aún no ofrece extras aquí.')),
        el('label', { class: 'field' }, el('span', null, t('¿Necesitas otra cosa? Cuéntaselo a Ikisai')),
          el('textarea', { ...fieldAttrs({ id: 'organizers.diseno.organizer_notes', label: 'Otra cosa para Ikisai', entity: 'booking.reservations', prop: 'organizer_notes', type: 'text', sensitivity: 'internal' }), id: 'd-organizer_notes', rows: '3', maxlength: '2000', placeholder: t('Sonido, montaje especial, horarios…'),
            oninput: (e: Event) => change({ organizer_notes: (e.target as HTMLTextAreaElement).value || null }) }, state.organizer_notes))), 'organizers.diseno.extras', 'Extras'),
      section(t('Precio orientativo'), { id: 'designQuote' }, quoteHost),
      section(t('¿Cuánto ganas?'), { id: 'designMargin' }, marginHost),
      el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'designSaveState' }, saves.field('diseno').element)));
    paintChecks();
    paintQuote();
    if (focusOnOpen) { const field = focusOnOpen; focusOnOpen = null; requestAnimationFrame(() => goField(field)); }
  }

  async function load(): Promise<void> {
    try {
      const [r, e, m, p] = await Promise.all([
        ctx.api.rates(reservationId),
        ctx.api.extraRequests(reservationId),
        cache.draft<Partial<Margins>>(ctx.userId, marginKey),
        ctx.api.proposals(reservationId).catch(() => null),
      ]);
      if (!alive) return;
      rates = r.value;
      extras = e.value.items.map((x) => ({ rate_id: x.rate_id, quantity: Number(x.quantity) || 1, note: x.note ?? null }));
      // Borradores viejos (sin colaboradores ni %): lo que falte, vacío. El precio manda: el % se recalcula al pintar.
      if (m) margins = { ...EMPTY_MARGINS, ...Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])) };
      proposal = p ? proposalVersions(p.value.items).current : null;
      paint((r.stale && r.at) || (e.stale && e.at) || null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }
  void load();

  (host as HTMLElement & { destroy?: () => void }).destroy = () => {
    alive = false;
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener('online', resume);
    if (timer) void save();
  };
  return host;
}
