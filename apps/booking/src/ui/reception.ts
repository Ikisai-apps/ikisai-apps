/**
 * «Recepción» del alojamiento como la barra (VG 27-10-2026; API §38, §39 y §43). Los carriles del traspaso §4.3 son vistas
 * filtradas de una misma estancia (`createLanes` del kit; pestañas o lado a lado):
 * - «Por confirmar»: las solicitudes del QR por su número corto;
 * - «Entradas de hoy»;
 * - «En estancia»;
 * - «Salidas y limpieza»;
 * - «Excepciones»: cobro pendiente con la cama ocupada, datos incompletos, retención caducada o sin cama.
 * Cada ficha lleva cuatro indicadores independientes: plaza, cobro, documentación y presencia (`receptionCards`).
 * «Cobrar y alojar» (`booking.join_from_visitor` con `method`) crea las fichas con el borrador, la cama con sus fechas y el
 * cobro ya cobrado, y cada cobro sale después a Finance con las cabeceras de servidor (`sendWalkinToFinance`, #867).
 * «Llega» y «Sale» son `guest_arrive` y `guest_leave`: la salida libera la cama y pide la limpieza (1402).
 */
import type { SyncedRow } from '@ikisai/sync-client';
import { createLanes, el, replace, toast, type Lane } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES, WALKIN_METHODS, WALKIN_METHOD_LABELS, canSeeGuests, missingForSes, type GuestLike } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, EVENTS, GUESTS, RESERVATIONS, SPACES, VISITOR_REQUESTS, WALKINS, canWrite, describeError } from '../app/client.ts';
import { settleBatch } from '../app/settle.ts';
import { LANES, laneCards, receptionCards, type Indicator, type LaneKey, type ReceptionCard } from '../app/receptionLanes.ts';
import { sendWalkinToFinance } from './eventKinds.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const chip = (label: string, i: Indicator) => el('span', { class: `chip${i.tone ? ` ${i.tone}` : ''}`, title: label }, `${label}: ${i.text}`);

