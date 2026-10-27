/**
 * «Alójate aquí» (VG, por Core: el alojamiento como la barra), pestaña del visitante abierta por el QR del evento o por la
 * carta de Flow:
 * 1. **Noches y cama:** llegada y salida; las camas libres **todas** esas noches (`booking_public_beds`), por habitación,
 *    o «Asignadme una» (por defecto). Nunca huéspedes.
 * 2. **Tus datos**, en borrador: solo el nombre es obligatorio; el documento no hace falta hasta ir a dormir (recepción
 *    completa lo que falte al cobrar).
 * 3. **«Ir a pagar»** (`POST public/stay`): su número, como el de la barra, y «Ve a recepción y di tu número».
 * 4. Cuando recepción cobra, **«Esta noche duermes en …»** (`booking_visitor_stay`, que se mira cada 20 s mientras se
 *    espera el cobro, solo con la pantalla a la vista). Mientras no esté alojado, «Completar mis datos».
 */
import { announceSaved, el, fieldAttrs, icon, replace, toast } from '@ikisai/ui-kit';
import { formatDate, localeTag, t } from '../app/i18n.ts';
import { priceText } from '../app/offers.ts';
import { errorCodeOf, myStay, publicBeds, rememberEvent, saveTraveler, startStay, visitorPlans, type PublicBeds, type PublicEvent, type TravelerFields, type VisitorStay } from '../app/visitor.ts';
import { portalMap, withBedLayouts } from './plan.ts';
import { loading, whyNote } from './common.ts';

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const money = (cents: number | null | undefined) => priceText(cents ?? null, localeTag()) ?? '—';
const dayText = (day: string) => formatDate(day, { weekday: 'short', day: 'numeric', month: 'short' });
const POLL_MS = 20_000;

