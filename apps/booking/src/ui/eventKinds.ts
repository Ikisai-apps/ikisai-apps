/**
 * Tipos de reserva, hito 2 (0482 y 0484; VG 26-10-2026): lo que la ficha pregunta y enseña según el tipo.
 * - Jornadas abiertas: sin régimen ni estilo de menú; el menú sale de las cartas de Food («Cartas de Food»); el alojamiento
 *   es a la carta, personas sueltas sobre la marcha («Alojar a alguien»: una ficha de huésped y su cama con sus noches).
 * - Familiar: sin propuesta, cobro, tarifas ni alojamiento; come del menú de casa de Food.
 */
import type { RowOperation, SyncClient, SyncedRow } from '@ikisai/sync-client';
import { confirmDialog, el, openSheet, plural, renderQr, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { PROCEDURES, WALKIN_METHODS, WALKIN_METHOD_LABELS, assignmentNights, dayNumber, isExtraBed, newPublicCode, visitorUrl, walkinNightPrice } from '@ikisai/domain-booking';
import { ASSIGNMENTS, EVENTS, GUESTS, RESERVATIONS, WALKINS, describeError, shortDay, today } from '../app/client.ts';
import type { FieldSpec } from './form.ts';
import { settleBatch } from '../app/settle.ts';
import type { LodgingData } from './lodging.ts';

type Row = SyncedRow & Record<string, any>;

export const isOpenDays = (type: unknown): boolean => type === 'jornadas_abiertas';
export const isFamily = (type: unknown): boolean => type === 'familiar';

const MEAL_PLAN_KEYS = ['meal_plan_requested', 'menu_style_requested', 'meal_plan_confirmed', 'menu_style_confirmed'];
const LODGING_KEYS = ['uses_accommodation', 'room_distribution', 'rooms_count', 'accommodation_status'];

/** Campos de las hojas de la reserva y del evento que no tocan a ese tipo. */
export function hiddenKeys(type: unknown): Set<string> {
  if (isOpenDays(type)) return new Set(MEAL_PLAN_KEYS);
  if (isFamily(type)) return new Set([...MEAL_PLAN_KEYS, ...LODGING_KEYS]);
  return new Set();
}
export const specsFor = (specs: FieldSpec[], type: unknown): FieldSpec[] => {
  const hidden = hiddenKeys(type);
  return hidden.size ? specs.filter((s) => !hidden.has(s.key)) : specs;
};

/** Un carta de Food tal como la publica `food.booking_carta_projection`. */
interface Carta { carta_id: string; name: string; active: boolean; items_count: number | null; event_id: string | null }

/**
 * «Cartas de Food» (jornadas abiertas): cuáles aplican a la reserva (`food_carta_ids`). Las cartas las lee de Food con red;
 * sin red enseña cuántas hay elegidas.
 */
export function renderCartas(o: { client: SyncClient; reservation: Row; editable: boolean; run: (ops: RowOperation[], message: string) => Promise<boolean> }): HTMLElement {
  const chosen = new Set<string>(Array.isArray(o.reservation.food_carta_ids) ? o.reservation.food_carta_ids : []);
  const body = el('div', { id: 'cartasBody' }, el('p', { class: 'hint' }, 'Cargando las cartas de Food…'));
  const host = el('div', { id: 'foodCartas', 'data-feedback-id': 'booking.reserva.comidas.cartas', 'data-feedback-label': 'Cartas de Food' },
    el('div', { class: 'sectionlabel' }, 'Cartas de Food', el('span', { class: 'count' }, String(chosen.size))), body);

  async function load(): Promise<void> {
    if (!navigator.onLine) return void replace(body, el('p', { class: 'hint' }, `${chosen.size ? plural(chosen.size, 'carta elegida', 'cartas elegidas') : 'Ninguna carta elegida'}. Las cartas se cargan con conexión.`));
    let cartas: Carta[];
    try {
      cartas = ((await o.client.api<{ rows: Carta[] }>('/read/food.booking_carta_projection?limit=200')).rows ?? []);
    } catch (error) {
      return void replace(body, el('p', { class: 'hint' }, `No se pueden leer las cartas de Food: ${describeError(error)}`));
    }
    const shown = cartas.filter((c) => c.active || chosen.has(c.carta_id)).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    if (shown.length === 0) return void replace(body, el('p', { class: 'hint', id: 'cartasEmpty' }, 'Food aún no ha publicado ninguna carta.'));
    replace(body,
      el('p', { class: 'hint' }, 'Lo que se vende en el evento sale de estas cartas. Food las ve en la ficha del evento.'),
      el('div', { class: 'btnrow', id: 'cartasList' }, shown.map((c) => {
        const on = chosen.has(c.carta_id);
        return el('button', {
          type: 'button', class: `ghost small${on ? ' on' : ''}`, 'aria-pressed': String(on), disabled: !o.editable, dataset: { carta: c.carta_id },
          'data-feedback-id': 'booking.reserva.comidas.cartas.carta', 'data-feedback-label': 'Carta',
          onclick: () => void toggle(c.carta_id),
        }, c.name, c.items_count ? ` · ${c.items_count}` : '', c.active ? '' : ' (retirada)');
      })));
  }

  async function toggle(id: string): Promise<void> {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id); else next.add(id);
    await o.run([{ op: 'update', table: RESERVATIONS, id: o.reservation.id, expectedRevision: o.reservation.revision, fields: { food_carta_ids: next.size ? [...next] : null } }],
      next.has(id) ? 'Carta añadida.' : 'Carta quitada.');
  }

  void load();
  return host;
}

