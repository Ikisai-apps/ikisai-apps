/**
 * Carriles de «Recepción» (traspaso §4.3; Core 27-10-2026): vistas filtradas de una misma estancia. Una ficha puede estar
 * en más de un carril («Excepciones» es un filtro encima de los otros). Cada ficha lleva cuatro indicadores independientes:
 * plaza, cobro, documentación y presencia. Que uno esté bien no da los otros por hechos.
 * Funciones puras (sin DOM ni red). Lo que falta de los datos lo da `missing`, la regla del dominio (`missingForSes`),
 * para que el módulo no dependa del alias del paquete.
 */

export type LaneKey = 'confirmar' | 'entradas' | 'estancia' | 'salidas' | 'excepciones';
export const LANES: ReadonlyArray<{ key: LaneKey; title: string; short: string }> = [
  { key: 'confirmar', title: 'Por confirmar', short: 'Confirmar' },
  { key: 'entradas', title: 'Entradas de hoy', short: 'Entradas' },
  { key: 'estancia', title: 'En estancia', short: 'Dentro' },
  { key: 'salidas', title: 'Salidas y limpieza', short: 'Salidas' },
  { key: 'excepciones', title: 'Excepciones', short: 'Excepc.' },
];

export type Tone = 'ok' | 'warn' | 'alert' | '';
export interface Indicator { tone: Tone; text: string }
export interface ReceptionCard {
  key: string;
  kind: 'request' | 'guest';
  eventId: string;
  title: string;
  number: number | null;
  requestId: string | null;
  guestId: string | null;
  lanes: LaneKey[];
  /** Por qué está en «Excepciones» (vacío si no). */
  why: string[];
  plaza: Indicator; cobro: Indicator; docs: Indicator; presencia: Indicator;
}

type Row = Record<string, any>;
export interface ReceptionInput {
  /** Hoy (AAAA-MM-DD, hora de Madrid) y el instante actual (ms). */
  today: string; now: number;
  requests: Row[]; guests: Row[]; assignments: Row[]; charges: Row[]; beds: Row[]; spaces: Row[]; events: Row[]; reservations: Row[];
  /** Borradores del viajero de las solicitudes (solo con el ámbito de huéspedes; si no, vacío). */
  drafts?: Row[];
  /** Si quien mira ve los datos de los huéspedes: sin él, la documentación sale como «—». */
  seesGuests: boolean;
}

const EUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const euros = (cents: unknown) => EUR.format((Number(cents) || 0) / 100);
const live = (rows: Row[]) => rows.filter((r) => !r.deleted_at);
const day = (value: unknown) => (typeof value === 'string' ? value.slice(0, 10) : null);
const madridDay = (iso: unknown) => (typeof iso === 'string' ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(iso)) : null);

