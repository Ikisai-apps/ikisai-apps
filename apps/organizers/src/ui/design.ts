/**
 * «Diseña tu retiro» (fase 2, API.md §13.2; Booking B7d, B9 y B10). El borrador es la propia reserva de Booking «en
 * estudio»: lo que cambia aquí lo ve el personal al instante. Se guarda solo, campo a campo.
 * - Personas, comidas, alojamiento y espacios, extras y notas para Ikisai.
 * - Precio orientativo con el motor de tarifas de Booking (IVA incluido, mínimo comercial y señal).
 * - Calculadora privada de margen: solo en este dispositivo.
 */
import { createSaveState, el, replace, toast } from '@ikisai/ui-kit';
import type { DraftFields, ExtraRequest, PortalDates, PortalRates, ReservationDetail } from '../app/api.ts';
import { cache } from '../app/cache.ts';
import { describeError, errorCode, online } from '../app/client.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { dateRange } from '../app/labels.ts';
import { marginOf, quote, type Quote } from '../app/quote.ts';
import { failure, fbMark, loading, section, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

const MEAL_PLANS: Array<[string, string]> = [['pension_completa', L('Pensión completa')], ['media_pension', L('Media pensión')], ['desayuno', L('Desayuno')], ['segun_programa', L('Comidas según programa')]];
const MENU_STYLES: Array<[string, string]> = [['vegetariano', L('Vegetariano')], ['vegano', L('Vegano')], ['mixto', L('Mixto (con carne o pescado)')], ['otro', L('A medida')]];
const SPACES: Array<[keyof DraftFields, string]> = [
  ['uses_accommodation', L('Alojamiento (dormir en Ikisai)')], ['uses_interpretation_center', L('Centro de interpretación')],
  ['uses_outdoors', L('Zonas exteriores')], ['uses_pool', L('Piscina')],
  ['special_setup', L('Montaje especial de las salas')], ['technical_support', L('Apoyo técnico (sonido, proyección…)')],
];

interface Margins { price: string; attendees: string; other: string }

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
  const change = (fields: DraftFields) => { Object.assign(state, fields); pendingFields = { ...pendingFields, ...fields }; schedule(); paintQuote(); };
  const changeExtras = (next: ExtraRequest[]) => { extras = next; pendingExtras = next; schedule(); paintQuote(); };
  const resume = () => { if (Object.keys(pendingFields).length || pendingExtras) void save(); };
  window.addEventListener('online', resume);

  // --- Precio orientativo --------------------------------------------------------------------------------------------
  const quoteHost = el('div', { id: 'quote', 'data-feedback-id': 'organizers.diseno.precio', 'data-feedback-label': 'Precio orientativo' });
  const marginHost = el('div', { id: 'margin', 'data-feedback-id': 'organizers.diseno.margen', 'data-feedback-label': 'Calculadora privada' });
  // Fechas para el cálculo: la definitiva o una de las posibles (las que vienen bien primero).
  const candidates = dates?.mode === 'fixed' && dates.definitive
    ? [{ id: 'fixed', start: dates.definitive.start, end: dates.definitive.end }]
    : [...(dates?.options ?? [])].sort((a, b) => Number(b.organizer_ok) - Number(a.organizer_ok)).map((o) => ({ id: o.id, start: o.start, end: o.end }));
  let chosen = candidates[0] ?? null;
  let lastQuote: Quote | null = null;
  const money = (n: number) => i18n.formatMoney(n);

  function paintQuote(): void {
    if (!rates.available) {
      replace(quoteHost, el('p', { class: 'muted' }, t('Ikisai te enviará el precio. Aún no hay tarifas publicadas para calcularlo aquí.')));
      lastQuote = null; paintMargin(); return;
    }
    if (!chosen) {
      replace(quoteHost, el('p', { class: 'muted' }, t('Marca primero alguna fecha posible en «Fechas» para calcular el precio.')));
      lastQuote = null; paintMargin(); return;
    }
    const q = quote({
      reservation: { event_type: detail.event_type ?? 'retiro', start_date: chosen.start, end_date: chosen.end, expected_guests: state.expected_guests,
        uses_accommodation: state.uses_accommodation, requires_meals: state.requires_meals, uses_interpretation_center: state.uses_interpretation_center,
        uses_outdoors: state.uses_outdoors, uses_pool: state.uses_pool, special_setup: state.special_setup, technical_support: state.technical_support },
      persons: state.expected_guests ?? 0, rates: rates.rates, conditions: rates.conditions, extras,
    });
    lastQuote = q;
    const picker = candidates.length > 1 ? el('label', { class: 'field' }, el('span', null, t('Calcular para')),
      el('select', { id: 'quoteDates', onchange: (e: Event) => { chosen = candidates.find((c) => c.id === (e.target as HTMLSelectElement).value) ?? chosen; paintQuote(); } },
        ...candidates.map((c) => el('option', { value: c.id, selected: c.id === chosen?.id ? '' : null }, dateRange(c.start, c.end))))) : null;
    if (!q.available) {
      replace(quoteHost, picker, el('p', { class: 'muted' }, q.reason === 'no_persons' ? t('Indica cuántas personas venís para calcular el precio.') : t('Marca primero alguna fecha posible en «Fechas» para calcular el precio.')));
      paintMargin(); return;
    }
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
      q.minimumApplied && q.minimum !== null ? el('p', { class: 'banner info', id: 'quoteMinimum' }, t('Se aplica el mínimo por retiro de {importe} (el cálculo daba {calculado}).', { importe: money(q.minimum), calculado: money(q.total) })) : null,
      el('p', { class: 'muted small' }, t('Precio orientativo. La propuesta definitiva te la envía Ikisai.')));
    paintMargin();
  }

  // --- Calculadora privada de margen (solo en el dispositivo) --------------------------------------------------------
  const marginKey = `margin:${reservationId}`;
  let margins: Margins = { price: '', attendees: '', other: '' };
  function paintMargin(): void {
    const ikisai = lastQuote && lastQuote.available ? lastQuote.payable : 0;
    const input = (key: keyof Margins, label: string, placeholder: string) => el('label', { class: 'field' }, el('span', null, label),
      el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', id: `margin-${key}`, value: margins[key], placeholder,
        oninput: (e: Event) => { margins = { ...margins, [key]: (e.target as HTMLInputElement).value }; void cache.saveDraft(ctx.userId, marginKey, margins); paintResults(); } }));
    const results = el('dl', { class: 'kv orgtotals', id: 'marginResults' });
    function paintResults(): void {
      const att = margins.attendees === '' ? (state.expected_guests ?? 0) : Number(margins.attendees);
      const r = marginOf({ price: Number(margins.price || 0), attendees: att, ikisai, otherCosts: Number(margins.other || 0) });
      replace(results,
        el('dt', null, t('Ingresos')), el('dd', null, money(r.revenue)),
        el('dt', null, t('Gastos (Ikisai y otros)')), el('dd', null, money(r.cost)),
        el('dt', null, t('Margen')), el('dd', { id: 'marginValue', class: r.margin < 0 ? 'danger-text' : '' }, money(r.margin)),
        el('dt', null, t('Punto de equilibrio')), el('dd', { id: 'marginBreakEven' }, r.breakEven === null ? '—' : (r.breakEven === 1 ? t('1 asistente') : t('{n} asistentes', { n: r.breakEven }))));
    }
    replace(marginHost,
      el('p', { class: 'muted small' }, t('Solo la ves tú y solo en este dispositivo: Ikisai no recibe nada de lo que pongas aquí.')),
      el('div', { class: 'orggrid' },
        input('price', t('Precio por asistente'), '0'),
        input('attendees', t('Asistentes'), String(state.expected_guests ?? '')),
        input('other', t('Otros gastos (viajes, materiales…)'), '0')),
      results);
    paintResults();
  }

  // --- Formulario del diseño ------------------------------------------------------------------------------------------
  function paint(staleAt: string | null): void {
    const numberField = (key: 'expected_guests' | 'minors_count', label: string) => el('label', { class: 'field' }, el('span', null, label),
      el('input', { type: 'number', min: '0', step: '1', inputmode: 'numeric', id: `d-${key}`, value: state[key] === null ? '' : String(state[key]),
        oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; change({ [key]: v === '' ? (key === 'minors_count' ? 0 : null) : Math.max(0, Math.round(Number(v))) } as DraftFields); } }));
    const check = (key: keyof DraftFields, label: string) => el('label', { class: 'field check' },
      el('input', { type: 'checkbox', id: `d-${key}`, checked: state[key as keyof typeof state] ? '' : null,
        onchange: (e: Event) => { change({ [key]: (e.target as HTMLInputElement).checked } as DraftFields); if (key === 'requires_meals') paint(staleAt); } }),
      el('span', null, t(label)));
    const select = (key: 'meal_plan_requested' | 'menu_style_requested', label: string, options: Array<[string, string]>) => el('label', { class: 'field' }, el('span', null, label),
      el('select', { id: `d-${key}`, onchange: (e: Event) => change({ [key]: (e.target as HTMLSelectElement).value || null } as DraftFields) },
        el('option', { value: '' }, '—'), ...options.map(([v, l]) => el('option', { value: v, selected: state[key] === v ? '' : null }, t(l)))));

    const extraRates = rates.rates.filter((r) => r.layer === 'extra');
    const extraRows = extraRates.map((r) => {
      const current = extras.find((e) => e.rate_id === r.id);
      const qty = el('input', { type: 'number', min: '1', step: '1', class: 'orgextraqty', value: String(current?.quantity ?? 1), hidden: current ? null : '',
        'aria-label': t('Cantidad'),
        oninput: (e: Event) => { const q = Math.max(1, Math.round(Number((e.target as HTMLInputElement).value) || 1)); changeExtras(extras.map((x) => (x.rate_id === r.id ? { ...x, quantity: q } : x))); } }) as HTMLInputElement;
      return el('div', { class: 'orgextra', 'data-rate': r.id },
        el('label', { class: 'field check' },
          el('input', { type: 'checkbox', checked: current ? '' : null, onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            qty.hidden = !on;
            changeExtras(on ? [...extras, { rate_id: r.id, quantity: Math.max(1, Number(qty.value) || 1) }] : extras.filter((x) => x.rate_id !== r.id));
          } }),
          el('span', null, el('strong', null, r.name), r.description ? el('span', { class: 'muted small' }, ` · ${r.description}`) : null)),
        qty);
    });

    replace(host,
      staleAt ? staleNote(staleAt) : null,
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
          el('textarea', { id: 'd-organizer_notes', rows: '3', maxlength: '2000', placeholder: t('Sonido, montaje especial, horarios…'),
            oninput: (e: Event) => change({ organizer_notes: (e.target as HTMLTextAreaElement).value || null }) }, state.organizer_notes))), 'organizers.diseno.extras', 'Extras'),
      section(t('Precio orientativo'), { id: 'designQuote' }, quoteHost),
      section(t('Tu calculadora (privada)'), { id: 'designMargin' }, marginHost),
      el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'designSaveState' }, saves.field('diseno').element)));
    paintQuote();
  }

  async function load(): Promise<void> {
    try {
      const [r, e, m] = await Promise.all([
        ctx.api.rates(reservationId),
        ctx.api.extraRequests(reservationId),
        cache.draft<Margins>(ctx.userId, marginKey),
      ]);
      if (!alive) return;
      rates = r.value;
      extras = e.value.items.map((x) => ({ rate_id: x.rate_id, quantity: Number(x.quantity) || 1, note: x.note ?? null }));
      if (m) margins = m;
      paint((r.stale && r.at) || (e.stale && e.at) || null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }
  void load();

  (host as HTMLElement & { destroy?: () => void }).destroy = () => {
    alive = false;
    window.removeEventListener('online', resume);
    if (timer) void save();
  };
  return host;
}
