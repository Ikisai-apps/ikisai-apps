/**
 * El recorrido del retiro (pasada única, zona 1): fase, etapa, cuenta atrás, «Te toca» de cada tarjeta de Mis retiros,
 * grupos (en marcha, pasados y cancelados) y los pasos del Resumen. Todo se **deriva** de lo leído y nunca se guarda.
 * - Puro y sin navegador, para las pruebas de Node (`tests/organizers/journey.test.ts`): los textos se traducen con el
 *   `t` que se pase (la clave es el español entero, nunca trozos pegados) y el dinero y los días, con `money` y `day`.
 * - «Hoy» es la fecha de Madrid (`todayMadrid`), comparada como texto `AAAA-MM-DD` con las fechas del retiro.
 */
import type { GuestMode } from '../../../../supabase/functions/_domain/booking/mod.ts';
import type { PortalDates, PortalMoney, PortalProposal, PortalRequest, PortalReservation, ReservationDetail, ReservationStatus } from './api.ts';
import { balanceOf } from './quote.ts';
import { designPending, markedDates } from './design-checks.ts';

type Tr = (spanish: string, vars?: Record<string, string | number>) => string;
const plain: Tr = (s, vars) => s.replace(/\{([a-z_]+)\}/gi, (m, k: string) => (vars && k in vars ? String(vars[k]) : m));
/** Marca un texto de tabla que se traduce al pintarlo (como `L` de `i18n.ts`, sin depender del kit). */
const L = (spanish: string): string => spanish;

/** Estados en que el retiro se está diseñando: las fechas aún se pueden proponer (fase 2). */
export const DESIGN_STATUSES: ReadonlySet<string> = new Set(['en_estudio', 'negociacion', 'pre_reservada']);
/** Estados en que el borrador se puede editar desde el portal (Booking B7d; si no, `DRAFT_LOCKED`). */
export const DRAFT_STATUSES: ReadonlySet<string> = new Set(['en_estudio', 'negociacion']);

/** Fecha de hoy en Madrid, `AAAA-MM-DD`. */
export function todayMadrid(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export type StageKey = 'diseno' | 'prerreserva' | 'confirmado' | 'encurso' | 'finalizado';
export type Phase = StageKey | 'cancelado';

/** Etapas del recorrido, en orden; la etiqueta se traduce con `t()` al pintar. */
export const STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'diseno', label: L('Diseño') },
  { key: 'prerreserva', label: L('Prerreserva') },
  { key: 'confirmado', label: L('Confirmado') },
  { key: 'encurso', label: L('En curso') },
  { key: 'finalizado', label: L('Finalizado') },
];

type Dated = { status: ReservationStatus; start_date: string | null; end_date: string | null };

export function phaseOf(r: Dated, today: string): Phase {
  if (r.status === 'cancelada' || r.status === 'perdida') return 'cancelado';
  if (r.end_date && r.end_date < today) return 'finalizado';
  if (r.status === 'cerrada') return 'finalizado';
  if (r.status === 'en_estudio' || r.status === 'negociacion') return 'diseno';
  if (r.status === 'pre_reservada') return 'prerreserva';
  const start = r.start_date;
  const end = r.end_date ?? r.start_date;
  if (r.status === 'en_ejecucion') return 'encurso';
  if (start && end && start <= today && today <= end) return 'encurso';
  return 'confirmado';
}

/** Etapa marcada en el recorrido; parado (`null`) si está cancelado. */
export const stageKeyOf = (r: Dated, today: string): StageKey | null => {
  const phase = phaseOf(r, today);
  return phase === 'cancelado' ? null : phase;
};

const dayNumber = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / 86_400_000;
const daysBetween = (a: string, b: string) => Math.round(dayNumber(b) - dayNumber(a));

/** «Empieza en 12 días», «Empieza hoy», «En curso · día 2 de 3», «Terminó ayer»… */
export function countdownText(start: string | null, end: string | null, today: string, t: Tr = plain): string {
  if (!start) return t('Fechas por concretar');
  const last = end ?? start;
  if (start > today) {
    const n = daysBetween(today, start);
    return n === 1 ? t('Empieza mañana') : t('Empieza en {n} días', { n });
  }
  if (start === today) return t('Empieza hoy');
  if (today <= last) return t('En curso · día {k} de {n}', { k: daysBetween(start, today) + 1, n: daysBetween(start, last) + 1 });
  const ago = daysBetween(last, today);
  return ago === 1 ? t('Terminó ayer') : t('Terminó hace {n} días', { n: ago });
}