export const mountReception: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const boot = client.bootstrap();
  const seesGuests = boot ? canSeeGuests(boot.membership) : false;
  const search = el('input', { id: 'receptionSearch', type: 'search', placeholder: 'Número o nombre', autocomplete: 'off', 'aria-label': 'Buscar por número o nombre',
    'data-feedback-id': 'booking.recepcion.buscar', 'data-feedback-label': 'Buscar', oninput: () => void paint() }) as HTMLInputElement;
  let cards: ReceptionCard[] = [];
  let busy = false;
  const bodies = new Map<LaneKey, HTMLElement>();

  const renderLane = (key: LaneKey) => {
    const body = bodies.get(key);
    if (!body) return;
    const mine = laneCards(cards, key, search.value);
    replace(body, mine.length ? el('ul', { class: 'list', dataset: { lane: key } }, mine.map(card))
      : el('p', { class: 'hint', dataset: { laneEmpty: key } }, key === 'confirmar' ? 'Nadie esperando con número.' : 'Nada aquí ahora.'));
  };
  const lanesOf = (): Lane[] => LANES.map((l) => {
    const count = laneCards(cards, l.key, search.value).length;
    return { id: l.key, title: l.title, short: l.short, count, empty: count === 0, mount: (body: HTMLElement) => { bodies.set(l.key, body); renderLane(l.key); return () => bodies.delete(l.key); } };
  });
  const lanes = createLanes({ label: 'Carriles de recepción', lanes: lanesOf(), storageKey: 'booking-recepcion', feedbackId: 'booking.recepcion.carriles' });
  replace(main, el('section', { class: 'view', 'data-feedback-id': 'booking.recepcion', 'data-feedback-label': 'Recepción' },
    el('h2', null, 'Recepción'),
    el('p', { class: 'hint' }, 'La misma estancia vista por carriles. Cada ficha dice por separado cómo van la plaza, el cobro, los datos y la presencia.'),
    search, lanes.element));

  function card(c: ReceptionCard): HTMLElement {
    const method = el('select', { class: 'small', 'aria-label': `Cómo paga ${c.title}`, 'data-feedback-id': 'booking.recepcion.metodo', 'data-feedback-label': 'Método de cobro' },
      WALKIN_METHODS.map((m) => el('option', { value: m }, WALKIN_METHOD_LABELS[m]))) as HTMLSelectElement;
    const actions = !writable ? null : c.kind === 'request'
      ? el('div', { class: 'row-actions' }, method,
        el('button', { class: 'primary small', type: 'button', 'data-action': 'accept', 'data-feedback-id': 'booking.recepcion.cobrar', 'data-feedback-label': 'Cobrar y alojar', onclick: () => void accept(c, method.value) }, 'Cobrar y alojar'),
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'reject', 'data-feedback-id': 'booking.recepcion.descartar', 'data-feedback-label': 'Descartar', onclick: () => void decide(c, 'reject') }, 'Descartar'))
      : el('div', { class: 'row-actions' },
        c.presencia.text === 'Llega hoy' || c.presencia.text === 'Sin llegada marcada'
          ? el('button', { class: 'primary small', type: 'button', 'data-action': 'arrive', 'data-feedback-id': 'booking.recepcion.llega', 'data-feedback-label': 'Llega', onclick: () => void presence(c, PROCEDURES.guestArrive, 'Llegada anotada.') }, 'Llega') : null,
        c.presencia.text.startsWith('Dentro')
          ? el('button', { class: 'ghost small', type: 'button', 'data-action': 'leave', 'data-feedback-id': 'booking.recepcion.sale', 'data-feedback-label': 'Sale', onclick: () => void presence(c, PROCEDURES.guestLeave, 'Salida anotada: la cama queda libre y se pide su limpieza.') }, 'Sale') : null,
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'file', 'data-feedback-id': 'booking.recepcion.ficha', 'data-feedback-label': 'Ficha', onclick: () => navigate(`#/huespedes/${c.eventId}`) }, 'Ficha'));
    return el('li', { class: 'row', dataset: { card: c.key, ...(c.number ? { number: String(c.number) } : {}) }, 'data-feedback-ignore': '' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, c.title)),
      el('div', { class: 'row-meta reception-indicators' }, chip('Plaza', c.plaza), ' ', chip('Cobro', c.cobro), ' ', chip('Datos', c.docs), ' ', chip('Presencia', c.presencia)),
      c.why.length ? el('div', { class: 'row-meta' }, el('span', { class: 'chip alert' }, c.why.join(' · '))) : null,
      actions);
  }

  async function paint(): Promise<void> {
    const [requests, events, reservations, beds, spaces, guests, assignments, charges, drafts] = await Promise.all([
      client.list(VISITOR_REQUESTS), client.list(EVENTS), client.list(RESERVATIONS), client.list(BEDS), client.list(SPACES),
      seesGuests ? client.list(GUESTS) : Promise.resolve([] as SyncedRow[]), client.list(ASSIGNMENTS), client.list(WALKINS),
      seesGuests ? client.list(TABLES.stayTravelers as never).catch(() => [] as SyncedRow[]) : Promise.resolve([] as SyncedRow[]),
    ]);
    cards = receptionCards({
      today: madridToday(), now: Date.now(), seesGuests,
      requests: requests as Row[], events: events as Row[], reservations: reservations as Row[], beds: beds as Row[], spaces: spaces as Row[],
      guests: guests as Row[], assignments: assignments as Row[], charges: charges as Row[], drafts: drafts as Row[],
    }, (g) => missingForSes(g as GuestLike));
    lanes.setLanes(lanesOf());
    for (const l of LANES) renderLane(l.key);
  }

  async function run(operations: unknown[], done: string): Promise<boolean> {
    try {
      const { requestId } = await client.commit(operations as never);
      const rejected = await settleBatch(client, requestId);
      if (rejected) { toast(describeError(rejected.error)); return false; }
      toast(done);
      return true;
    } catch (error) {
      toast(describeError(error));
      return false;
    }
  }

  async function accept(c: ReceptionCard, method: string): Promise<void> {
    if (busy || !c.requestId) return;
    busy = true;
    const started = Date.now() - 60_000;
    try {
      if (!(await run([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: c.requestId, decision: 'accept', method } }], `Alojado el ${c.number}.`))) return;
      // los cobros que acaba de crear este evento, ya cobrados: a Finance con la prueba de servidor
      const fresh = ((await client.list(WALKINS)) as Row[]).filter((x) => x.event_id === c.eventId && !x.deleted_at && x.paid_at && !x.finance_sent_at && Date.parse(x.created_at) >= started);
      for (const x of fresh) await sendWalkinToFinance(client, x);
    } finally {
      busy = false;
    }
  }
  const decide = (c: ReceptionCard, decision: 'reject') => c.requestId
    ? run([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: c.requestId, decision } }], `Solicitud ${c.number} descartada.`) : Promise.resolve(false);
  const presence = (c: ReceptionCard, procedure: string, done: string) => c.guestId
    ? run([{ op: 'call', procedure, args: { guest_id: c.guestId } }], done) : Promise.resolve(false);

  const offs = [VISITOR_REQUESTS, WALKINS, GUESTS, ASSIGNMENTS, TABLES.stayTravelers].map((t) => client.onTable(t as never, () => void paint()));
  void paint();
  return () => { offs.forEach((off) => off()); lanes.destroy(); };
};
