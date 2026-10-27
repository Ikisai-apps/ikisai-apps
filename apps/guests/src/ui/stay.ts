/**
 * «Dormir aquí» en la página pública del evento (ENTRADA_PUBLICA.md, tarjeta 2): llegada, salida y personas; modalidades
 * con precio por noche y total, si caben y cuántas plazas quedan **todas** esas noches (Booking `booking_public_lodging`,
 * calculado para el intervalo entero). Mirar no pide datos ni crea identidad. Al elegir una modalidad, la solicitud
 * (`POST public/stay`, Booking 0499) con el resumen, cómo se paga según el evento (`hold`: plaza guardada unas horas y pago
 * en recepción; `pay_first`: no se guarda hasta pagar) y lo mínimo: nombre; contacto y nota, optativos. Nunca camas
 * concretas ni huéspedes.
 */
import { el, replace } from '@ikisai/ui-kit';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { priceText } from '../app/offers.ts';
import { errorCodeOf, publicLodging, type PublicEvent, type PublicLodging, type VisitorRequest } from '../app/visitor.ts';
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
  /** Envía la solicitud (`POST public/stay`); sin ella, solo se mira. */
  send?: (input: { mode_id: string; from: string; to: string; persons: number; name: string; contact?: string | null; note?: string | null }) => Promise<void>;
  /** El error del envío, en texto. */
  error?: (error: unknown) => string;
}

const money = (cents: number | null | undefined) => priceText(cents ?? null, localeTag()) ?? '—';
const dayText = (day: string) => formatDate(day, { weekday: 'short', day: 'numeric', month: 'short' });

/** Cómo se paga, en texto: `hold` guarda la plaza unas horas y se paga en recepción; `pay_first`, no se guarda hasta pagar. */
function payText(pay: string | null | undefined, hours: number | null): string {
  if (pay === 'hold') return hours ? t('stay.payHold', { hours }) : t('stay.payHoldPlain');
  if (pay === 'pay_first') return t('stay.payFirst');
  return '';
}

