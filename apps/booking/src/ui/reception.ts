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
import { announceSaved, createLanes, el, fieldAttrs, openSheet, registerReveal, replace, toast, type Lane, type Sheet } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES, WALKIN_METHODS, WALKIN_METHOD_LABELS, canSeeGuests, missingForSes, type GuestLike } from '@ikisai/domain-booking';
import { ASSIGNMENTS, BEDS, EVENTS, GUESTS, RESERVATIONS, SPACES, VISITOR_REQUESTS, WALKINS, canWrite, describeError } from '../app/client.ts';
import { settleBatch } from '../app/settle.ts';
import { LANES, laneCards, receptionCards, type Indicator, type LaneKey, type ReceptionCard } from '../app/receptionLanes.ts';
import { sendWalkinToFinance } from './eventKinds.ts';
import type { ViewMount } from './shell.ts';

type Row = SyncedRow & Record<string, any>;
/** Los datos del parte de viajeros, en palabras (las claves de `missingForSes`). */
const SES_FIELD: Record<string, string> = {
  first_name: 'nombre', last_name_1: 'primer apellido', last_name_2: 'segundo apellido', birth_date: 'fecha de nacimiento',
  residence_address: 'dirección', residence_postal_code: 'código postal', residence_city: 'población', residence_country: 'país de residencia',
  contact: 'teléfono o correo', kinship: 'parentesco del menor', document_type: 'tipo de documento', document_number: 'número de documento',
  document_support_number: 'número de soporte del documento',
};
const madridToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());
const chip = (label: string, i: Indicator) => el('span', { class: `chip${i.tone ? ` ${i.tone}` : ''}`, title: label }, `${label}: ${i.text}`);