/** Familiar: el evento come del menú de casa de Food (O3). */
export function renderHouseMenu(): HTMLElement {
  return el('p', { id: 'houseMenu', 'data-feedback-id': 'booking.reserva.comidas.casa', 'data-feedback-label': 'Menú de casa' },
    el('strong', null, 'Menú de casa (Food)'), ' · Las comidas salen del menú de casa; no hay régimen propio.');
}

const guestName = (g: Row): string => [g.first_name, g.last_name_1].filter(Boolean).join(' ') || 'Sin nombre';
const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const euros = (cents: number): string => EUR.format((Number(cents) || 0) / 100);

/**
 * Manda a Finance el ingreso de un cobro (booking-api, con la sesión de la persona) y anota el resultado en el cobro.
 * Sin acceso a Finance lo dice («Pide acceso a Finance») y queda para reenviar.
 */
export async function sendWalkinToFinance(client: SyncClient, charge: Row): Promise<boolean> {
  if (!navigator.onLine) { toast('Sin conexión: se enviará a Finance con «Enviar a Finance» al reconectar.'); return false; }
  let fields: Record<string, unknown>;
  let ok = false;
  try {
    const out = await client.api<{ result: { entry_id?: string } | null }>(`/walkins/${encodeURIComponent(charge.id)}/send/finance`, { method: 'POST', json: {} });
    fields = { finance_entry_id: out.result?.entry_id ?? null, finance_sent_at: new Date().toISOString(), finance_error: null };
    ok = true;
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    const message = code === 'NEEDS_ACCESS' ? 'Pide acceso a Finance: tu cuenta no puede enviarle cobros.' : describeError(error);
    toast(message);
    fields = { finance_error: message.slice(0, 300) };
  }
  try {
    const { requestId } = await client.commit([{ op: 'update', table: WALKINS, id: charge.id, expectedRevision: charge.revision, fields }]);
    await settleBatch(client, requestId);
  } catch { /* se ve en el estado del cobro */ }
  if (ok) toast('Cobro enviado a Finance.');
  return ok;
}

/**
 * «Alojamiento a la carta» (jornadas abiertas): quién duerme esta noche, lo cobrado y lo pendiente, y «Alojar a alguien»
 * en una hoja de un paso (nombre, desde, noches, cama, precio por noche de la tarifa y cobro). Crea la ficha de huésped, su
 * cama con esas noches y el cobro en un lote; si se cobra ya, manda el ingreso a Finance.
 */