/** La cuenta atrás va junto a las fechas cuando ya son firmes y el retiro no ha terminado ni se ha cancelado. */
export const showsCountdown = (phase: Phase): boolean => phase === 'prerreserva' || phase === 'confirmado' || phase === 'encurso';

type Card = Pick<PortalReservation, 'status' | 'start_date' | 'end_date' | 'confirmed' | 'mode' | 'guests' | 'complete' | 'expected_guests'>;

/** «Te toca» de la tarjeta, solo con lo que trae la tarjeta: nunca plazos de Ikisai ni «todo hecho». */
export function toDoOf(card: Card, today: string, t: Tr = plain): string | null {
  const phase = phaseOf(card, today);
  if (phase === 'cancelado') return null; // lo dice el recorrido parado («Cancelado: ya no sigue adelante.»)
  if (phase === 'finalizado') return card.start_date ? countdownText(card.start_date, card.end_date, today, t) : null;
  if (card.status === 'en_estudio') return t('Te toca: diseñar tu retiro');
  if (card.status === 'negociacion') return t('Te toca: revisar el diseño y la propuesta');
  if (card.status === 'pre_reservada') return t('Te toca: revisar la señal en Pagos');
  if (phase === 'encurso') return null;
  if (!card.confirmed || card.mode === 'ninguno') return null;
  if (card.guests === 0) return t('Te toca: añadir a tus asistentes');
  const total = Math.max(card.guests, card.expected_guests ?? 0);
  const left = total - card.complete;
  if (left <= 0) return null;
  return left === 1 ? t('Te toca: completar los datos de 1 asistente') : t('Te toca: completar los datos de {n} asistentes', { n: left });
}

/** Mis retiros: en marcha (por inicio, sin fecha al final), pasados (lo último primero) y cancelados. */
export function groupRetreats<T extends Dated>(items: readonly T[], today: string): { main: T[]; past: T[]; cancelled: T[] } {
  const byStart = (a: T, b: T) => (a.start_date ?? '9999').localeCompare(b.start_date ?? '9999');
  const main: T[] = [], past: T[] = [], cancelled: T[] = [];
  for (const r of items) {
    const phase = phaseOf(r, today);
    if (phase === 'cancelado') cancelled.push(r);
    else if (r.end_date && r.end_date < today) past.push(r);
    else main.push(r);
  }
  return { main: main.sort(byStart), past: past.sort((a, b) => (b.end_date ?? '').localeCompare(a.end_date ?? '')), cancelled: cancelled.sort(byStart) };
}

// --- Pasos del Resumen ---------------------------------------------------------------------------------------------

export type SummaryStepId = 'paso_pagos' | 'ver_solicitudes' | 'ver_fechas' | 'paso_propuesta' | 'ver_diseno' | 'paso_asistentes';
export type SummaryTab = 'pagos' | 'asistentes' | 'fechas' | 'propuesta' | 'diseno';

export interface SummaryStep {
  id: SummaryStepId;
  /** Cuanto más bajo, antes: el primero sin hacer va en grande como «Lo siguiente». */
  prio: number;
  tab: SummaryTab;
  done: boolean;
  title: string;
  stateText: string | null;
  action: string | null;
}

export interface SummaryInput {
  detail: Pick<ReservationDetail, 'status' | 'start_date' | 'end_date' | 'expected_guests' | 'requires_meals' | 'meal_plan' | 'menu_style' | 'contract'>;
  guests: { confirmed: boolean; mode: GuestMode; items: Array<{ missing: string[]; signed: boolean }> };
  dates: PortalDates | null;
  /** Solicitudes para apuntarse aún sin decidir y cuántas personas suman. */
  joins: { requests: number; persons: number };
}

/** Lecturas extra del Resumen: `undefined` = no tocaba leerla; `null` = falló y no hay copia. */
export interface SummaryExtra {
  money?: PortalMoney | null;
  proposals?: PortalProposal[] | null;
  requests?: PortalRequest[] | null;
}