export const mountReception: ViewMount = ({ main, client, navigate }) => {
  const writable = canWrite(client);
  const boot = client.bootstrap();
  const seesGuests = boot ? canSeeGuests(boot.membership) : false;
  // El filtro va en memoria (no relee las tablas en cada tecla) y se guarda en la pestaña: al volver de la ficha, o en el
  // Guiado, sigue señalando la misma ficha (los botones de cada ficha comparten anclaje y la guía señala el primero visible).
  const SEARCH_KEY = 'booking-recepcion-buscar';
  const search = el('input', { id: 'receptionSearch', ...fieldAttrs({ id: 'booking.recepcion.buscar', label: 'Buscar', confirm: 'none', storage: 'none' }), type: 'search', placeholder: 'Número o nombre', autocomplete: 'off', 'aria-label': 'Buscar por número o nombre',
    'data-feedback-id': 'booking.recepcion.buscar', 'data-feedback-label': 'Buscar', oninput: () => { remember(); rerender(); } }) as HTMLInputElement;
  try { search.value = sessionStorage.getItem(SEARCH_KEY) ?? ''; } catch { /* sin almacenamiento */ }
  const remember = () => { try { sessionStorage.setItem(SEARCH_KEY, search.value); } catch { /* sin almacenamiento */ } };
  let cards: ReceptionCard[] = [];
  let busy = false;
  let state: 'loading' | 'ready' | 'error' = 'loading';
  const bodies = new Map<LaneKey, HTMLElement>();

  const renderLane = (key: LaneKey) => {
    const body = bodies.get(key);
    if (!body) return;
    const mine = laneCards(cards, key, search.value);
    if (state === 'loading') return void replace(body, el('p', { class: 'hint', dataset: { laneLoading: key } }, 'Cargando…'));
    if (state === 'error') return void replace(body, el('p', { class: 'hint', dataset: { laneError: key } }, 'No se ha podido cargar. ',
      el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'booking.recepcion.reintentar', 'data-feedback-label': 'Reintentar', onclick: () => void paint() }, 'Reintentar')));
    replace(body, mine.length ? el('ul', { class: 'list reception-list', dataset: { lane: key } }, mine.map(card))
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
    const method = el('select', { class: 'small', ...fieldAttrs({ id: 'booking.recepcion.metodo', entity: 'booking.walkin_charges', prop: 'method', label: 'Método de cobro', confirm: 'event' }), 'aria-label': `Cómo paga ${c.title}`, 'data-feedback-id': 'booking.recepcion.metodo', 'data-feedback-label': 'Método de cobro' },
      WALKIN_METHODS.map((m) => el('option', { value: m }, WALKIN_METHOD_LABELS[m]))) as HTMLSelectElement;
    const paidOnline = c.cobro.text.startsWith('Pagado en línea');
    const actions = !writable ? null : c.kind === 'request' && paidOnline
      ? el('div', { class: 'row-actions' },
        el('button', { class: 'primary small', type: 'button', 'data-action': 'accept-online', 'data-feedback-id': 'booking.recepcion.alojar_pagado', 'data-feedback-label': 'Alojar (pagado en línea)', onclick: (e: Event) => void accept(c, 'online', e.currentTarget as HTMLButtonElement) }, 'Alojar (pagado en línea)'))
      : c.kind === 'request'
      ? el('div', { class: 'row-actions' }, method,
        el('button', { class: 'primary small', type: 'button', 'data-action': 'accept', 'data-feedback-id': 'booking.recepcion.cobrar', 'data-feedback-label': 'Cobrar y alojar', onclick: (e: Event) => void accept(c, method.value, e.currentTarget as HTMLButtonElement) }, 'Cobrar y alojar'),
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'reject', 'data-feedback-id': 'booking.recepcion.descartar', 'data-feedback-label': 'Descartar', onclick: (e: Event) => void decide(c, 'reject', e.currentTarget as HTMLButtonElement) }, 'Descartar'))
      : el('div', { class: 'row-actions' },
        c.presencia.text === 'Llega hoy' || c.presencia.text === 'Sin llegada marcada'
          ? el('button', { class: 'primary small', type: 'button', 'data-action': 'arrive', 'data-feedback-id': 'booking.recepcion.llega', 'data-feedback-label': 'Llega', onclick: (e: Event) => void arrive(c, e.currentTarget as HTMLButtonElement) }, 'Llega') : null,
        c.presencia.text.startsWith('Dentro')
          ? el('button', { class: 'ghost small', type: 'button', 'data-action': 'leave', 'data-feedback-id': 'booking.recepcion.sale', 'data-feedback-label': 'Sale', onclick: (e: Event) => void presence(c, PROCEDURES.guestLeave, 'Salida anotada: la cama queda libre y se pide su limpieza.', 'booking.recepcion.sale', e.currentTarget as HTMLButtonElement) }, 'Sale') : null,
        el('button', { class: 'ghost small', type: 'button', 'data-action': 'file', 'data-feedback-id': 'booking.recepcion.ficha', 'data-feedback-label': 'Ficha', onclick: () => navigate(c.guestId ? `#/huespedes/${c.eventId}/${c.guestId}` : `#/huespedes/${c.eventId}`) }, 'Ficha'));
    return el('li', { class: 'row', dataset: { card: c.key, ...(c.number ? { number: String(c.number) } : {}) }, 'data-feedback-ignore': '' },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, c.title)),
      el('div', { class: 'row-meta reception-indicators' }, chip('Plaza', c.plaza), ' ', chip('Cobro', c.cobro), ' ', chip('Datos', c.docs), ' ', chip('Presencia', c.presencia)),
      c.why.length ? el('div', { class: 'row-meta' }, el('span', { class: 'chip alert' }, c.why.join(' · '))) : null,
      actions);
  }

  const rerender = () => { lanes.setLanes(lanesOf()); for (const l of LANES) renderLane(l.key); };

  async function paint(): Promise<void> {
    try { await load(); state = 'ready'; } catch { state = 'error'; }
    rerender();
  }

  async function load(): Promise<void> {
    const [requests, events, reservations, beds, spaces, guests, assignments, charges, drafts, payments] = await Promise.all([
      client.list(VISITOR_REQUESTS), client.list(EVENTS), client.list(RESERVATIONS), client.list(BEDS), client.list(SPACES),
      seesGuests ? client.list(GUESTS) : Promise.resolve([] as SyncedRow[]), client.list(ASSIGNMENTS), client.list(WALKINS),
      seesGuests ? client.list(TABLES.stayTravelers as never).catch(() => [] as SyncedRow[]) : Promise.resolve([] as SyncedRow[]),
      client.list(TABLES.stayPayments as never).catch(() => [] as SyncedRow[]),
    ]);
    cards = receptionCards({
      today: madridToday(), now: Date.now(), seesGuests,
      requests: requests as Row[], events: events as Row[], reservations: reservations as Row[], beds: beds as Row[], spaces: spaces as Row[],
      guests: guests as Row[], assignments: assignments as Row[], charges: charges as Row[], drafts: drafts as Row[], payments: payments as Row[],
    }, (g) => missingForSes(g as GuestLike));
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

  async function accept(c: ReceptionCard, method: string, button?: HTMLButtonElement): Promise<void> {
    if (busy || !c.requestId) return;
    busy = true;
    // señal visible mientras se aloja (revisión móvil de UI-kit): el botón no admite otro toque
    if (button) button.disabled = true;
    const started = Date.now() - 60_000;
    try {
      if (!(await run([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: c.requestId, decision: 'accept', method } }], `Alojado el ${c.number}.`))) return;
      // Guiado: alojado de verdad (la base lo ha aceptado)
      // los dos caminos confirman el mismo paso: lo pagado en línea avisa también con el anclaje de «Cobrar y alojar»
      announceSaved('booking.recepcion.cobrar');
      if (method === 'online') announceSaved('booking.recepcion.alojar_pagado');
      // los cobros que acaba de crear este evento, ya cobrados: a Finance con la prueba de servidor
      const fresh = ((await client.list(WALKINS)) as Row[]).filter((x) => x.event_id === c.eventId && !x.deleted_at && x.paid_at && !x.finance_sent_at && Date.parse(x.created_at) >= started);
      for (const x of fresh) await sendWalkinToFinance(client, x);
    } finally {
      busy = false;
      if (button) button.disabled = false;
    }
  }
  /** Una acción cada vez, con el botón desactivado mientras va (un doble toque no manda dos llamadas). */
  async function once(button: HTMLButtonElement | undefined, work: () => Promise<boolean>): Promise<boolean> {
    if (busy) return false;
    busy = true;
    if (button) button.disabled = true;
    try { return await work(); } finally { busy = false; if (button) button.disabled = false; }
  }
  const decide = (c: ReceptionCard, decision: 'reject', button?: HTMLButtonElement) => c.requestId
    ? once(button, () => run([{ op: 'call', procedure: PROCEDURES.joinFromVisitor, args: { request_id: c.requestId, decision } }], `Solicitud ${c.number} descartada.`)) : Promise.resolve(false);
  const presence = (c: ReceptionCard, procedure: string, done: string, anchor: string, button?: HTMLButtonElement) => c.guestId
    ? once(button, () => run([{ op: 'call', procedure, args: { guest_id: c.guestId } }], done).then((ok) => { if (ok) announceSaved(anchor); return ok; })) : Promise.resolve(false);

  /**
   * «Llega» con el parte de viajeros (SES): si a la ficha le falta algo para el parte o nadie ha visto el documento, una hoja
   * lo dice antes de marcar la llegada. En recepción se marca «He visto el documento» (sin él, el parte no sale) y se puede
   * ir a la ficha para completarlo y firmar. Sin documento la llegada se puede anotar igual, pero el parte queda pendiente y
   * hay que comunicarlo en 24 horas: la hoja lo avisa. Lo que no va a SES (sin pernocta, equipo) llega directo.
   */
  async function arrive(c: ReceptionCard, button?: HTMLButtonElement): Promise<void> {
    if (!c.guestId) return;
    const g = (await client.get(GUESTS, c.guestId)) as Row | null;
    const noSes = !g || (g.ses_status === 'no_aplica' && g.data_status === 'no_aplica') || g.portal_role;
    const missing = noSes ? [] : missingForSes(g as GuestLike);
    const needsCheck = !noSes && !g!.is_minor && !g!.document_checked_at;
    if (!missing.length && !needsCheck) return void presence(c, PROCEDURES.guestArrive, 'Llegada anotada.', 'booking.recepcion.llega', button);
    const seen = el('input', { type: 'checkbox', id: 'arriveSeen', checked: false, disabled: !g!.document_number }) as HTMLInputElement;
    const go = el('button', { class: 'primary', type: 'button', id: 'arriveSave', 'data-feedback-id': 'booking.recepcion.llega.guardar', 'data-feedback-label': 'Marcar la llegada', onclick: () => void save() }, 'Marcar la llegada') as HTMLButtonElement;
    const sheet: Sheet = openSheet({
      title: `Llega ${c.title}`,
      body: el('div', { 'data-feedback-id': 'booking.recepcion.llega.parte', 'data-feedback-label': 'Parte de viajeros al llegar' },
        missing.length
          ? el('p', { class: 'banner warn', id: 'arriveMissing' }, `Falta para el parte de viajeros: ${missing.map((k) => SES_FIELD[k] ?? k).join(', ')}.`)
          : el('p', { class: 'banner ok' }, 'Los datos del parte están completos.'),
        needsCheck ? el('label', { class: 'field check', 'data-feedback-id': 'booking.recepcion.llega.documento', 'data-feedback-label': 'He visto el documento' }, seen,
          el('span', null, g!.document_number ? `He visto el documento original (${g!.document_type ?? 'documento'})` : 'He visto el documento original (primero hay que anotarlo en la ficha)')) : null,
        !g!.document_number && !g!.is_minor
          ? el('p', { class: 'hint' }, 'Sin documento no se puede comunicar a SES. Puedes anotar la llegada, pero el parte queda pendiente y hay que enviarlo en 24 horas.')
          : el('p', { class: 'hint' }, 'La firma y lo que falte se completan en su ficha.')),
      foot: el('div', { class: 'choices' }, go,
        el('button', { class: 'ghost', type: 'button', id: 'arriveFile', 'data-feedback-id': 'booking.recepcion.llega.ficha', 'data-feedback-label': 'Completar la ficha', onclick: () => { void sheet.close(); navigate(`#/huespedes/${c.eventId}/${c.guestId}`); } }, 'Completar la ficha y firmar'),
        el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')),
      initialFocus: needsCheck && g!.document_number ? seen : go,
    });
    async function save(): Promise<void> {
      const ops: unknown[] = [];
      if (needsCheck && seen.checked) ops.push({ op: 'update', table: GUESTS, id: g!.id, expectedRevision: g!.revision,
        fields: { document_checked_at: new Date().toISOString(), document_checked_by: boot?.profile.userId ?? null } });
      ops.push({ op: 'call', procedure: PROCEDURES.guestArrive, args: { guest_id: g!.id } });
      const ok = await once(go, () => run(ops, missing.length || (needsCheck && !seen.checked) ? 'Llegada anotada. El parte queda pendiente de completar.' : 'Llegada anotada.'));
      if (!ok) return;
      await sheet.close(true);
      announceSaved('booking.recepcion.llega');
      if (button) button.disabled = false;
    }
  }

  // 1: en el móvil (pestañas) solo se monta un carril; el Guiado pide el del botón que busca
  const LANE_OF: Record<string, LaneKey> = { cobrar: 'confirmar', alojar_pagado: 'confirmar', descartar: 'confirmar', metodo: 'confirmar', llega: 'entradas', sale: 'estancia', ficha: 'estancia' };
  const offReveal = registerReveal('booking.recepcion', (id) => {
    const lane = LANE_OF[id.split('.')[2] ?? ''];
    if (!lane) return;
    // «Sale» puede estar en «En estancia» o en «Salidas»: si no hay ninguna ficha con salida en el primero, el segundo
    const target = lane === 'estancia' && !laneCards(cards, 'estancia', search.value).length ? 'salidas' : lane;
    lanes.select(target, false);
  });

  const offs = [VISITOR_REQUESTS, WALKINS, GUESTS, ASSIGNMENTS, TABLES.stayTravelers, TABLES.stayPayments].map((t) => client.onTable(t as never, () => void paint()));
  void paint();
  return () => { offReveal(); offs.forEach((off) => off()); lanes.destroy(); };
};