export function renderWalkIn(o: { client: SyncClient; reservation: Row; event: Row; data: LodgingData; guests: Row[]; charges: Row[]; rates: Row[]; editable: boolean }): HTMLElement {
  const day = today();
  const now = dayNumber(day)!;
  const bedOf = new Map(o.data.beds.map((b) => [b.id, b]));
  const guestOf = new Map(o.guests.map((g) => [g.id, g]));
  const assignmentOf = new Map(o.data.assignments.map((a) => [a.id, a]));
  const tonight = o.data.assignments.filter((a) => {
    const n = assignmentNights(a as never, o.reservation as never);
    return n !== null && n[0] <= now && now < n[1] && a.guest_id;
  });
  const charges = o.charges.filter((c) => !c.deleted_at && assignmentOf.has(c.assignment_id));
  const paid = charges.filter((c) => c.paid_at).reduce((sum, c) => sum + Number(c.amount_cents), 0);
  const pending = charges.filter((c) => !c.paid_at).reduce((sum, c) => sum + Number(c.amount_cents), 0);

  function freeBeds(from: string, nights: number): Row[] {
    const range: [number, number] = [dayNumber(from)!, dayNumber(from)! + nights];
    const busy = new Set(o.data.assignments.filter((a) => {
      if (!a.bed_id) return false;
      const n = assignmentNights(a as never, o.reservation as never);
      return n !== null && n[0] < range[1] && range[0] < n[1];
    }).map((a) => a.bed_id));
    return o.data.beds.filter((b) => b.active !== false && !b.deleted_at && !isExtraBed(b as never) && !b.team_bed && !busy.has(b.id));
  }

  function open(): void {
    const start = String(o.reservation.start_date ?? day);
    const fromDefault = day < start ? start : day;
    const rate = walkinNightPrice(o.rates as never, String(o.reservation.event_type), fromDefault);
    const name = el('input', { id: 'walkName', type: 'text', maxlength: 120, autocomplete: 'off' }) as HTMLInputElement;
    const from = el('input', { id: 'walkFrom', type: 'date', value: fromDefault }) as HTMLInputElement;
    const nights = el('input', { id: 'walkNights', type: 'number', min: 1, max: 60, step: 1, value: '1', inputmode: 'numeric' }) as HTMLInputElement;
    const bed = el('select', { id: 'walkBed' }) as HTMLSelectElement;
    const price = el('input', { id: 'walkPrice', type: 'number', min: 0, step: '0.01', inputmode: 'decimal', value: rate ? (rate.cents / 100).toFixed(2) : '' }) as HTMLInputElement;
    const pay = el('select', { id: 'walkPay' }, el('option', { value: '' }, 'Pendiente de cobrar'), WALKIN_METHODS.map((m) => el('option', { value: m }, `Cobrado: ${WALKIN_METHOD_LABELS[m]}`))) as HTMLSelectElement;
    const total = el('p', { class: 'hint', id: 'walkTotal' });
    const error = el('p', { class: 'formerror', role: 'alert', hidden: true });
    const cents = () => Math.round(Number(price.value) * 100);
    const fill = () => {
      const beds = from.value && Number(nights.value) > 0 ? freeBeds(from.value, Number(nights.value)) : [];
      const spaceName = (b: Row) => o.data.spaces.find((s) => s.id === b.space_id)?.name ?? '';
      replace(bed, beds.length ? beds.map((b) => el('option', { value: b.id }, `${spaceName(b)} · ${b.label}`)) : el('option', { value: '' }, 'No hay camas libres esas noches'));
      bed.disabled = beds.length === 0;
      const n = Number(nights.value);
      total.textContent = price.value !== '' && n > 0 ? `${plural(n, 'noche', 'noches')} × ${euros(cents())} = ${euros(n * cents())}` : (rate ? '' : 'No hay tarifa de alojamiento por noche para este tipo: escribe el precio.');
    };
    from.addEventListener('change', fill); nights.addEventListener('input', fill); price.addEventListener('input', fill);
    fill();
    const save = el('button', { class: 'primary', type: 'button', id: 'walkSave', 'data-feedback-id': 'booking.reserva.alacarta.guardar', 'data-feedback-label': 'Alojar', onclick: () => void submit() }, 'Alojar');
    async function submit(): Promise<void> {
      const n = Number(nights.value);
      if (!name.value.trim()) return show('Escribe el nombre.');
      if (!from.value || !Number.isInteger(n) || n < 1) return show('Indica desde cuándo y cuántas noches.');
      if (!bed.value) return show('Elige una cama libre.');
      if (price.value === '' || !(cents() >= 0)) return show('Indica el precio por noche.');
      const chosen = bedOf.get(bed.value)!;
      const to = new Date(`${from.value}T00:00:00Z`); to.setUTCDate(to.getUTCDate() + n);
      const guestId = crypto.randomUUID(); const assignmentId = crypto.randomUUID(); const chargeId = crypto.randomUUID();
      const method = pay.value || null;
      const ops: RowOperation[] = [
        { op: 'insert', table: GUESTS, id: guestId, fields: { event_id: o.event.id, first_name: name.value.trim() } },
        { op: 'insert', table: ASSIGNMENTS, id: assignmentId, fields: { event_id: o.event.id, space_id: chosen.space_id, bed_id: chosen.id, guest_id: guestId, persons: 1, from_date: from.value, to_date: to.toISOString().slice(0, 10) } },
        { op: 'insert', table: WALKINS, id: chargeId, fields: { event_id: o.event.id, assignment_id: assignmentId, guest_id: guestId, nights: n, price_cents: cents(), amount_cents: n * cents(), ...(method ? { method, paid_at: new Date().toISOString() } : {}) } },
      ];
      save.disabled = true;
      try {
        const { requestId } = await o.client.commit(ops);
        // el envío a Finance necesita el cobro ya en el servidor: se espera a que el lote se confirme
        const rejected = navigator.onLine ? await settleBatch(o.client, requestId) : null;
        if (rejected) { show(describeError(rejected.error)); save.disabled = false; return; }
        await sheet.close(true);
        toast(navigator.onLine ? `Alojamiento guardado: ${name.value.trim()}.` : 'Guardado en este dispositivo. Se enviará al reconectar.');
        if (method && navigator.onLine && o.client.status().pendingCommands === 0) await sendWalkinToFinance(o.client, { id: chargeId, revision: 1 } as Row);
      } catch (e) { show(describeError(e)); save.disabled = false; }
    }
    function show(text: string): void { error.hidden = false; error.textContent = text; }
    const field = (text: string, control: HTMLElement, key: string) => el('label', { class: 'field', 'data-feedback-id': `booking.reserva.alacarta.${key}`, 'data-feedback-label': text }, el('span', null, text), control);
    const sheet: Sheet = openSheet({
      title: 'Alojar a alguien',
      body: el('form', { 'data-feedback-id': 'booking.reserva.alacarta.hoja', 'data-feedback-label': 'Alojar a alguien', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('div', { class: 'rowform' }, field('Nombre', name, 'nombre'), field('Desde', from, 'desde'), field('Noches', nights, 'noches'), field('Cama', bed, 'cama'),
          field('Precio por noche (€)', price, 'precio'), total, field('Cobro', pay, 'cobro'), error)),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')),
      initialFocus: name,
    });
  }

  /** Cobrar uno pendiente: el método y, con red, el envío a Finance. */
  function collect(charge: Row): void {
    const pay = el('select', { id: 'collectMethod' }, WALKIN_METHODS.map((m) => el('option', { value: m }, WALKIN_METHOD_LABELS[m]))) as HTMLSelectElement;
    const ok = el('button', { class: 'primary', type: 'button', id: 'collectSave', onclick: async () => {
      ok.disabled = true;
      try {
        const { requestId } = await o.client.commit([{ op: 'update', table: WALKINS, id: charge.id, expectedRevision: charge.revision, fields: { method: pay.value, paid_at: new Date().toISOString() } }]);
        const rejected = navigator.onLine ? await settleBatch(o.client, requestId) : null;
        if (rejected) { toast(describeError(rejected.error)); ok.disabled = false; return; }
        await sheet.close(true);
        if (navigator.onLine && o.client.status().pendingCommands === 0) await sendWalkinToFinance(o.client, { ...charge, revision: Number(charge.revision) + 1 });
      } catch (e) { toast(describeError(e)); ok.disabled = false; }
    } }, `Cobrar ${euros(charge.amount_cents)}`);
    const sheet: Sheet = openSheet({ title: 'Cobrar el alojamiento', body: el('label', { class: 'field' }, el('span', null, 'Cómo paga'), pay),
      foot: el('div', { class: 'choices' }, ok, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')), initialFocus: pay });
  }

  /** Guarda un cambio del cobro y, si ya estaba en Finance, lo reenvía (el reenvío sustituye el apunte; 1403). */
  async function saveCharge(charge: Row, fields: Record<string, unknown>, sheet: Sheet, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const { requestId } = await o.client.commit([{ op: 'update', table: WALKINS, id: charge.id, expectedRevision: charge.revision, fields }]);
      const rejected = navigator.onLine ? await settleBatch(o.client, requestId) : null;
      if (rejected) { toast(describeError(rejected.error)); button.disabled = false; return; }
      await sheet.close(true);
      const fresh = ((await o.client.list(WALKINS)) as Row[]).find((c) => c.id === charge.id);
      if (fresh?.paid_at && !fresh.finance_sent_at && navigator.onLine && o.client.status().pendingCommands === 0) await sendWalkinToFinance(o.client, fresh);
    } catch (e) { toast(describeError(e)); button.disabled = false; }
  }

  /** Ajustar noches o precio por noche: el importe vuelve a ser noches × precio. */
  function adjust(charge: Row): void {
    const nights = el('input', { id: 'adjustNights', type: 'number', min: 1, max: 60, step: 1, value: String(charge.nights), inputmode: 'numeric' }) as HTMLInputElement;
    const price = el('input', { id: 'adjustPrice', type: 'number', min: 0, step: '0.01', value: (Number(charge.price_cents) / 100).toFixed(2), inputmode: 'decimal' }) as HTMLInputElement;
    const ok = el('button', { class: 'primary', type: 'button', id: 'adjustSave', onclick: () => {
      const n = Math.round(Number(nights.value)); const cents = Math.round(Number(price.value) * 100);
      if (!Number.isInteger(n) || n < 1 || n > 60 || !Number.isFinite(cents) || cents < 0) return void toast('Revisa las noches y el precio.');
      if (n * cents < Number(charge.refund_cents ?? 0)) return void toast('El importe no puede quedar por debajo de lo devuelto.');
      void saveCharge(charge, { nights: n, price_cents: cents, amount_cents: n * cents }, sheet, ok);
    } }, 'Guardar el ajuste') as HTMLButtonElement;
    const sheet: Sheet = openSheet({ title: 'Ajustar el cobro', body: el('div', null,
      el('label', { class: 'field' }, el('span', null, 'Noches'), nights), el('label', { class: 'field' }, el('span', null, 'Precio por noche (€)'), price),
      charge.finance_sent_at ? el('p', { class: 'hint' }, 'Ya está en Finance: al guardar se reenvía y sustituye el apunte.') : null),
      foot: el('div', { class: 'choices' }, ok, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')), initialFocus: nights });
  }

  /** Devolver parte o todo lo cobrado: un solo apunte en Finance por lo cobrado menos lo devuelto. */
  function refund(charge: Row): void {
    const max = Number(charge.amount_cents);
    const amount = el('input', { id: 'refundAmount', type: 'number', min: 0, step: '0.01', value: (Number(charge.refund_cents ?? 0) / 100 || max / 100).toFixed(2), inputmode: 'decimal' }) as HTMLInputElement;
    const method = el('select', { id: 'refundMethod' }, WALKIN_METHODS.map((m) => el('option', { value: m }, WALKIN_METHOD_LABELS[m]))) as HTMLSelectElement;
    method.value = charge.refund_method ?? charge.method ?? 'cash';
    const ok = el('button', { class: 'primary', type: 'button', id: 'refundSave', onclick: () => {
      const cents = Math.round(Number(amount.value) * 100);
      if (!Number.isFinite(cents) || cents < 0 || cents > max) return void toast(`La devolución va de 0 a ${euros(max)}.`);
      void saveCharge(charge, cents === 0 ? { refund_cents: 0, refund_method: null, refunded_at: null } : { refund_cents: cents, refund_method: method.value, refunded_at: new Date().toISOString() }, sheet, ok);
    } }, 'Guardar la devolución') as HTMLButtonElement;
    const sheet: Sheet = openSheet({ title: 'Devolver', body: el('div', null,
      el('label', { class: 'field' }, el('span', null, `Importe devuelto (de ${euros(max)})`), amount), el('label', { class: 'field' }, el('span', null, 'Cómo se devuelve'), method),
      el('p', { class: 'hint' }, 'Con 0 se quita la devolución. En Finance queda un solo apunte por lo cobrado menos lo devuelto.')),
      foot: el('div', { class: 'choices' }, ok, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')), initialFocus: amount });
  }

  const chargeRow = (c: Row) => {
    const a = assignmentOf.get(c.assignment_id);
    const state = !c.paid_at ? el('span', { class: 'chip warn' }, 'Pendiente')
      : c.finance_sent_at ? el('span', { class: 'chip ok' }, `${WALKIN_METHOD_LABELS[c.method as keyof typeof WALKIN_METHOD_LABELS] ?? c.method} · en Finance`)
      : el('span', { class: 'chip alert' }, 'Cobrado, sin enviar a Finance');
    return el('li', { class: 'row', dataset: { charge: c.id }, 'data-feedback-ignore': '' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, guestName(guestOf.get(c.guest_id) ?? {} as Row)), el('span', { class: 'chip' }, euros(c.amount_cents)), state),
      el('div', { class: 'row-meta' }, `${plural(Number(c.nights), 'noche', 'noches')} × ${euros(c.price_cents)}${a ? ` · ${bedOf.get(a.bed_id)?.label ?? 'Sin cama'}` : ''}${c.finance_error && !c.finance_sent_at ? ` · ${c.finance_error}` : ''}`),
      Number(c.refund_cents) > 0 ? el('div', { class: 'row-meta' }, `Devuelto ${euros(c.refund_cents)} (${WALKIN_METHOD_LABELS[c.refund_method as keyof typeof WALKIN_METHOD_LABELS] ?? c.refund_method})`) : null,
      o.editable ? el('div', { class: 'row-actions' },
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'adjust', 'data-feedback-id': 'booking.reserva.alacarta.ajustar', 'data-feedback-label': 'Ajustar cobro', onclick: () => adjust(c) }, 'Ajustar…'),
        c.paid_at ? el('button', { class: 'ghost small', type: 'button', 'data-action': 'refund', 'data-feedback-id': 'booking.reserva.alacarta.devolver', 'data-feedback-label': 'Devolver', onclick: () => refund(c) }, 'Devolver…') : null) : null,
      o.editable && !c.paid_at ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'data-action': 'collect', onclick: () => collect(c) }, 'Cobrar…')) : null,
      o.editable && c.paid_at && !c.finance_sent_at ? el('div', { class: 'row-actions' }, el('button', { class: 'ghost small', type: 'button', 'data-action': 'send', onclick: () => void sendWalkinToFinance(o.client, c) }, c.finance_entry_id ? 'Reenviar a Finance' : 'Enviar a Finance')) : null);
  };

  return el('article', { class: 'card', id: 'blockWalkIn', 'data-feedback-id': 'booking.reserva.alacarta', 'data-feedback-label': 'Alojamiento a la carta' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Alojamiento a la carta')),
    el('p', { id: 'walkTotals' }, el('strong', null, `Cobrado ${euros(paid)}`), ` · Pendiente ${euros(pending)}`),
    el('div', { class: 'sectionlabel' }, 'Duermen esta noche', el('span', { class: 'count' }, String(tonight.length))),
    tonight.length === 0 ? el('p', { class: 'hint', id: 'walkTonightEmpty' }, 'Nadie esta noche.')
      : el('ul', { class: 'list', id: 'walkTonight' }, tonight.map((a) => el('li', { class: 'row', 'data-feedback-ignore': '' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, guestName(guestOf.get(a.guest_id) ?? {} as Row))),
        el('div', { class: 'row-meta' }, `${bedOf.get(a.bed_id)?.label ?? 'Sin cama'} · ${shortDay(a.from_date ?? o.reservation.start_date)} → ${shortDay(a.to_date ?? o.reservation.end_date)}`)))),
    charges.length ? [el('div', { class: 'sectionlabel' }, 'Cobros', el('span', { class: 'count' }, String(charges.length))), el('ul', { class: 'list', id: 'walkCharges' }, charges.map(chargeRow))] : null,
    o.editable ? el('p', { style: 'margin-top:10px' }, el('button', { class: 'primary small', type: 'button', id: 'walkIn', 'data-feedback-id': 'booking.reserva.alacarta.alojar', 'data-feedback-label': 'Alojar a alguien', onclick: open }, 'Alojar a alguien')) : null);
}

/** Una oferta de comida de Food (`food.event_offers_projection`, #758): un menú o una carta para uno o varios grupos. */
interface Offer {
  offer_id: string; event_id: string; name: string; meal_groups: string[] | null; days: string[] | null; services: string[] | null;
  place: string | null; payer: string | null; charge_when: string | null; menu_kind: string | null; menu_id: string | null;
  price_cents: number | null; active: boolean; position: number | null;
}

const PAYER: Record<string, string> = { huesped: 'Paga el huésped', organizador: 'Paga el organizador' };
const CHARGE: Record<string, string> = { barra: 'en barra', cuenta: 'a cuenta' };

/** «Ofertas de comida» del evento (Food): para quién, qué días y servicios, dónde, quién paga y qué menú. Solo lee; con red. */
export function renderOffers(o: { client: SyncClient; eventId: string }): HTMLElement {
  const body = el('div', null, el('p', { class: 'hint' }, 'Cargando las ofertas de Food…'));
  const host = el('div', { id: 'foodOffers', 'data-feedback-id': 'booking.reserva.comidas.ofertas', 'data-feedback-label': 'Ofertas de comida' },
    el('div', { class: 'sectionlabel' }, 'Ofertas de comida (Food)'), body);
  async function load(): Promise<void> {
    if (!navigator.onLine) return void replace(body, el('p', { class: 'hint' }, 'Las ofertas de Food se leen con conexión.'));
    let rows: Offer[];
    try {
      rows = (await o.client.api<{ rows: Offer[] }>(`/read/food.event_offers_projection?where[event_id]=${encodeURIComponent(o.eventId)}&limit=100`)).rows ?? [];
    } catch (error) {
      return void replace(body, el('p', { class: 'hint' }, `No se pueden leer las ofertas de Food: ${describeError(error)}`));
    }
    if (rows.length === 0) return void replace(body, el('p', { class: 'hint', id: 'offersEmpty' }, 'Food aún no ha publicado ofertas para este evento.'));
    rows.sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0) || a.name.localeCompare(b.name, 'es'));
    replace(body, el('ul', { class: 'list', id: 'offersList' }, rows.map((r) => el('li', { class: 'row', dataset: { offer: r.offer_id, active: String(r.active) }, 'data-feedback-id': 'booking.reserva.comidas.ofertas.oferta', 'data-feedback-label': 'Oferta' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, r.name),
        el('span', { class: 'chip' }, r.menu_kind === 'carta' ? 'Carta' : 'Menú cerrado'),
        r.active ? null : el('span', { class: 'chip muted' }, 'Sin nada disponible')),
      el('div', { class: 'row-meta' }, [
        r.meal_groups && r.meal_groups.length ? `Para ${r.meal_groups.join(', ')}` : 'Para todos los huéspedes',
        r.days && r.days.length ? r.days.map((d) => shortDay(d)).join(', ') : 'todos los días',
        r.services && r.services.length ? r.services.join(', ') : null,
        r.place,
        r.payer ? `${PAYER[r.payer] ?? r.payer}${r.charge_when ? ` ${CHARGE[r.charge_when] ?? r.charge_when}` : ''}` : null,
      ].filter(Boolean).join(' · '))))));
  }
  void load();
  return host;
}

