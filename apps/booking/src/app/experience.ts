/**
 * La experiencia de todas las reservas, leída del espejo local una vez por pintado (Inicio, Reservas y la ficha dicen
 * lo mismo porque usan la misma capa pura, `experienceOf`). Lo que el rol no lee llega como `null` y no decide.
 */
import type { SyncClient, SyncedRow } from '@ikisai/sync-client';
import { TABLES, canSeeGuests, dayNumber, experienceOf, type BlockId, type Experience, type ExperienceInput, type Phase } from '@ikisai/domain-booking';
import { ASSIGNMENTS, EVENTS, FINANCE, GUESTS, NEEDS, PORTAL_REQUESTS, PROPOSALS, RESERVATIONS, canRead, canWrite, today, type EventRow, type FinanceRow, type ReservationRow } from './client.ts';
import { COMMUNICABLE_STATUSES, HOUR, acceptedReservationComm, fetchSes, fetchSesOverview } from './ses.ts';

type Row = SyncedRow & Record<string, any>;

export interface ReservationView {
  reservation: ReservationRow & Row;
  event: (EventRow & Row) | null;
  finance: (FinanceRow & Row) | null;
  x: Experience;
}

export interface ExperienceSet {
  views: ReservationView[];
  byId: Map<string, ReservationView>;
  /** Ve importes. */
  seesMoney: boolean;
  /** Ve importes, huéspedes y escribe: puede decir «Todo listo». */
  seesAll: boolean;
  writable: boolean;
}

/** Color de cada fase (tokens del kit, los mismos que los chips de estado). */
export const PHASE_COLORS: Record<Phase, string> = { curso: '#2f7d5b', preparacion: '#3a6ea5', comercial: '#b7791f', cierre: '#6b7280', fuera: '#9ca3af' };

// --- SES: reservas con pago registrado hace más de 12 h y sin comunicación aceptada (plazo legal de 24 h).
const SES_WATCHED = COMMUNICABLE_STATUSES.filter((status) => status !== 'cerrada');
const SES_NOTICE_AFTER_MS = 12 * HOUR;
const SES_MAX_CHECKS = 20;
let sesPending = new Set<string>();
let sesKey = '';
let sesAt = 0;
const sesListeners = new Set<() => void>();

export function onSesPending(fn: () => void): () => void { sesListeners.add(fn); return () => sesListeners.delete(fn); }
/** Cada pantalla que se monta vuelve a preguntar (el freno de 60 s es para los repintados de una misma pantalla). */
export function resetSesWatch(): void { sesKey = ''; sesAt = 0; }

/** Candidatas por el espejo; con red, B2 en una llamada (y, si alguna no viene en B2, su consulta, hasta 20). Si algo falla, se calla. */
export function sesCandidates(client: SyncClient, reservations: ReservationRow[], finance: Map<string, FinanceRow> | null): string[] {
  if (!canWrite(client) || !finance) return [];
  const candidates = reservations.filter((r) => !r.deleted_at && r.ses_enabled !== false && SES_WATCHED.includes(r.status))
    .map((r) => ({ id: r.id, at: Date.parse(String(finance.get(r.id)?.payment_registered_at ?? '')) }))
    .filter((c) => Number.isFinite(c.at) && Date.now() - c.at > SES_NOTICE_AFTER_MS)
    .sort((a, b) => a.at - b.at).slice(0, SES_MAX_CHECKS).map((c) => c.id);
  const key = candidates.join(',');
  if (navigator.onLine && candidates.length > 0 && (key !== sesKey || Date.now() - sesAt > 60_000)) {
    sesKey = key;
    sesAt = Date.now();
    void (async () => {
      // Solo cambian las consultadas: lo que se sabía de las demás se conserva.
      const next = new Set([...sesPending].filter((id) => !candidates.includes(id)));
      let overview: Awaited<ReturnType<typeof fetchSesOverview>> | null = null;
      try { overview = await fetchSesOverview(client); } catch { overview = null; }
      const seen = new Map((overview?.items ?? []).map((item) => [item.reservation.id, item]));
      const rest = candidates.filter((id) => !seen.has(id));
      for (const id of candidates) {
        const item = seen.get(id);
        if (item && acceptedReservationComm(item.communications ?? []) === null) next.add(id);
      }
      const results = await Promise.allSettled(rest.map(async (id) => ({ id, accepted: acceptedReservationComm(await fetchSes(client, id)) !== null })));
      for (const r of results) if (r.status === 'fulfilled' && !r.value.accepted) next.add(r.value.id);
      const changed = next.size !== sesPending.size || [...next].some((id) => !sesPending.has(id));
      sesPending = next;
      if (changed) sesListeners.forEach((fn) => fn());
    })();
  }
  return candidates.filter((id) => sesPending.has(id));
}

