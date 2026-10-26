/**
 * Ikisai Booking · experiencia de cada reserva (tanda 27, MUELA-009, 020 y 067): fase, etapa comercial, recorrido de
 * cinco etapas, preparación por áreas, «Siguiente: …», «Corre prisa» y el orden de «Lo primero».
 *
 * Capa pura: la usan Inicio, Reservas y la ficha, así que las tres dicen lo mismo. Lo que el rol no recibe llega como
 * `null` (no se sabe) y no decide nada: el lector nunca lee «Todo listo», sino «Nada pendiente de lo que puedes ver».
 */
import { dayNumber, depositStatus, type FinanceLike } from './rules.ts';
import { guestModeOf, reservationCompleteness } from './portal.ts';
import type { GuestLike } from './guests.ts';
import type { ReservationStatus } from './catalog.ts';

export type Phase = 'curso' | 'preparacion' | 'comercial' | 'cierre' | 'fuera';
export const PHASES: readonly Phase[] = ['curso', 'preparacion', 'comercial', 'cierre', 'fuera'];
export const PHASE_LABELS: Record<Phase, string> = { curso: 'En curso', preparacion: 'Preparación', comercial: 'Comercial', cierre: 'Cierre', fuera: 'Fuera' };

export type CommercialStage = 'contacto' | 'propuesta' | 'senal' | 'confirmada';
export const COMMERCIAL_STAGES: readonly CommercialStage[] = ['contacto', 'propuesta', 'senal', 'confirmada'];
/** `senal` se llama «Propuesta aceptada» para quien no ve importes. */
export function commercialStageLabel(stage: CommercialStage, seesMoney: boolean): string {
  return { contacto: 'Primer contacto', propuesta: 'Propuesta enviada', senal: seesMoney ? 'Pendiente de señal' : 'Propuesta aceptada', confirmada: 'Confirmada' }[stage];
}

export type JourneyStage = 'captacion' | 'senal' | 'preparacion' | 'estancia' | 'cierre';
export const JOURNEY: readonly JourneyStage[] = ['captacion', 'senal', 'preparacion', 'estancia', 'cierre'];
/** La etapa Señal se llama «Confirmar» para quien no ve importes. */
export function journeyLabel(stage: JourneyStage, seesMoney: boolean): string {
  return { captacion: 'Captación', senal: seesMoney ? 'Señal' : 'Confirmar', preparacion: 'Preparación', estancia: 'Estancia', cierre: 'Cierre' }[stage];
}

/** Bloques de la ficha a los que lleva cada paso (sus ids de hoy). */
export type BlockId = 'blockSummary' | 'blockDates' | 'blockOperation' | 'blockSes' | 'blockLodging' | 'blockStaff' | 'blockPortal' | 'blockOpenRetreat'
  | 'blockProgram' | 'blockChecklist' | 'blockGuests' | 'blockMeals' | 'blockPortalRequests' | 'blockProposal' | 'blockFinance' | 'blockCosts';

export type AreaKey = 'propuesta' | 'senal' | 'huespedes' | 'camas' | 'personal' | 'tareas' | 'ses';
export interface Area { key: AreaKey; ok: boolean; text: string; block: BlockId }

export interface Step { key: string; text: string; block: BlockId | null; tone: 'alert' | 'warn' | null }

export interface ExperienceInput {
  reservation: {
    id: string; status: ReservationStatus; start_date: string | null; end_date: string | null; expected_guests: number | null;
    priority?: string | null; briefing_received?: boolean | null; uses_accommodation?: boolean | null;
    ses_enabled?: boolean | null; collect_guest_data?: boolean | null; event_type?: string | null;
  };
  event?: { id: string; final_guests?: number | null; closed_at?: string | null } | null;
  /** `null`: el rol no ve importes. */
  finance?: FinanceLike | null;
  /** `null`: el rol no lee propuestas. */
  proposals?: ReadonlyArray<{ status: string; version?: number | string | null }> | null;
  /** `null`: el rol no ve huéspedes. */
  guests?: ReadonlyArray<GuestLike & { signed_at?: string | null; deleted_at?: string | null }> | null;
  /** Tareas del checklist del evento; `null` si no se leen. */
  checklist?: ReadonlyArray<{ status: string }> | null;
  /** Refuerzos sin cubrir del evento; `null` si no se leen. */
  uncoveredNeeds?: number | null;
  /** Plazas de cama asignadas en el evento; `null` si no se lee el alojamiento. */
  bedsAssigned?: number | null;
  /** Peticiones del portal sin ver; `null` si no se leen. */
  unseenRequests?: number | null;
  /** ¿Pasó el pago sin comunicación aceptada en SES? `null`: no se sabe. */
  sesPending?: boolean | null;
}