/**
 * «QR de entrada» (0488, VG V0.2): el código público del evento para que los visitantes entren a ven.ikisai.com, con
 * «Imprimir» y «Regenerar» (el QR anterior deja de valer). El QR lo dibuja el kit (`renderQr`, ui-kit 0.60), negro sobre
 * blanco también en oscuro, con la URL y el código en grande debajo.
 */
export function renderPublicCode(o: { client: SyncClient; event: Row; editable: boolean; run: (ops: RowOperation[], message: string) => Promise<boolean> }): HTMLElement {
  const code = typeof o.event.public_code === 'string' ? o.event.public_code : null;
  const url = code ? visitorUrl(code) : null;
  const regenerate = async () => {
    if (!(await confirmDialog({ title: code ? 'Regenerar el código' : 'Generar el código', text: code ? 'El QR impreso dejará de valer: tendrás que imprimir el nuevo.' : 'Se crea el código público del evento para su QR de entrada.', confirmLabel: code ? 'Regenerar' : 'Generar' }))) return;
    await o.run([{ op: 'update', table: EVENTS, id: o.event.id, expectedRevision: o.event.revision, fields: { public_code: newPublicCode() } }], code ? 'Código regenerado: imprime el QR nuevo.' : 'Código creado.');
  };
  const card = el('article', { class: 'card', id: 'blockPublicCode', 'data-feedback-id': 'booking.reserva.qr', 'data-feedback-label': 'QR de entrada' },
    el('div', { class: 'cardhead' }, el('h3', null, 'QR de entrada')),
    code ? [
      el('div', { class: 'bk-qr', id: 'publicQr' }, renderQr(url!, { size: 200, label: 'QR de entrada de visitantes' })),
      el('p', { class: 'bk-qr-code', id: 'publicCode', 'data-feedback-ignore': '' }, code),
      el('p', { class: 'hint', id: 'publicUrl', 'data-feedback-ignore': '' }, url),
      el('p', { class: 'hint' }, 'Para los visitantes: abren el evento en ven.ikisai.com sin cuenta. Solo ven el nombre, las fechas y si se pueden apuntar.'),
    ] : el('p', { class: 'hint', id: 'publicCodeEmpty' }, 'Este evento aún no tiene código público.'),
    el('div', { class: 'btnrow' },
      code ? el('button', { class: 'ghost small', type: 'button', id: 'printPublicCode', 'data-feedback-id': 'booking.reserva.qr.imprimir', 'data-feedback-label': 'Imprimir el QR', onclick: () => printCard(card) }, 'Imprimir') : null,
      o.editable ? el('button', { class: 'ghost small', type: 'button', id: 'regeneratePublicCode', 'data-feedback-id': 'booking.reserva.qr.regenerar', 'data-feedback-label': 'Regenerar el código', onclick: () => void regenerate() }, code ? 'Regenerar' : 'Generar código') : null));
  return card;
}