/** Lee lo necesario del espejo y calcula la experiencia de cada reserva viva (sin las de la papelera). */
export async function loadExperiences(client: SyncClient, options: { includeArchived?: boolean } = {}): Promise<ExperienceSet> {
  const boot = client.bootstrap();
  const writable = canWrite(client);
  const seesMoney = canRead(client, FINANCE);
  const seesGuests = boot ? canSeeGuests(boot.membership) && canRead(client, GUESTS) : false;
  const list = async (table: Parameters<SyncClient['list']>[0]) => (canRead(client, table) ? ((await client.list(table)) as Row[]).filter((r) => r.deleted_at === null) : null);
  const reservations = ((await client.list(RESERVATIONS)) as Array<ReservationRow & Row>).filter((r) => r.deleted_at === null && (options.includeArchived || !r.archived_at));
  const events = ((await client.list(EVENTS)) as Array<EventRow & Row>).filter((e) => e.deleted_at === null);
  const eventOf = new Map(events.map((e) => [e.reservation_id, e]));
  const finance = seesMoney ? new Map(((await client.list(FINANCE)) as Array<FinanceRow & Row>).map((f) => [f.id, f])) : null;
  const proposals = writable ? await list(PROPOSALS) : null;
  const guests = seesGuests ? (await list(GUESTS))?.filter((g) => !g.preview) ?? null : null;
  const checklist = await list(TABLES.checklist);
  const needs = await list(NEEDS);
  const assignments = await list(ASSIGNMENTS);
  const requests = writable ? await list(PORTAL_REQUESTS) : null;
  const group = <T extends Row>(rows: T[] | null, key: string) => {
    const map = new Map<string, T[]>();
    for (const row of rows ?? []) { const k = String(row[key]); map.set(k, [...(map.get(k) ?? []), row]); }
    return map;
  };
  const proposalsOf = group(proposals, 'reservation_id');
  const guestsOf = group(guests, 'event_id');
  const checklistOf = group(checklist, 'event_id');
  const needsOf = group(needs?.filter((n) => n.status !== 'cubierto') ?? null, 'event_id');
  const bedsOf = group(assignments, 'event_id');
  const requestsOf = group(requests?.filter((p) => p.status === 'enviada') ?? null, 'reservation_id');
  const ses = new Set(sesCandidates(client, reservations, finance));
  const day = today();

  const views = reservations.map((reservation): ReservationView => {
    const event = eventOf.get(reservation.id) ?? null;
    const f = finance?.get(reservation.id) ?? null;
    const x = experienceOf({
      reservation, event,
      finance: seesMoney ? (f ?? { deposit_required: null, deposit_paid: null }) : null,
      proposals: proposals ? (proposalsOf.get(reservation.id) ?? []) as unknown as ExperienceInput['proposals'] : null,
      guests: guests && event ? guestsOf.get(event.id) ?? [] : null,
      checklist: checklist && event ? (checklistOf.get(event.id) ?? []) as unknown as ExperienceInput['checklist'] : null,
      uncoveredNeeds: needs && event ? (needsOf.get(event.id) ?? []).length : null,
      bedsAssigned: assignments && event ? (bedsOf.get(event.id) ?? []).reduce((sum, a) => sum + Number(a.persons || 0), 0) : null,
      unseenRequests: requests ? (requestsOf.get(reservation.id) ?? []).length : null,
      sesPending: writable && seesMoney ? ses.has(reservation.id) : null,
    }, day);
    return { reservation, event, finance: f, x };
  });
  return { views, byId: new Map(views.map((v) => [v.reservation.id, v])), seesMoney, seesAll: writable && seesMoney && seesGuests, writable };
}

/** ¿Empieza en los próximos `days` días (o ya)? */
export function startsWithin(view: ReservationView, days: number): boolean {
  const left = view.x.daysLeft;
  return left !== null && left >= 0 && left <= days;
}

/** ¿Está en casa hoy? */
export function inHouse(view: ReservationView): boolean {
  if (view.x.phase === 'curso') return true;
  const now = dayNumber(today())!;
  const start = dayNumber(view.reservation.start_date);
  const end = dayNumber(view.reservation.end_date) ?? start;
  return view.reservation.status === 'confirmada' && start !== null && end !== null && start <= now && now < end;
}

// «Siguiente» de Inicio o de Reservas abre la ficha en el bloque de ese paso.
let requested: { id: string; block: BlockId } | null = null;
export function requestBlock(id: string, block: BlockId | null): void { requested = block ? { id, block } : null; }
export function takeRequestedBlock(id: string): BlockId | null {
  const out = requested && requested.id === id ? requested.block : null;
  requested = null;
  return out;
}