export interface Experience {
  phase: Phase;
  commercial: CommercialStage | null;
  journey: JourneyStage | null;
  /** Días hasta la entrada (negativo si ya empezó); `null` sin fecha. */
  daysLeft: number | null;
  /** Personas con su nombre: «24 personas» o «22 finales · 24 previstas». */
  people: string | null;
  areas: Area[];
  /** Lo siguiente, o `null` si no queda nada de lo que el rol ve. */
  next: Step | null;
  /** Todo lo pendiente, en orden (el Foco de la ficha). */
  steps: Step[];
  /** «Corre prisa», con su motivo («Faltan 2 días · Cubrir 1 refuerzo»), o `null`. */
  rush: string | null;
  /** Peso para ordenar «Lo primero» (mayor, antes). */
  score: number;
}

const COMMERCIAL: readonly ReservationStatus[] = ['en_estudio', 'negociacion', 'pre_reservada'];

export function phaseOf(status: ReservationStatus): Phase {
  if (status === 'en_ejecucion') return 'curso';
  if (status === 'confirmada') return 'preparacion';
  if (COMMERCIAL.includes(status)) return 'comercial';
  if (status === 'cerrada') return 'cierre';
  return 'fuera';
}

/** Etapa del embudo comercial: por las propuestas si se leen; si no, por el estado. */
export function commercialStageOf(status: ReservationStatus, proposals: ExperienceInput['proposals']): CommercialStage | null {
  const phase = phaseOf(status);
  if (phase === 'fuera') return null;
  if (phase !== 'comercial') return 'confirmada';
  if (proposals) {
    if (proposals.some((p) => p.status === 'aceptada')) return 'senal';
    if (proposals.some((p) => p.status === 'enviada')) return 'propuesta';
    return status === 'pre_reservada' ? 'senal' : 'contacto';
  }
  return status === 'en_estudio' ? 'contacto' : status === 'negociacion' ? 'propuesta' : 'senal';
}

export function journeyOf(status: ReservationStatus, proposals: ExperienceInput['proposals']): JourneyStage | null {
  const phase = phaseOf(status);
  if (phase === 'fuera') return null;
  if (phase === 'curso') return 'estancia';
  if (phase === 'cierre') return 'cierre';
  if (phase === 'preparacion') return 'preparacion';
  return commercialStageOf(status, proposals) === 'senal' ? 'senal' : 'captacion';
}

/** «24 personas» si coinciden o solo hay una cifra; «22 finales · 24 previstas» si difieren. */
export function peopleText(expected: number | null | undefined, final: number | null | undefined): string | null {
  const one = (n: number) => `${n} ${n === 1 ? 'persona' : 'personas'}`;
  const e = typeof expected === 'number' ? expected : null;
  const f = typeof final === 'number' ? final : null;
  if (e === null && f === null) return null;
  if (f === null || e === null || e === f) return one((f ?? e)!);
  return `${f} ${f === 1 ? 'final' : 'finales'} · ${e} ${e === 1 ? 'prevista' : 'previstas'}`;
}