/** Imprime solo esa tarjeta (la clase `bk-print-only` oculta el resto en @media print). */
function printCard(card: HTMLElement): void {
  document.body.classList.add('bk-print-one');
  card.classList.add('bk-print-target');
  const done = () => { document.body.classList.remove('bk-print-one'); card.classList.remove('bk-print-target'); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
}

/**
 * «Visitantes que piden apuntarse» (0489, BG18): las peticiones que llegan por el QR, con «Aceptar» (crea su ficha de
 * huésped) y «Descartar». Solo editor y owner.
 */
export function renderVisitorRequests(o: { requests: Row[]; editable: boolean; run: (ops: RowOperation[], message: string) => Promise<boolean> }): HTMLElement | null {
  const pending = o.requests.filter((r) => r.status === 'pendiente' && !r.deleted_at).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  if (pending.length === 0) return null;
  const decide = (r: Row, decision: 'accept' | 'reject' | 'done') => void o.run([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: r.id, decision } }],
    decision === 'accept' ? 'Visitante apuntado: ya tiene su ficha de huésped.' : decision === 'done' ? 'Dato atendido.' : 'Petición descartada.');
  return el('article', { class: 'card', id: 'blockVisitorRequests', 'data-feedback-id': 'booking.reserva.visitantes', 'data-feedback-label': 'Visitantes que piden apuntarse' },
    el('div', { class: 'cardhead' }, el('h3', null, 'Visitantes del QR'), el('span', { class: 'chip alert' }, String(pending.length))),
    el('ul', { class: 'list', id: 'visitorRequestList' }, pending.map((r) => el('li', { class: 'row', dataset: { request: r.id }, 'data-feedback-ignore': '' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, r.name || 'Visitante sin nombre'), r.kind === 'contact' ? el('span', { class: 'chip' }, 'Deja un dato') : el('span', { class: 'chip warn' }, 'Quiere apuntarse')),
      r.contact ? el('div', { class: 'row-meta' }, `Contacto: ${r.contact}`) : null,
      r.note ? el('div', { class: 'row-meta' }, r.note) : null,
      el('div', { class: 'row-meta' }, `Por el QR · ${shortDay(String(r.created_at).slice(0, 10))}`),
      o.editable ? el('div', { class: 'row-actions' },
        r.kind === 'contact'
          ? el('button', { class: 'primary small', type: 'button', 'data-action': 'done', onclick: () => decide(r, 'done') }, 'Atendido')
          : el('button', { class: 'primary small', type: 'button', 'data-action': 'accept', onclick: () => decide(r, 'accept') }, 'Aceptar'),
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'reject', onclick: () => decide(r, 'reject') }, 'Descartar')) : null))));
}