/** Las fichas de recepción de los eventos de jornadas abiertas en curso o que empiezan hoy. */
export function receptionCards(input: ReceptionInput, missing: (guest: Row) => string[]): ReceptionCard[] {
  const today = input.today;
  const reservationOf = new Map(live(input.reservations).map((r) => [r.id, r]));
  const events = live(input.events).filter((e) => {
    const r = reservationOf.get(e.reservation_id);
    return r && r.event_type === 'jornadas_abiertas' && !['cancelada', 'perdida'].includes(r.status) && day(r.start_date)! <= today && today <= day(r.end_date)!;
  });
  const eventIds = new Set(events.map((e) => e.id));
  const bedOf = new Map(live(input.beds).map((b) => [b.id, b]));
  const spaceOf = new Map(live(input.spaces).map((s) => [s.id, s]));
  const place = (bedId: string | null | undefined) => {
    const b = bedId ? bedOf.get(bedId) : null;
    return b ? `${spaceOf.get(b.space_id)?.public_name || spaceOf.get(b.space_id)?.name || 'Habitación'} · ${b.label}` : null;
  };
  const cards: ReceptionCard[] = [];

  // Solicitudes del QR con número, por confirmar
  for (const q of live(input.requests).filter((x) => x.kind === 'stay' && x.status === 'pendiente' && eventIds.has(x.event_id))) {
    const held = q.pay_mode === 'hold';
    const expired = held && (!q.hold_until || Date.parse(q.hold_until) <= input.now);
    const beds = ((q.hold_bed_ids ?? []) as string[]).map(place).filter(Boolean).join(', ');
    const drafts = live(input.drafts ?? []).filter((d) => d.request_id === q.id);
    const persons = Number(q.persons) || 1;
    const missingCount = input.seesGuests
      ? Array.from({ length: persons }, (_, i) => missing(drafts.find((d) => Number(d.position) === i + 1) ?? {}).length).reduce((a, b) => a + b, 0) : null;
    const why = expired ? ['Retención caducada'] : [];
    cards.push({
      key: `q:${q.id}`, kind: 'request', eventId: q.event_id, title: `${q.number ?? '—'} · ${q.name ?? 'Visitante'}`, number: q.number ?? null, requestId: q.id, guestId: null,
      lanes: ['confirmar', ...(why.length ? ['excepciones' as const] : [])], why,
      plaza: expired ? { tone: 'alert', text: 'Retención caducada' } : beds ? { tone: held ? 'warn' : '', text: held ? `Retenida: ${beds}` : `Pedida: ${beds}` } : { tone: '', text: 'Por asignar' },
      cobro: { tone: 'warn', text: `Por cobrar ${euros(q.total_cents)}` },
      docs: missingCount === null ? { tone: '', text: '—' } : missingCount === 0 ? { tone: 'ok', text: 'Completa' } : { tone: 'warn', text: `Faltan ${missingCount} datos` },
      presencia: { tone: '', text: 'Por llegar' },
    });
  }

  // Huéspedes con cama (o sin ella) en esos eventos
  const guests = live(input.guests).filter((g) => eventIds.has(g.event_id) && !g.preview && !g.portal_role);
  for (const g of guests) {
    const r = reservationOf.get(events.find((e) => e.id === g.event_id)!.reservation_id)!;
    const mine = live(input.assignments).filter((a) => a.guest_id === g.id);
    const span = (a: Row) => [day(a.from_date) ?? day(r.start_date)!, day(a.to_date) ?? day(r.end_date)!] as const;
    // la asignación que importa hoy: la que cubre hoy, la que empieza hoy o la que acabó hoy
    const current = mine.find((a) => { const [f, t] = span(a); return f <= today && today < t; })
      ?? mine.find((a) => span(a)[0] === today) ?? mine.find((a) => span(a)[1] === today) ?? null;
    if (!current && !g.arrived_at) continue;
    // sin asignación (de día): entra hoy y no tiene salida de cama
    const [from, to] = current ? span(current) : [today, ''];
    const left = !!g.left_at; const inside = !!g.arrived_at && !left;
    const charges = live(input.charges).filter((c) => current && c.assignment_id === current.id);
    const owed = charges.filter((c) => !c.paid_at).reduce((s, c) => s + Number(c.amount_cents), 0);
    const paidNotSent = charges.some((c) => c.paid_at && !c.finance_sent_at);
    const noSes = g.ses_status === 'no_aplica' && g.data_status === 'no_aplica';
    const gaps = input.seesGuests && !noSes ? missing(g).length : 0;
    const bed = current ? place(current.bed_id) : null;
    const lanes: LaneKey[] = [];
    if (from === today && !g.arrived_at) lanes.push('entradas');
    if (inside) lanes.push('estancia');
    if ((to === today && !left) || (left && madridDay(g.left_at) === today)) lanes.push('salidas');
    const why: string[] = [];
    if (owed > 0 && (inside || from <= today) && !left) why.push('Cobro pendiente con la cama ocupada');
    if (gaps > 0 && (inside || from === today)) why.push('Datos incompletos');
    if (!bed && !left) why.push('Sin cama');
    if (why.length) lanes.push('excepciones');
    if (!lanes.length) continue;
    cards.push({
      key: `g:${g.id}`, kind: 'guest', eventId: g.event_id, title: input.seesGuests ? ([g.first_name, g.last_name_1].filter(Boolean).join(' ') || 'Huésped') : 'Huésped',
      number: null, requestId: null, guestId: g.id, lanes, why,
      plaza: bed ? { tone: 'ok', text: bed } : { tone: 'alert', text: 'Sin cama' },
      cobro: !charges.length ? { tone: '', text: 'Sin cobro' } : owed > 0 ? { tone: 'warn', text: `Pendiente ${euros(owed)}` } : paidNotSent ? { tone: 'warn', text: 'Cobrado · sin enviar a Finance' } : { tone: 'ok', text: 'Cobrado' },
      docs: noSes ? { tone: 'ok', text: 'Sin pernocta · sin SES' } : !input.seesGuests ? { tone: '', text: '—' } : gaps === 0 ? { tone: 'ok', text: 'Completa' } : { tone: 'warn', text: `Faltan ${gaps} datos` },
      presencia: left ? { tone: '', text: 'Ha salido · limpieza pedida' } : inside ? { tone: 'ok', text: to === today ? 'Dentro · sale hoy' : 'Dentro' } : from === today ? { tone: 'warn', text: 'Llega hoy' } : { tone: 'alert', text: 'Sin llegada marcada' },
    });
  }
  return cards.sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9) || a.title.localeCompare(b.title, 'es'));
}

/** Las fichas de un carril, con el buscador (número o nombre). */
export function laneCards(cards: ReceptionCard[], lane: LaneKey, search = ''): ReceptionCard[] {
  const q = search.trim().toLowerCase();
  return cards.filter((c) => c.lanes.includes(lane) && (!q || String(c.number ?? '').startsWith(q) || c.title.toLowerCase().includes(q)));
}
