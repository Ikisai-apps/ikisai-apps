/**
 * «Dormir aquí» en la página pública del evento (ENTRADA_PUBLICA.md, tarjeta 2): llegada, salida y personas; modalidades
 * con precio por noche y total, si caben y cuántas plazas quedan **todas** esas noches (Booking `booking_public_lodging`,
 * calculado para el intervalo entero). Mirar no pide datos ni crea identidad. Nunca camas concretas ni huéspedes.
 */
import { el, replace } from '@ikisai/ui-kit';
import { localeTag, t } from '../app/i18n.ts';
import { priceText } from '../app/offers.ts';
import { errorCodeOf, publicLodging, type PublicEvent, type PublicLodging } from '../app/visitor.ts';
import { loading, whyNote } from './common.ts';

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Por qué no hay respuesta, en texto (códigos de `booking_public_lodging`). */
function lodgingError(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'NETWORK': return t('error.offline');
    case 'NO_LODGING': return t('stay.noLodging');
    case 'NOT_FOUND': return t('visitor.unknownText');
    case 'INVALID_FIELDS': return t('stay.invalid');
    default: return t('stay.failed');
  }
}

export interface StayOptions {
  /** Con una modalidad elegida (tarjeta 2, la solicitud): lo pinta quien la monta. */
  onPick?: (choice: { mode: PublicLodging['modes'][number]; lodging: PublicLodging }) => void;
}

export function stayBlock(event: PublicEvent, today: string, options: StayOptions = {}): HTMLElement {
  const first = event.starts_on && event.starts_on > today ? event.starts_on : today;
  const last = event.ends_on ?? addDays(first, 1);
  const from = el('input', { type: 'date', id: 'pubStayFrom', class: 'input', value: first, min: first, max: last }) as HTMLInputElement;
  const to = el('input', { type: 'date', id: 'pubStayTo', class: 'input', value: addDays(first, 1), min: addDays(first, 1), max: addDays(last, 1) }) as HTMLInputElement;
  const persons = el('input', { type: 'number', id: 'pubStayPersons', class: 'input', value: '1', min: '1', max: '20', inputmode: 'numeric' }) as HTMLInputElement;
  const result = el('div', { id: 'pubStayResult', 'aria-live': 'polite' });
  from.addEventListener('change', () => {
    to.min = addDays(from.value, 1);
    if (to.value <= from.value) to.value = addDays(from.value, 1);
  });
  const look = async () => {
    const n = Number(persons.value);
    if (!from.value || !to.value || to.value <= from.value || !(n >= 1 && n <= 20)) { replace(result, whyNote('pubStayWhy', t('stay.invalid'))); return; }
    replace(result, loading());
    try {
      const loaded = await publicLodging(event.code, from.value, to.value, n);
      paint(loaded.value);
    } catch (error) {
      replace(result, whyNote('pubStayWhy', lodgingError(error)));
    }
  };
  const paint = (l: PublicLodging) => {
    const money = (cents: number | null) => priceText(cents, localeTag()) ?? '—';
    replace(result,
      el('p', { class: 'small', id: 'pubStayAvailable', role: 'status' },
        l.available > 0 ? t('stay.available', { count: l.available, nights: l.nights }) : t('stay.full', { nights: l.nights })),
      l.modes.length ? el('ul', { class: 'gstay-modes', id: 'pubStayModes' }, ...l.modes.map((m) => el('li', { class: `card gcard gstay-mode${m.fits ? '' : ' off'}`, dataset: { mode: m.id } },
        el('strong', null, m.name),
        m.includes ? el('span', { class: 'small' }, m.includes) : null,
        el('span', null, t('stay.price', { night: money(m.price_night_cents), total: money(m.total_cents), nights: l.nights })),
        el('span', { class: 'small' }, m.fits ? t('stay.fits') : t('stay.noFit', { max: m.max_persons ?? '—' })),
        options.onPick && m.fits && l.available >= l.persons
          ? el('button', { type: 'button', class: 'primary', 'data-feedback-id': 'guests.visitante.noches.elegir', 'data-feedback-label': 'Elegir modalidad', onclick: () => options.onPick!({ mode: m, lodging: l }) }, t('stay.pick'))
          : null))) : whyNote('pubStayNoModes', t('stay.noModes')),
      l.rules_text ? el('p', { class: 'small', id: 'pubStayRules' }, l.rules_text) : null);
  };
  return el('section', { class: 'card gcard gstay', id: 'pubStay', 'data-feedback-id': 'guests.visitante.noches', 'data-feedback-label': 'Dormir aquí' },
    el('h3', null, t('stay.title')),
    el('div', { class: 'gstay-form' },
      el('label', { class: 'field', for: 'pubStayFrom' }, el('span', null, t('stay.from')), from),
      el('label', { class: 'field', for: 'pubStayTo' }, el('span', null, t('stay.to')), to),
      el('label', { class: 'field', for: 'pubStayPersons' }, el('span', null, t('stay.persons')), persons)),
    el('button', { type: 'button', class: 'ghost', id: 'pubStayLook', 'data-feedback-id': 'guests.visitante.noches.ver', 'data-feedback-label': 'Ver precios y plazas', onclick: () => void look() }, t('stay.look')),
    result);
}