export interface SummaryFormat {
  t?: Tr;
  money: (n: number) => string;
  /** `AAAA-MM-DD` → «12 de marzo». */
  day: (date: string) => string;
  /** Rango de fechas ya escrito («del 12 al 14 de marzo de 2027»). */
  range: (start: string | null, end: string | null) => string;
}

const complete = (g: { missing: string[]; signed: boolean }, mode: string) => g.missing.length === 0 && (mode !== 'ses' || g.signed);

function paymentStep(input: SummaryInput, money: PortalMoney, today: string, f: SummaryFormat, t: Tr): SummaryStep | null {
  const contract = input.detail.contract;
  if (!contract) return null;
  const collected = Number(money.totals.collected) || 0;
  const b = balanceOf(contract, collected);
  if (b.contracted <= 0) return null;
  const base = { id: 'paso_pagos' as const, tab: 'pagos' as const, action: t('Ver pagos') };
  if (b.balance <= 0) return { ...base, prio: 2, done: true, title: t('Todo pagado · {total}', { total: f.money(b.contracted) }), stateText: null, action: null };
  let accumulated = 0;
  for (const d of b.due) {
    accumulated += d.amount;
    if (d.paid) continue;
    const pending = Math.max(0, Math.min(d.amount, Math.round((accumulated - collected) * 100) / 100));
    const importe = f.money(pending);
    const paidNote = collected > 0 ? ` · ${t('pagado {importe}', { importe: f.money(collected) })}` : '';
    if (d.kind === 'senal') {
      // Atrasada solo con la fecha vencida (011-FE); el saldo nunca se marca atrasado.
      if (d.date && d.date < today) {
        return { ...base, prio: 0, done: false, title: t('Pagar la señal ({importe})', { importe }), stateText: t('Atrasado · era antes del {fecha}', { fecha: f.day(d.date) }) + paidNote };
      }
      return {
        ...base, prio: 2, done: false,
        title: d.date ? t('Pagar la señal ({importe}) antes del {fecha}', { importe, fecha: f.day(d.date) }) : t('Pagar la señal ({importe})', { importe }),
        stateText: (d.date ? t('Señal de {importe} antes del {fecha}', { importe, fecha: f.day(d.date) }) : t('Señal de {importe} pendiente', { importe })) + paidNote,
      };
    }
    return { ...base, prio: 2, done: false, title: t('Pagar el saldo ({importe})', { importe }), stateText: t('Saldo de {importe} pendiente', { importe }) + paidNote };
  }
  // Lo contratado no está repartido en vencimientos: lo que queda es saldo.
  const importe = f.money(b.balance);
  return { ...base, prio: 2, done: false, title: t('Pagar el saldo ({importe})', { importe }), stateText: t('Saldo de {importe} pendiente', { importe }) + (collected > 0 ? ` · ${t('pagado {importe}', { importe: f.money(collected) })}` : '') };
}

function proposalStep(proposals: PortalProposal[], requests: PortalRequest[], f: SummaryFormat, t: Tr): SummaryStep | null {
  const accepted = proposals.find((p) => p.status === 'aceptada');
  if (accepted) {
    return { id: 'paso_propuesta', prio: 4, tab: 'propuesta', done: true, title: t('Versión {v} aceptada · {total}', { v: accepted.version, total: f.money(Number(accepted.total) || 0) }), stateText: null, action: null };
  }
  const sent = proposals.find((p) => p.status === 'enviada');
  if (!sent) return null;
  if (requests.some((r) => r.mine && r.kind === 'quiere_confirmar' && r.proposal_id === sent.id)) return null;
  const total = f.money(Number(sent.total) || 0);
  return {
    id: 'paso_propuesta', prio: 4, tab: 'propuesta', done: false, title: t('Revisar la propuesta y decir «Quiero confirmar»'),
    stateText: sent.valid_until
      ? t('Versión {v} · {total} orientativo · válida hasta el {fecha}', { v: sent.version, total, fecha: f.day(sent.valid_until.slice(0, 10)) })
      : t('Versión {v} · {total} orientativo', { v: sent.version, total }),
    action: t('Ver la propuesta'),
  };
}

/**
 * Pasos del Resumen ordenados por prioridad. Se omite el que no aplica o cuya lectura falló. En las fases cancelado y
 * finalizado no hay pasos (el Resumen pinta el fin del recorrido).
 */
