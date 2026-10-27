/**
 * «Recepción» del alojamiento como la barra (VG 27-10-2026; API §38 y §39): las solicitudes de noches del QR por su número
 * corto. Recepción busca el número, ve qué falta, cobra (Bizum, efectivo, Bitcoin o tarjeta) y aloja en un gesto:
 * `booking.join_from_visitor({decision: 'accept', method})` crea las fichas con el borrador, la cama con sus fechas y el
 * cobro ya cobrado, y después cada cobro sale a Finance con las cabeceras de servidor (`sendWalkinToFinance`, #867). Lo que
 * falte de los datos se completa en Huéspedes.
 */
import type { SyncedRow } from '@ikisai/sync-client';
import { el, plural, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES, WALKIN_METHODS, WALKIN_METHOD_LABELS, canSeeGuests, missingForSes, type GuestLike } from '@ikisai/domain-booking';
import { BEDS, EVENTS, RESERVATIONS, SPACES, VISITOR_REQUESTS, WALKINS, canWrite, describeError, shortDay } from '../app/client.ts';
import { settleBatch } from '../app/settle.ts';
import { sendWalkinToFinance } from './eventKinds.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;
const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const euros = (cents: unknown): string => EUR.format((Number(cents) || 0) / 100);
const FIELD_LABELS: Record<string, string> = {
  first_name: 'nombre', last_name_1: 'primer apellido', last_name_2: 'segundo apellido', birth_date: 'nacimiento', residence_address: 'domicilio',
  residence_postal_code: 'código postal', residence_city: 'municipio', residence_country: 'país', contact: 'teléfono o correo', kinship: 'parentesco',
  document_type: 'tipo de documento', document_number: 'documento', document_support_number: 'número de soporte',
};

/** Estado para recepción: retenida (hasta), caducada o «sin reserva de plaza». */
export function holdText(r: Row, now = Date.now()): { text: string; tone: '' | ' warn' | ' alert' } {
  if (r.pay_mode !== 'hold') return { text: 'Sin plaza retenida', tone: '' };
  const until = r.hold_until ? new Date(r.hold_until).getTime() : 0;
  if (!until || until <= now) return { text: 'Retención caducada', tone: ' alert' };
  return { text: `Plaza retenida hasta las ${new Date(until).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`, tone: ' warn' };
}

/** Lo que falta por persona, con el borrador (solo lo ve quien ve huéspedes). */
export function missingText(drafts: Row[], persons: number): string[] {
  return Array.from({ length: persons }, (_, i) => {
    const draft = drafts.find((d) => Number(d.position) === i + 1 && !d.deleted_at);
    const missing = missingForSes((draft ?? {}) as GuestLike);
    const who = draft?.first_name || `Persona ${i + 1}`;
    return missing.length ? `${who}: falta ${missing.map((m) => FIELD_LABELS[m] ?? m).join(', ')}` : `${who}: datos completos`;
  });
}