/** Lo enviado, en «Lo que has pedido»: noches, personas, total y, con `hold`, hasta cuándo se guarda (o que caducó). */
export function stayRequestText(r: VisitorRequest): string {
  const hold = r.pay === 'hold' && r.hold_until && r.status === 'pendiente'
    ? (r.hold_expired ? t('stay.holdExpired') : t('stay.holdUntil', { when: new Intl.DateTimeFormat(localeTag(), { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(r.hold_until)) }))
    : r.pay === 'pay_first' && r.status === 'pendiente' ? t('stay.payFirst') : '';
  return [r.from && r.to ? t('stay.range', { from: dayText(r.from), to: dayText(r.to) }) : '', r.persons ? t('stay.personsCount', { count: r.persons }) : '',
    typeof r.total_cents === 'number' ? money(r.total_cents) : '', hold].filter(Boolean).join(' · ');
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
  /** La solicitud de una modalidad: resumen, cómo se paga y lo mínimo (nombre; contacto y nota, optativos). */
  const ask = (m: PublicLodging['modes'][number], l: PublicLodging) => {
    const name = el('input', { id: 'pubStayName', class: 'input', autocomplete: 'given-name', maxlength: '80', required: '' }) as HTMLInputElement;
    const contact = el('input', { id: 'pubStayContact', class: 'input', autocomplete: 'email', maxlength: '200' }) as HTMLInputElement;
    const note = el('input', { id: 'pubStayNote', class: 'input', maxlength: '300' }) as HTMLInputElement;
    const send = el('button', { type: 'submit', class: 'primary', id: 'pubStaySend', 'data-feedback-id': 'guests.visitante.noches.pedir', 'data-feedback-label': 'Pedir las noches' }, t('stay.send')) as HTMLButtonElement;
    const why = el('div', { 'aria-live': 'polite' });
    const form = el('form', { class: 'gstay-ask', id: 'pubStayAsk', novalidate: '',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!name.value.trim()) { name.focus(); replace(why, whyNote('pubStayAskWhy', t('visitor.nameNeeded'))); return; }
        send.disabled = true;
        try {
          await options.send!({ mode_id: m.id, from: l.from, to: l.to, persons: l.persons, name: name.value, contact: contact.value, note: note.value });
        } catch (error) {
          send.disabled = false;
          replace(why, whyNote('pubStayAskWhy', options.error ? options.error(error) : lodgingError(error)));
        }
      } },
      el('h4', null, t('stay.askTitle')),
      el('p', { id: 'pubStaySummary' }, el('strong', null, m.name), ' · ', t('stay.range', { from: dayText(l.from), to: dayText(l.to) }), ' · ',
        t('stay.personsCount', { count: l.persons }), ' · ', el('strong', null, money(m.total_cents))),
      payText(l.pay, l.hold_hours) ? el('p', { class: 'small', id: 'pubStayPay' }, payText(l.pay, l.hold_hours)) : null,
      el('label', { class: 'field', for: 'pubStayName' }, el('span', null, t('visitor.name')), name),
      el('label', { class: 'field', for: 'pubStayContact' }, el('span', null, t('visitor.contactOptional')), contact, el('span', { class: 'small' }, t('stay.contactWhy'))),
      el('label', { class: 'field', for: 'pubStayNote' }, el('span', null, t('visitor.note')), note),
      el('p', { class: 'small' }, t('visitor.keep')), why, send);
    replace(asking, form);
    name.focus();
  };
  const asking = el('div', { id: 'pubStayAskHost' });

  const paint = (l: PublicLodging) => {
    replace(asking);
    replace(result,
      el('p', { class: 'small', id: 'pubStayAvailable', role: 'status' },
        l.available > 0 ? t('stay.available', { count: l.available, nights: l.nights }) : t('stay.full', { nights: l.nights })),
      l.modes.length ? el('ul', { class: 'gstay-modes', id: 'pubStayModes' }, ...l.modes.map((m) => el('li', { class: `card gcard gstay-mode${m.fits ? '' : ' off'}`, dataset: { mode: m.id } },
        el('strong', null, m.name),
        m.includes ? el('span', { class: 'small' }, m.includes) : null,
        el('span', null, t('stay.price', { night: money(m.price_night_cents), total: money(m.total_cents), nights: l.nights })),
        el('span', { class: 'small' }, m.fits ? t('stay.fits') : t('stay.noFit', { max: m.max_persons ?? '—' })),
        options.send && m.fits && l.available >= l.persons
          ? el('button', { type: 'button', class: 'primary', 'data-feedback-id': 'guests.visitante.noches.elegir', 'data-feedback-label': 'Elegir modalidad', onclick: () => ask(m, l) }, t('stay.pick'))
          : null))) : whyNote('pubStayNoModes', t('stay.noModes')),
      payText(l.pay, l.hold_hours) ? el('p', { class: 'small' }, payText(l.pay, l.hold_hours)) : null,
      l.rules_text ? el('p', { class: 'small', id: 'pubStayRules' }, l.rules_text) : null);
  };
  return el('section', { class: 'card gcard gstay', id: 'pubStay', 'data-feedback-id': 'guests.visitante.noches', 'data-feedback-label': 'Dormir aquí' },
    el('h3', null, t('stay.title')),
    el('div', { class: 'gstay-form' },
      el('label', { class: 'field', for: 'pubStayFrom' }, el('span', null, t('stay.from')), from),
      el('label', { class: 'field', for: 'pubStayTo' }, el('span', null, t('stay.to')), to),
      el('label', { class: 'field', for: 'pubStayPersons' }, el('span', null, t('stay.persons')), persons)),
    el('button', { type: 'button', class: 'ghost', id: 'pubStayLook', 'data-feedback-id': 'guests.visitante.noches.ver', 'data-feedback-label': 'Ver precios y plazas', onclick: () => void look() }, t('stay.look')),
    result, asking);
}