/** «Hoy», «Mañana», «Faltan 5 días», «En curso» o «Hace 2 días». */
export function daysText(daysLeft: number | null, phase: Phase): string | null {
  if (phase === 'curso') return 'En curso';
  if (daysLeft === null) return null;
  if (daysLeft === 0) return 'Hoy';
  if (daysLeft === 1) return 'Mañana';
  if (daysLeft > 1) return `Faltan ${daysLeft} días`;
  return daysLeft === -1 ? 'Hace 1 día' : `Hace ${-daysLeft} días`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Experiencia de una reserva en el día `today` (AAAA-MM-DD). */
/** Jornadas abiertas y familiar (0482, VG 26-10-2026): sin propuesta ni señal; se confirman directamente. */
export const withoutDeal = (eventType: string | null | undefined): boolean => eventType === 'jornadas_abiertas' || eventType === 'familiar';

export function experienceOf(input: ExperienceInput, today: string): Experience {
  const r = input.reservation;
  const phase = phaseOf(r.status);
  const deal = !withoutDeal(r.event_type);
  const proposals = deal ? input.proposals ?? null : null;
  const finance = deal ? input.finance : null;
  const now = dayNumber(today);
  const start = dayNumber(r.start_date);
  const end = dayNumber(r.end_date) ?? start;
  const daysLeft = start === null || now === null ? null : start - now;
  const target = input.event?.final_guests ?? r.expected_guests ?? null;
  const live = phase === 'preparacion' || phase === 'curso';
  const areas: Area[] = [];
  const steps: Step[] = [];
  const step = (key: string, text: string, block: BlockId | null, tone: Step['tone'] = null) => steps.push({ key, text, block, tone });

  // Lo que no espera, en cualquier fase viva.
  if (phase !== 'fuera' && input.unseenRequests) step('portal', input.unseenRequests === 1 ? 'Ver la petición del organizador' : `Ver ${input.unseenRequests} peticiones del organizador`, 'blockPortalRequests', 'alert');
  const sesOn = r.ses_enabled !== false;
  if (sesOn && input.sesPending === true && phase !== 'fuera') step('ses', 'Comunicar la reserva a SES', 'blockSes', 'alert');

  if (phase === 'comercial') {
    if (!r.start_date || !r.end_date) step('fechas', 'Fijar las fechas', 'blockDates');
    if (r.expected_guests === null || r.expected_guests === undefined) step('personas', 'Indicar las personas previstas', 'blockSummary');
    if (proposals) {
      const accepted = proposals.some((p) => p.status === 'aceptada');
      const sent = proposals.some((p) => p.status === 'enviada');
      const draft = proposals.filter((p) => p.status === 'borrador').sort((a, b) => Number(b.version) - Number(a.version))[0];
      if (!accepted && !sent) step('propuesta', draft ? `Enviar la propuesta v${draft.version}` : 'Preparar la propuesta', 'blockProposal');
      else if (!accepted) step('propuesta', 'Seguir la propuesta enviada', 'blockProposal');
    }
    const deposit = finance === undefined || finance === null ? null : depositStatus(finance);
    if (deposit === 'pendiente' || deposit === 'parcial') {
      if (proposals?.some((p) => p.status === 'aceptada') || r.status === 'pre_reservada') step('senal', deposit === 'parcial' ? 'Cobrar el resto de la señal' : 'Cobrar la señal', 'blockFinance');
    }
    if (r.start_date && r.end_date && r.expected_guests !== null && r.expected_guests !== undefined) step('confirmar', 'Confirmar la reserva', null);
  }

  if (live) {
    if (proposals) areas.push(proposals.some((p) => p.status === 'aceptada')
      ? { key: 'propuesta', ok: true, text: 'Propuesta', block: 'blockProposal' }
      : { key: 'propuesta', ok: false, text: 'Propuesta sin aceptar', block: 'blockProposal' });
    if (finance) {
      const d = depositStatus(finance);
      const ok = d === 'no_aplica' || d === 'completado';
      areas.push({ key: 'senal', ok, text: ok ? 'Señal' : d === 'parcial' ? 'Señal parcial' : 'Señal pendiente', block: 'blockFinance' });
      if (!ok) step('senal', d === 'parcial' ? 'Cobrar el resto de la señal' : 'Cobrar la señal', 'blockFinance', daysLeft !== null && daysLeft <= 7 ? 'alert' : null);
    }
    const soon = daysLeft !== null && daysLeft <= 30;
    if (phase === 'preparacion' && soon && (input.event?.final_guests ?? null) === null) step('finales', 'Pedir el número final de personas', 'blockOperation');
    if (phase === 'preparacion' && soon && r.briefing_received === false) step('briefing', 'Pedir el briefing final', 'blockSummary');
    const mode = guestModeOf(r);
    if (input.guests && mode !== 'ninguno') {
      const c = reservationCompleteness(input.guests, mode);
      const want = target ?? c.total;
      const ok = want > 0 ? c.complete >= want : c.total > 0 && c.complete === c.total;
      areas.push({ key: 'huespedes', ok, text: `Huéspedes · ${c.complete}/${want}`, block: 'blockGuests' });
      if (!ok) step('huespedes', want > c.complete ? `Completar ${plural(want - c.complete, 'huésped', 'huéspedes')}` : 'Completar los huéspedes', 'blockGuests');
    }
    if (r.uses_accommodation !== false && typeof input.bedsAssigned === 'number' && target !== null) {
      const ok = input.bedsAssigned >= target;
      areas.push({ key: 'camas', ok, text: `Camas · ${Math.min(input.bedsAssigned, target)}/${target}`, block: 'blockLodging' });
      if (!ok) step('camas', `Asignar ${plural(target - input.bedsAssigned, 'cama', 'camas')}`, 'blockLodging');
    }
    if (typeof input.uncoveredNeeds === 'number') {
      const ok = input.uncoveredNeeds === 0;
      areas.push({ key: 'personal', ok, text: ok ? 'Personal' : `Personal · ${plural(input.uncoveredNeeds, 'refuerzo', 'refuerzos')}`, block: 'blockStaff' });
      if (!ok) step('personal', `Cubrir ${plural(input.uncoveredNeeds, 'refuerzo', 'refuerzos')}`, 'blockStaff', daysLeft !== null && daysLeft <= 7 ? 'warn' : null);
    }
    if (input.checklist && input.checklist.length > 0) {
      const done = input.checklist.filter((t) => t.status !== 'pendiente').length;
      const ok = done === input.checklist.length;
      areas.push({ key: 'tareas', ok, text: `Tareas · ${done}/${input.checklist.length}`, block: 'blockChecklist' });
      if (!ok) step('tareas', `Terminar ${plural(input.checklist.length - done, 'tarea', 'tareas')}`, 'blockChecklist');
    }
    if (sesOn && typeof input.sesPending === 'boolean') areas.push({ key: 'ses', ok: !input.sesPending, text: input.sesPending ? 'SES sin comunicar' : 'SES', block: 'blockSes' });
    if (phase === 'curso' && end !== null && now !== null && end <= now) step('cierre', 'Anotar el cierre operativo', 'blockOperation');
  }

  if (phase === 'cierre' && input.event && !input.event.closed_at) step('cierre', 'Anotar el cierre operativo', 'blockOperation');

  const next = steps[0] ?? null;
  const when = daysText(daysLeft, phase);
  const urgent = next !== null && (next.tone === 'alert'
    || (live && daysLeft !== null && daysLeft <= 7)
    || (r.status === 'pre_reservada' && daysLeft !== null && daysLeft <= 14));
  const rush = urgent ? [when, next!.text].filter(Boolean).join(' · ') : null;

  let score = 0;
  if (steps.some((s) => s.key === 'ses')) score += 1000;
  if (steps.some((s) => s.key === 'portal')) score += 500;
  if (rush) score += 300;
  if (next) score += 100;
  score += r.priority === 'alta' ? 50 : r.priority === 'media' ? 20 : 0;
  if (daysLeft !== null && phase !== 'fuera' && phase !== 'cierre') score += Math.max(0, 60 - Math.max(daysLeft, 0));

  return {
    phase, commercial: commercialStageOf(r.status, proposals), journey: journeyOf(r.status, proposals), daysLeft,
    people: peopleText(r.expected_guests, input.event?.final_guests ?? null), areas, next, steps, rush, score,
  };
}

/** «Siguiente: …» en palabras; sin pasos, lo dice según lo que ve el rol. */
export function nextText(x: Pick<Experience, 'next' | 'phase'>, seesAll: boolean): string {
  if (x.next) return `Siguiente: ${x.next.text}`;
  if (x.phase === 'fuera') return 'Sin pasos pendientes';
  return seesAll ? 'Todo listo' : 'Nada pendiente de lo que puedes ver';
}

/** Búsqueda sin tildes ni mayúsculas. */
export function foldText(value: string | null | undefined): string {
  return (value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}