export function summarySteps(input: SummaryInput, extra: SummaryExtra, today: string, format: SummaryFormat): SummaryStep[] {
  const t = format.t ?? plain;
  const d = input.detail;
  const phase = phaseOf(d, today);
  if (phase === 'cancelado' || phase === 'finalizado') return [];
  const out: SummaryStep[] = [];

  if (extra.money) {
    const pay = paymentStep(input, extra.money, today, format, t);
    if (pay) out.push(pay);
  }

  if (input.joins.requests > 0) {
    const n = input.joins.requests;
    const persons = input.joins.persons;
    out.push({
      id: 'ver_solicitudes', prio: 1, tab: 'asistentes', done: false,
      title: n === 1 ? t('Decidir 1 solicitud para apuntarse') : t('Decidir {n} solicitudes para apuntarse', { n }),
      stateText: persons === 1 ? t('1 persona pide apuntarse a tu retiro.') : t('{n} personas piden apuntarse a tu retiro.', { n: persons }),
      action: t('Ver solicitudes'),
    });
  }

  if (DESIGN_STATUSES.has(d.status) && input.dates) {
    const fixed = input.dates.mode === 'fixed' && !!input.dates.definitive;
    const marked = markedDates(input.dates);
    out.push({
      id: 'ver_fechas', prio: 3, tab: 'fechas', done: fixed || marked > 0,
      title: input.dates.mode === 'fixed' ? t('Ver fechas') : t('Elegir fechas posibles'),
      stateText: fixed
        ? t('Fecha definitiva: {fechas}', { fechas: format.range(input.dates.definitive!.start, input.dates.definitive!.end) })
        : marked === 0 ? t('Marca las fechas que te vienen bien; Ikisai confirmará la definitiva.')
          : marked === 1 ? t('Has marcado 1 fecha; Ikisai confirmará la definitiva.') : t('Has marcado {n} fechas; Ikisai confirmará la definitiva.', { n: marked }),
      action: input.dates.mode === 'fixed' ? t('Ver fechas') : t('Elegir fechas posibles'),
    });
  }

  if (DRAFT_STATUSES.has(d.status) && extra.proposals && extra.requests) {
    const step = proposalStep(extra.proposals, extra.requests, format, t);
    if (step) out.push(step);
  }

  if (DRAFT_STATUSES.has(d.status)) {
    // La misma regla que «Lo que te falta por rellenar» de Diseño (`design-checks.ts`): no promete la propuesta.
    const pending = designPending(d, input.dates);
    out.push({
      id: 'ver_diseno', prio: 5, tab: 'diseno', done: pending === 0, title: t('Diseña tu retiro'),
      stateText: pending === 0 ? t('Personas, comidas, alojamiento y extras, con el precio orientativo al momento.')
        : pending === 1 ? t('Lo que te falta por rellenar: 1 cosa') : t('Lo que te falta por rellenar: {n} cosas', { n: pending }),
      action: t('Diseñar'),
    });
  }

  const g = input.guests;
  if (g.confirmed && g.mode !== 'ninguno') {
    const done = g.items.filter((x) => complete(x, g.mode)).length;
    const left = g.items.length - done;
    const unsigned = g.mode === 'ses' ? g.items.filter((x) => !x.signed).length : 0;
    out.push({
      id: 'paso_asistentes', prio: 6, tab: 'asistentes', done: g.items.length > 0 && left === 0,
      title: !g.items.length ? t('Añadir a tus asistentes')
        : left === 0 ? t('{hechos} de {total} asistentes con los datos completos', { hechos: done, total: g.items.length })
          : left === 1 ? t('Completar los datos de 1 asistente') : t('Completar los datos de {n} asistentes', { n: left }),
      stateText: g.items.length
        ? `${t('{hechos} de {total} con los datos completos', { hechos: done, total: g.items.length })}${unsigned ? ` · ${t('{n} sin firmar', { n: unsigned })}` : ''}`
        : t('Aún no has añadido a nadie.'),
      action: t('Ver asistentes'),
    });
  }

  return out.map((s, i) => ({ s, i })).sort((a, b) => a.s.prio - b.s.prio || a.i - b.i).map(({ s }) => s);
}