/** Campos del borrador, en este orden (el visitante aún no tiene ficha: los textos son `lodge.f.*`). */
// Cada campo, en el inventario (FieldSpec) con su ancla del Guiado; los mismos en «Tus datos» y en «Completar mis datos»
// (nunca están a la vez en pantalla). Se confirman al guardar (`announceSaved`).
const FIELDS: Array<{ key: keyof TravelerFields; type?: string; auto?: string; required?: boolean; mark: Record<string, string | null> }> = [
  { key: 'first_name', auto: 'given-name', required: true, mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.first_name', entity: 'booking.guests', prop: 'first_name', required: true, sensitivity: 'personal', confirm: 'event' }) },
  { key: 'last_name_1', auto: 'family-name', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.last_name_1', entity: 'booking.guests', prop: 'last_name_1', required: 'para dormir', sensitivity: 'personal', confirm: 'event' }) },
  { key: 'last_name_2', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.last_name_2', entity: 'booking.guests', prop: 'last_name_2', required: false, sensitivity: 'personal', confirm: 'event' }) },
  { key: 'document_type', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.document_type', entity: 'booking.guests', prop: 'document_type', type: 'select', required: 'para dormir', sensitivity: 'personal', confirm: 'event' }) },
  { key: 'document_number', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.document_number', entity: 'booking.guests', prop: 'document_number', required: 'para dormir', sensitivity: 'sensitive', confirm: 'event' }) },
  { key: 'birth_date', type: 'date', auto: 'bday', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.birth_date', entity: 'booking.guests', prop: 'birth_date', type: 'date', required: 'para dormir', sensitivity: 'personal', confirm: 'event' }) },
  { key: 'phone', type: 'tel', auto: 'tel', mark: fieldAttrs({ id: 'guests.visitante.alojate.viajero.phone', entity: 'booking.guests', prop: 'phone', type: 'tel', required: false, sensitivity: 'personal', confirm: 'event' }) },
];
/** Avisa al Guiado de los campos del viajero guardados (los que llevaban algo). */
const announceTraveler = (fields: TravelerFields) => FIELDS.forEach((f) => { const id = f.mark['data-field-id']; if (fields[f.key] && id) announceSaved(id); });
const DOCUMENT_TYPES = ['DNI', 'NIE', 'Pasaporte', 'TIE', 'Otro'];
/** Los campos que Booking puede decir que faltan (`booking.guests`); uno desconocido sale tal cual. */
const KNOWN = ['first_name', 'last_name_1', 'last_name_2', 'document_type', 'document_number', 'document_support_number', 'birth_date', 'phone', 'email',
  'sex', 'nationality', 'residence_address', 'residence_city', 'residence_postal_code', 'residence_country', 'signature'];
const fieldLabel = (key: string) => (KNOWN.includes(key) ? t(`lodge.f.${key}`) : key);

function lodgeError(error: unknown): string {
  switch (errorCodeOf(error)) {
    case 'NETWORK': return t('error.offline');
    case 'BED_TAKEN': return t('lodge.bedTaken');
    case 'NO_AVAILABILITY': return t('stay.noAvailability');
    case 'NO_LODGING': return t('stay.noLodging');
    case 'INVALID_FIELDS': return t('lodge.invalid');
    case 'RATE_LIMITED': return t('visitor.busy');
    default: return t('stay.failed');
  }
}

/** El formulario del borrador: devuelve sus campos y cómo leerlos. */
function travelerForm(prefix: string): { element: HTMLElement; read(): TravelerFields; first: HTMLInputElement } {
  const inputs = new Map<keyof TravelerFields, HTMLInputElement | HTMLSelectElement>();
  const rows = FIELDS.map((f) => {
    const id = `${prefix}${f.key}`;
    const input = f.key === 'document_type'
      ? el('select', { id, class: 'input', ...f.mark }, el('option', { value: '' }, '—'), ...DOCUMENT_TYPES.map((d) => el('option', { value: d }, d))) as HTMLSelectElement
      : el('input', { id, class: 'input', type: f.type ?? 'text', maxlength: '120', ...(f.auto ? { autocomplete: f.auto } : {}), ...(f.required ? { required: '' } : {}),
        // El número de documento, sin corrector ni mayúsculas automáticas a medias (la letra del DNI o el NIE).
        ...(f.key === 'document_number' ? { autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false' } : {}), ...f.mark }) as HTMLInputElement;
    inputs.set(f.key, input);
    return el('label', { class: 'field', for: id }, el('span', null, t(`lodge.f.${f.key}`)), input);
  });
  return {
    element: el('div', { class: 'glodge-fields' }, ...rows),
    read: () => Object.fromEntries([...inputs].map(([k, i]) => [k, i.value.trim()]).filter(([, v]) => v)) as TravelerFields,
    first: inputs.get('first_name') as HTMLInputElement,
  };
}

export interface LodgeOptions {
  /** ¿Sigue esta pantalla a la vista? (cambio de ruta). */
  alive(): boolean;
}

export function mountLodge(host: HTMLElement, event: PublicEvent, today: string, options: LodgeOptions): void {
  const code = event.code;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };

  const refresh = async () => {
    stop();
    if (!options.alive()) return;
    // Con la pantalla oculta no se mira: se vuelve a intentar luego.
    if (document.visibilityState === 'hidden') { timer = setTimeout(() => void refresh(), POLL_MS); return; }
    let stay: VisitorStay | null = null;
    try { stay = await myStay(code); } catch (error) {
      if (!options.alive()) return;
      // Sin poder leer su estancia no se ofrece otra: podría tener ya una cama retenida.
      replace(host, whyNote('lodgeWhy', errorCodeOf(error) === 'NETWORK' ? t('error.offline') : t('lodge.readFailed')),
        el('button', { type: 'button', class: 'ghost', onclick: () => void refresh() }, t('common.retry')));
      return;
    }
    if (!options.alive()) return;
    if (stay && ['por_pagar', 'pagada', 'alojado'].includes(stay.status)) paintStay(stay);
    else paintChooser(stay);
  };

  /** Su número y, tras cobrar, dónde duerme; mientras no esté alojado, completar el borrador. */
  const paintStay = (stay: VisitorStay) => {
    const range = stay.from && stay.to ? t('stay.range', { from: dayText(stay.from), to: dayText(stay.to) }) : '';
    const paid = stay.status === 'pagada' || stay.status === 'alojado';
    const card = paid
      ? el('section', { class: 'card gcard glodge-done', id: 'lodgeTonight', role: 'status' },
        el('p', { class: 'glabel' }, icon('bed', 18), ' ', t('lodge.tonight')),
        el('p', { class: 'glodge-bed' }, stay.bed ? `${stay.bed.room} · ${stay.bed.label}` : t('lodge.bedSoon')),
        range ? el('p', { class: 'small' }, range) : null)
      : el('section', { class: 'card gcard glodge-number', id: 'lodgePay', role: 'status' },
        el('p', { class: 'glabel' }, t('lodge.yourNumber')),
        el('p', { class: 'glodge-n', id: 'lodgeNumber' }, stay.number ?? '—'),
        el('p', null, el('strong', null, t('lodge.goReception'))),
        el('p', { class: 'small' }, [range, stay.bed ? `${stay.bed.room} · ${stay.bed.label}` : t('lodge.bedAssigned'), typeof stay.total_cents === 'number' ? money(stay.total_cents) : ''].filter(Boolean).join(' · ')),
        stay.hold_until ? el('p', { class: 'small', id: 'lodgeHold' }, t('lodge.holdUntil', { when: new Intl.DateTimeFormat(localeTag(), { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(stay.hold_until)) })) : null);
    const missing = stay.status !== 'alojado' && stay.missing.length
      ? whyNote('lodgeMissing', t('lodge.missing', { list: stay.missing.map(fieldLabel).join(', ') }))
      : null;
    const complete = stay.status !== 'alojado' ? completeBox(stay) : null;
    replace(host, card, missing, complete);
    // Esperando el cobro: se vuelve a mirar cada 20 s con la pantalla a la vista.
    if (!paid && options.alive()) timer = setTimeout(() => void refresh(), POLL_MS);
  };

  const completeBox = (stay: VisitorStay) => {
    const form = travelerForm('lodgeEdit_');
    const save = el('button', { type: 'submit', class: 'ghost', id: 'lodgeSave', 'data-feedback-id': 'guests.visitante.alojate.datos.guardar', 'data-feedback-label': 'Guardar mis datos' }, t('lodge.save')) as HTMLButtonElement;
    return el('details', { class: 'card gcard', id: 'lodgeComplete', 'data-feedback-id': 'guests.visitante.alojate.datos', 'data-feedback-label': 'Completar mis datos' },
      el('summary', null, t('lodge.complete')),
      el('form', { novalidate: '', onsubmit: async (e: Event) => {
        e.preventDefault();
        save.disabled = true;
        try { const fields = form.read(); await saveTraveler(code, stay.id, fields); announceTraveler(fields); toast(t('lodge.saved')); void refresh(); }
        catch (error) { save.disabled = false; toast(lodgeError(error)); }
      } }, el('p', { class: 'small' }, t('lodge.draftText')), form.element, save));
  };

  /**
   * «Ver las camas en el plano» (VG, 27-10-2026): plegado; al abrirlo, el plano de la casa (`GET public/plans`, solo con la
   * identidad de visitante y habiendo entrado en el evento) con las camas libres todas esas noches para tocar y elegir;
   * las demás, ocupadas y sin nombre de nadie. Tocar una marca su opción en la lista, que sigue siendo la que manda.
   */
  const planBox = (beds: PublicBeds): HTMLElement => {
    const byResource = new Map(beds.rooms.flatMap((r) => r.beds.filter((b) => b.resource_bed_id).map((b) => [b.resource_bed_id!, b] as const)));
    const inner = el('div', { id: 'lodgePlan', 'aria-live': 'polite' });
    const box = el('details', { class: 'glodge-plan', id: 'lodgePlanBox', 'data-feedback-id': 'guests.visitante.alojate.plano', 'data-feedback-label': 'Ver las camas en el plano' },
      el('summary', null, icon('pin', 16), ' ', t('lodge.planOpen')), inner) as HTMLDetailsElement;
    let done = false;
    const load = () => {
      done = true;
      replace(inner, loading());
      void visitorPlans(code).then((data) => {
        if (!byResource.size || !data.plans.length) { replace(inner, whyNote('lodgePlanWhy', t('lodge.planNone'))); return; }
        const map = portalMap(withBedLayouts(data, beds.rooms), {
          mode: 'map', label: t('lodge.planLabel'), feedbackId: 'guests.visitante.alojate.plano.mapa', showDecor: false,
          layer: (s) => {
            const bed = byResource.get(s.id);
            return bed ? (bed.free ? { state: 'free' } : { state: 'occupied' }) : null;
          },
          onPick: (s) => {
            const bed = byResource.get(s.id);
            if (!bed?.free) return;
            const radio = host.querySelector<HTMLInputElement>(`input[name="lodgeBed"][value="${CSS.escape(bed.id)}"]`);
            if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
            map.select(s.id);
          },
        });
        replace(inner, map.element);
      }).catch((error) => {
        done = false;
        replace(inner, whyNote('lodgePlanWhy', errorCodeOf(error) === 'NETWORK' ? t('error.offline') : t('lodge.planFailed')),
          el('button', { type: 'button', class: 'ghost small', id: 'lodgePlanRetry', onclick: load }, t('common.retry')));
      });
    };
    box.addEventListener('toggle', () => { if (box.open && !done) load(); });
    return box;
  };

  /** Noches y cama, tus datos e «Ir a pagar». */
  const paintChooser = (previous: VisitorStay | null) => {
    const first = event.starts_on && event.starts_on > today ? event.starts_on : today;
    const last = event.ends_on ?? addDays(first, 1);
    const from = el('input', { type: 'date', id: 'lodgeFrom', class: 'input', value: first, min: first, max: last,
      ...fieldAttrs({ id: 'guests.visitante.alojate.llegada', entity: 'booking.visitor_requests', prop: 'from', type: 'date', required: true, sensitivity: 'internal', confirm: 'event' }) }) as HTMLInputElement;
    const to = el('input', { type: 'date', id: 'lodgeTo', class: 'input', value: addDays(first, 1), min: addDays(first, 1), max: addDays(last, 1),
      ...fieldAttrs({ id: 'guests.visitante.alojate.salida', entity: 'booking.visitor_requests', prop: 'to', type: 'date', required: true, sensitivity: 'internal', confirm: 'event' }) }) as HTMLInputElement;
    from.addEventListener('change', () => { to.min = addDays(from.value, 1); if (to.value <= from.value) to.value = addDays(from.value, 1); void beds(); });
    to.addEventListener('change', () => void beds());
    const bedsHost = el('div', { id: 'lodgeBeds', 'aria-live': 'polite' });
    let picked: string | null = null;
    const form = travelerForm('lodge_');
    const why = el('div', { 'aria-live': 'polite' });
    const go = el('button', { type: 'submit', class: 'primary wide', id: 'lodgeGo', 'data-feedback-id': 'guests.visitante.alojate.pagar', 'data-feedback-label': 'Ir a pagar' }, t('lodge.go')) as HTMLButtonElement;

    const beds = async () => {
      picked = null;
      // «Ir a pagar», apagado hasta tener la lista de camas de estas noches.
      go.disabled = true;
      if (!from.value || !to.value || to.value <= from.value) { replace(bedsHost, whyNote('lodgeBedsWhy', t('lodge.invalid'))); return; }
      replace(bedsHost, loading());
      try {
        const { value } = await publicBeds(code, from.value, to.value);
        const free = value.rooms.flatMap((r) => r.beds.filter((b) => b.free).map((b) => ({ room: r, bed: b })));
        const radio = (value_: string, label: HTMLElement | string, checked = false) => el('label', { class: 'glodge-bed-opt' },
          el('input', { type: 'radio', name: 'lodgeBed', value: value_, ...(checked ? { checked: '' } : {}), onchange: () => { picked = value_ || null; } }), label);
        replace(bedsHost,
          el('p', { class: 'small', id: 'lodgePrice' }, value.price_night_cents !== null
            ? t('lodge.price', { night: money(value.price_night_cents), total: money(value.price_night_cents * value.nights), nights: t('stay.nights', { count: value.nights }) }) : ''),
          free.length
            ? el('fieldset', { class: 'glodge-beds', ...fieldAttrs({ id: 'guests.visitante.alojate.cama', entity: 'booking.visitor_requests', prop: 'bed_id', type: 'select', required: false, sensitivity: 'internal', confirm: 'event' }) }, el('legend', null, t('lodge.bedTitle')),
              radio('', el('strong', null, t('lodge.assign')), true),
              ...value.rooms.filter((r) => r.beds.some((b) => b.free)).map((r) => el('div', { class: 'glodge-room', dataset: { room: r.id } },
                el('p', { class: 'small glodge-room-name' }, r.name),
                ...r.beds.filter((b) => b.free).map((b) => radio(b.id, b.label)))))
            : whyNote('lodgeFull', t('stay.full', { nights: t('stay.nights', { count: value.nights }) })));
        if (free.length) bedsHost.append(planBox(value));
        go.disabled = !free.length;
      } catch (error) {
        replace(bedsHost, whyNote('lodgeBedsWhy', lodgeError(error)), el('button', { type: 'button', class: 'ghost small', id: 'lodgeBedsRetry', onclick: () => void beds() }, t('common.retry')));
        go.disabled = true;
      }
    };

    replace(host,
      previous?.status === 'caducada' ? whyNote('lodgeExpired', t('lodge.expired')) : null,
      el('form', { class: 'card gcard glodge', id: 'lodgeForm', novalidate: '',
        onsubmit: async (e: Event) => {
          e.preventDefault();
          const traveler = form.read();
          if (!traveler.first_name) { form.first.focus(); replace(why, whyNote('lodgeWhy', t('visitor.nameNeeded'))); return; }
          go.disabled = true;
          try {
            await startStay(code, { from: from.value, to: to.value, bed_id: picked, traveler });
            rememberEvent(code);
            // Para el Guiado: lo que se guardó con «Ir a pagar».
            ['guests.visitante.alojate.llegada', 'guests.visitante.alojate.salida', 'guests.visitante.alojate.cama', 'guests.visitante.alojate.pagar'].forEach((id) => announceSaved(id));
            announceTraveler(traveler);
            void refresh();
          } catch (error) {
            go.disabled = false;
            replace(why, whyNote('lodgeWhy', lodgeError(error)));
            if (errorCodeOf(error) === 'BED_TAKEN') void beds();
          }
        } },
        el('h3', null, t('lodge.nights')),
        el('div', { class: 'gstay-form' },
          el('label', { class: 'field', for: 'lodgeFrom' }, el('span', null, t('stay.from')), from),
          el('label', { class: 'field', for: 'lodgeTo' }, el('span', null, t('stay.to')), to)),
        bedsHost,
        el('h3', null, t('lodge.data')),
        el('p', { class: 'small' }, t('lodge.draftText')),
        form.element,
        el('p', { class: 'small' }, t('visitor.keep')),
        why, go));
    void beds();
  };

  replace(host, loading());
  void refresh();
}