export const mountReception: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const boot = client.bootstrap();
  const seesGuests = boot ? canSeeGuests(boot.membership) : false;
  const search = el('input', { id: 'receptionSearch', type: 'search', inputmode: 'numeric', placeholder: 'Número (p. ej. 142)', autocomplete: 'off', 'aria-label': 'Buscar por número',
    'data-feedback-id': 'booking.recepcion.buscar', 'data-feedback-label': 'Buscar número', oninput: () => void paint() }) as HTMLInputElement;
  const list = el('div', { id: 'receptionList' });
  replace(main, el('section', { class: 'view', 'data-feedback-id': 'booking.recepcion', 'data-feedback-label': 'Recepción' },
    el('h2', null, 'Recepción'),
    el('p', { class: 'hint' }, 'Quien pide noches por el QR trae un número. Búscalo, mira qué falta, cobra y aloja.'),
    search, list));
  let busy = false;

  async function paint(): Promise<void> {
    const live = (rows: SyncedRow[]) => (rows as Row[]).filter((r) => !r.deleted_at);
    const [requests, events, reservations, beds, spaces, drafts] = await Promise.all([
      client.list(VISITOR_REQUESTS), client.list(EVENTS), client.list(RESERVATIONS), client.list(BEDS), client.list(SPACES),
      seesGuests ? client.list(TABLES.stayTravelers as never).catch(() => [] as SyncedRow[]) : Promise.resolve([] as SyncedRow[]),
    ]);
    const eventOf = new Map(live(events).map((e) => [e.id, e]));
    const reservationOf = new Map(live(reservations).map((r) => [r.id, r]));
    const bedOf = new Map(live(beds).map((b) => [b.id, b]));
    const spaceOf = new Map(live(spaces).map((s) => [s.id, s]));
    const wanted = search.value.replace(/\D/g, '');
    const pending = live(requests).filter((r) => r.kind === 'stay' && r.status === 'pendiente' && eventOf.has(r.event_id))
      .filter((r) => !wanted || String(r.number ?? '').startsWith(wanted))
      .sort((a, b) => Number(a.number) - Number(b.number));
    if (!pending.length) {
      replace(list, el('div', { class: 'empty', id: 'receptionEmpty' }, el('strong', null, wanted ? `No hay ninguna solicitud con el ${wanted}` : 'Nadie esperando'),
        'Las solicitudes de «Alójate aquí» aparecen aquí con su número.'));
      return;
    }
    replace(list, el('ul', { class: 'list' }, pending.map((r) => {
      const ev = eventOf.get(r.event_id)!;
      const res = reservationOf.get(ev.reservation_id);
      const hold = holdText(r);
      const where = ((r.hold_bed_ids ?? []) as string[]).map((id) => bedOf.get(id)).filter(Boolean)
        .map((b) => `${spaceOf.get(b!.space_id)?.name ?? ''} · ${b!.label}`).join(', ') || 'Cama por asignar';
      const nights = Math.max(1, Math.round((Date.parse(r.to_date) - Date.parse(r.from_date)) / 86_400_000));
      const method = el('select', { class: 'small', 'aria-label': `Cómo paga el ${r.number}`, 'data-feedback-id': 'booking.recepcion.metodo', 'data-feedback-label': 'Método de cobro' },
        WALKIN_METHODS.map((m) => el('option', { value: m }, WALKIN_METHOD_LABELS[m]))) as HTMLSelectElement;
      return el('li', { class: 'row', dataset: { request: r.id, number: String(r.number) }, 'data-feedback-ignore': '' },
        el('div', { class: 'row-title' }, el('span', { class: 'name' }, `${r.number} · ${r.name ?? 'Visitante'}`), el('span', { class: 'chip ok' }, euros(r.total_cents))),
        el('div', { class: 'row-meta' }, `${res?.title ?? 'Evento'} · ${shortDay(r.from_date)} → ${shortDay(r.to_date)} · ${plural(nights, 'noche', 'noches')} · ${plural(Number(r.persons), 'persona', 'personas')}`),
        el('div', { class: 'row-meta' }, where, ' · ', el('span', { class: `chip${hold.tone}` }, hold.text)),
        seesGuests ? missingText(live(drafts).filter((d) => d.request_id === r.id), Number(r.persons)).map((line) => el('div', { class: 'row-meta' }, line)) : null,
        writable ? el('div', { class: 'row-actions' }, method,
          el('button', { class: 'primary small', type: 'button', 'data-action': 'accept', 'data-feedback-id': 'booking.recepcion.cobrar', 'data-feedback-label': 'Cobrar y alojar',
            onclick: () => void accept(r, method.value) }, 'Cobrar y alojar'),
          el('button', { class: 'ghost small', type: 'button', 'data-action': 'reject', 'data-feedback-id': 'booking.recepcion.descartar', 'data-feedback-label': 'Descartar',
            onclick: () => void reject(r) }, 'Descartar')) : null);
    })));
  }

  async function accept(r: Row, method: string): Promise<void> {
    if (busy) return;
    busy = true;
    const started = Date.now() - 60_000;
    try {
      const { requestId } = await client.commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: r.id, decision: 'accept', method } } as never]);
      const rejected = await settleBatch(client, requestId);
      if (rejected) { toast(describeError(rejected.error)); return; }
      // los cobros que acaba de crear este evento, ya cobrados: a Finance con la prueba de servidor
      const charges = ((await client.list(WALKINS)) as Row[]).filter((c) => c.event_id === r.event_id && !c.deleted_at && c.paid_at && !c.finance_sent_at
        && Date.parse(c.created_at) >= started);
      for (const c of charges) await sendWalkinToFinance(client, c);
      toast(`Alojado el ${r.number}. Lo que falte de sus datos se completa en Huéspedes.`);
      navigate(`#/huespedes/${r.event_id}`);
    } catch (error) {
      toast(describeError(error));
    } finally {
      busy = false;
    }
  }

  async function reject(r: Row): Promise<void> {
    try {
      const { requestId } = await client.commit([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: r.id, decision: 'reject' } } as never]);
      const rejected = await settleBatch(client, requestId);
      toast(rejected ? describeError(rejected.error) : `Solicitud ${r.number} descartada.`);
    } catch (error) {
      toast(describeError(error));
    }
  }

  const offs = [VISITOR_REQUESTS, WALKINS, TABLES.stayTravelers].map((t) => client.onTable(t as never, () => void paint()));
  void paint();
  return () => offs.forEach((off) => off());
};
