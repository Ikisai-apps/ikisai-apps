/**
 * SES.HOSPEDAJES (API §17.2, §17.4): reglas de plazo, de cambios y de la bandeja, sin DOM ni red. Las usan la ficha, Inicio,
 * Huéspedes y la bandeja #/ses (tanda 27, MUELA-067 §4 y MUELA-038). Antes vivían en `apps/booking/src/app/ses.ts`, que las reexporta.
 */

export type SesStatus = 'preparada' | 'enviando' | 'en_proceso' | 'aceptada' | 'rechazada' | 'anulada' | 'error';

export interface SesCommunication {
  id: string;
  kind: 'RH' | 'PV' | 'anulacion';
  status: SesStatus;
  environment: 'pre' | 'prod' | string;
  cancels_id: string | null;
  /** Solo en los partes de viajeros (`kind: 'PV'`): huéspedes que incluye. */
  guest_ids?: string[] | null;
  /** En la lectura de varias reservas (B2): cuántos huéspedes lleva el parte, sin sus ids. */
  guests?: number | null;
  lot_id: string | null;
  ses_code: string | null;
  error_code: string | null;
  error_text: string | null;
  legal_start_at: string | null;
  snapshot: { start_date?: string | null; end_date?: string | null; persons?: number | string | null } | null;
  attempts: number | null;
  sent_at: string | null;
  accepted_at: string | null;
  cancelled_at: string | null;
  created_at: string | null;
}

/** Estados en que una comunicación de reserva sigue «viva»: impide crear otra. */
export const LIVE_STATUSES: readonly SesStatus[] = ['preparada', 'enviando', 'en_proceso', 'aceptada', 'error'];
/** Reservas que se pueden comunicar (el servidor responde `SES_NOT_CONFIRMED` con cualquier otro estado). */
export const COMMUNICABLE_STATUSES: readonly string[] = ['confirmada', 'en_ejecucion', 'cerrada'];

export const HOUR = 3_600_000;

/** Comunicaciones de reserva (RH), la más reciente primero (el orden de entrada ya lo es). */
export const reservationComms = (items: SesCommunication[]): SesCommunication[] => items.filter((c) => c.kind === 'RH');
export const liveReservationComm = (items: SesCommunication[]): SesCommunication | null => reservationComms(items).find((c) => LIVE_STATUSES.includes(c.status)) ?? null;
export const acceptedReservationComm = (items: SesCommunication[]): SesCommunication | null => reservationComms(items).find((c) => c.status === 'aceptada') ?? null;
/** Anulación en curso (aún no resuelta) de una comunicación. */
export const pendingCancellation = (items: SesCommunication[], id: string): SesCommunication | null =>
  items.find((c) => c.kind === 'anulacion' && c.cancels_id === id && ['preparada', 'enviando', 'en_proceso', 'error'].includes(c.status)) ?? null;

export type DeadlineLevel = 'ok' | 'warn' | 'alert' | 'expired';

/** Plazo legal de 24 h: aviso a las 12 h, alerta a las 18 h y vencido a las 24 h desde `startIso`. */
export function deadlineLevel(startIso: string | null | undefined, now = Date.now()): DeadlineLevel | null {
  const start = startIso ? Date.parse(startIso) : NaN;
  if (Number.isNaN(start)) return null;
  const hours = (now - start) / HOUR;
  return hours >= 24 ? 'expired' : hours >= 18 ? 'alert' : hours >= 12 ? 'warn' : 'ok';
}

export const DEADLINE_TEXT: Record<Exclude<DeadlineLevel, 'ok'>, string> = {
  warn: 'Quedan menos de 12 h para comunicar la reserva',
  alert: 'Quedan menos de 6 h para comunicar la reserva',
  expired: 'Plazo legal vencido',
};

export interface Deadline {
  /** Momento en que vence (24 h después del inicio), en ISO. */
  dueAt: string;
  level: DeadlineLevel;
  /** Milisegundos que quedan; negativo si ya venció. */
  msLeft: number;
}

/** «Plazo con hora» (MUELA-038): cuándo vence y cuánto queda, con los mismos umbrales que `deadlineLevel`. */
export function deadlineOf(startIso: string | null | undefined, now = Date.now()): Deadline | null {
  const level = deadlineLevel(startIso, now);
  if (!level) return null;
  const due = Date.parse(startIso!) + 24 * HOUR;
  return { dueAt: new Date(due).toISOString(), level, msLeft: due - now };
}

const dayOf = (value: string): number => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);

/** ¿Es la fecha de pago anterior en más de un día al momento en que se registró? (el plazo legal cuenta desde el registro). */
export function paymentDateIsOld(paymentDate: unknown, registeredAt: unknown): boolean {
  if (typeof paymentDate !== 'string' || !paymentDate || typeof registeredAt !== 'string' || !registeredAt) return false;
  const diff = (dayOf(registeredAt) - dayOf(paymentDate)) / (24 * HOUR);
  return Number.isFinite(diff) && diff > 1;
}

export interface ReservationShape { status: string; start_date: string | null; end_date: string | null; expected_guests: number | null }

/** ¿Cambió la reserva desde que se comunicó? Cancelada o perdida, o fechas o personas distintas de las de la comunicación aceptada. */
export function changedSinceCommunicated(reservation: ReservationShape, finalGuests: number | null | undefined, accepted: SesCommunication): boolean {
  if (['cancelada', 'perdida'].includes(reservation.status)) return true;
  const snap = accepted.snapshot;
  if (!snap) return false;
  const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
  const persons = finalGuests ?? reservation.expected_guests;
  const snapPersons = snap.persons === undefined || snap.persons === null ? null : Number(snap.persons);
  return !same(snap.start_date?.slice(0, 10), reservation.start_date?.slice(0, 10)) || !same(snap.end_date?.slice(0, 10), reservation.end_date?.slice(0, 10))
    || !same(snapPersons, persons === null || persons === undefined ? null : Number(persons));
}

/** Partes de viajeros (PV) de la reserva, el más reciente primero. Los anulados no cuentan. */
export const guestReports = (items: SesCommunication[]): SesCommunication[] => items.filter((c) => c.kind === 'PV' && c.status !== 'anulada');
export const PV_IN_PROCESS: readonly SesStatus[] = ['preparada', 'enviando', 'en_proceso', 'error'];

// ---------------------------------------------------------------------------------------------------------------------
// Un rechazo lleva al dato que hay que corregir (SES_ERROR_FIELD, MUELA-038)
// ---------------------------------------------------------------------------------------------------------------------

/** Dónde se corrige: la ficha (con su pestaña y su campo), Huéspedes o los ajustes del servicio. */
export interface SesErrorTarget {
  where: 'reserva' | 'cobro' | 'huespedes' | 'ajustes';
  /** Campo de la app, si se sabe (para enfocarlo). */
  field: string | null;
  /** Texto de la acción: «Corregir el tipo de pago en la ficha». */
  label: string;
}

/**
 * Códigos que pone Booking al preparar o enviar (`DATA_<campo>` de `SesDataError`, `AUTH`, `NOT_CONFIGURED`). Los códigos
 * propios de SES (`SES_*`, `LOTE_*`) no se interpretan sin la tabla oficial: llevan a «Revisar la reserva».
 */
export const SES_ERROR_FIELD: Record<string, SesErrorTarget> = {
  DATA_tipoPago: { where: 'cobro', field: 'payment_type', label: 'Corregir el tipo de pago en la ficha' },
  DATA_fechas: { where: 'reserva', field: 'start_date', label: 'Corregir las fechas en la ficha' },
  DATA_numPersonas: { where: 'reserva', field: 'final_guests', label: 'Corregir el número de personas en la ficha' },
  DATA_titular: { where: 'reserva', field: 'contact_name', label: 'Corregir el contacto en la ficha' },
  DATA_persona: { where: 'huespedes', field: null, label: 'Corregir en Huéspedes' },
  DATA_fechaNacimiento: { where: 'huespedes', field: 'birth_date', label: 'Corregir la fecha de nacimiento en Huéspedes' },
  DATA_pais: { where: 'huespedes', field: 'residence_country', label: 'Corregir el país en Huéspedes' },
  AUTH: { where: 'ajustes', field: null, label: 'Revisar las credenciales del servicio' },
  NOT_CONFIGURED: { where: 'ajustes', field: null, label: 'Faltan las credenciales del servicio' },
};

const REVIEW: SesErrorTarget = { where: 'reserva', field: null, label: 'Revisar la reserva' };

/** A dónde lleva un rechazo. Un dato que falta (`DATA_<otro>`) es del titular en una reserva y del huésped en un parte. */
export function sesErrorTarget(code: string | null | undefined, kind: SesCommunication['kind'] = 'RH'): SesErrorTarget {
  if (!code) return REVIEW;
  const known = SES_ERROR_FIELD[code];
  if (known) return known;
  if (code.startsWith('DATA_')) return kind === 'PV' ? SES_ERROR_FIELD.DATA_persona! : SES_ERROR_FIELD.DATA_titular!;
  return REVIEW;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bandeja por áreas (B2, MUELA-067 §4, con las áreas añadidas que pidió la revisión)
// ---------------------------------------------------------------------------------------------------------------------

/** Recuentos de huéspedes de la lectura B2 (sin nombres); `null` si quien lee no puede ver huéspedes. */
export interface SesGuestCounts { total: number; incomplete: number; unsigned: number; ready: number; arrived: number; pending_report: number }

export interface SesOverviewItem {
  reservation: ReservationShape & {
    id: string; code: string | null; title: string | null; final_guests: number | null; event_id: string | null; archived_at: string | null;
    ses_enabled: boolean; ses_disabled_reason: string | null; ses_disabled_note: string | null; collect_guest_data?: boolean | null;
  };
  payment: { registered_at: string | null; date: string | null } | null;
  communications: SesCommunication[];
  guests: SesGuestCounts | null;
}

export interface SesOverviewData {
  generated_at?: string | null;
  settings: { environment: string; paused: boolean } | null;
  items: SesOverviewItem[];
}

/**
 * Áreas de la bandeja, en el orden en que se enseñan. Las de la revisión (Sevilla, 19-10) se suman a las de La Muela:
 * `reintentando`, `retenidas`, `cambio`, `anulacion` y `partes`.
 */
export const SES_AREAS = ['corregir', 'cambio', 'listas', 'retenidas', 'reintentando', 'partes', 'antes_de_llegar', 'en_proceso', 'anulacion', 'esperando_pago', 'comunicadas', 'sin_ses'] as const;
export type SesArea = typeof SES_AREAS[number];

/** Áreas que cuentan como «cosas por resolver» en el veredicto. La pausa no para el plazo: las retenidas cuentan. */
export const SES_PROBLEM_AREAS: readonly SesArea[] = ['corregir', 'cambio', 'listas', 'retenidas', 'reintentando', 'partes', 'antes_de_llegar'];

export type SesAction = 'comunicar' | 'anular' | 'corregir' | 'huespedes' | 'abrir';

export interface SesRow {
  item: SesOverviewItem;
  area: SesArea;
  /** Acción de un toque. La bandeja la enseña solo a editor y owner. */
  action: SesAction;
  /** Plazo legal, si corre (listas, retenidas, reintentando, corregir). */
  deadline: Deadline | null;
  /** Si es un rechazo o un error, a dónde lleva. */
  target: SesErrorTarget | null;
  /** La comunicación que decide el área (la viva, la aceptada o la rechazada), si hay. */
  communication: SesCommunication | null;
  /** Fecha de pago anterior en más de un día a su registro (aviso «pago antiguo»). */
  oldPayment: boolean;
}

const HELD = new Set(['PAUSED', 'NOT_CONFIGURED']);
const todayIso = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Clasifica una reserva de la lectura B2 en su área. `null` si no pinta nada en la bandeja (cancelada sin nada que anular). */
export function sesRowOf(item: SesOverviewItem, now = Date.now()): SesRow | null {
  const r = item.reservation;
  const comms = item.communications ?? [];
  const rh = reservationComms(comms);
  const accepted = acceptedReservationComm(comms);
  const live = liveReservationComm(comms);
  const latest = rh[0] ?? null;
  const registeredAt = item.payment?.registered_at ?? null;
  const legalStart = latest && latest.status !== 'anulada' ? latest.legal_start_at ?? registeredAt : registeredAt;
  const oldPayment = paymentDateIsOld(item.payment?.date, registeredAt);
  const row = (area: SesArea, action: SesAction, extra: Partial<SesRow> = {}): SesRow =>
    ({ item, area, action, deadline: null, target: null, communication: null, oldPayment, ...extra });
  const timed = (area: SesArea, action: SesAction, extra: Partial<SesRow> = {}) => row(area, action, { deadline: deadlineOf(legalStart, now), ...extra });

  if (accepted) {
    const cancelling = pendingCancellation(comms, accepted.id);
    if (cancelling) return row('anulacion', 'abrir', { communication: cancelling, target: cancelling.status === 'error' ? sesErrorTarget(cancelling.error_code, 'anulacion') : null });
    if (!r.ses_enabled || changedSinceCommunicated(r, r.final_guests, accepted)) return row('cambio', 'anular', { communication: accepted });
    const reports = guestReports(comms);
    const rejectedReport = reports.find((c) => c.status === 'rechazada');
    if (rejectedReport) return row('partes', 'huespedes', { communication: rejectedReport, target: sesErrorTarget(rejectedReport.error_code, 'PV') });
    if ((item.guests?.pending_report ?? 0) > 0) return row('partes', 'huespedes', { communication: accepted });
    const reportInProcess = reports.find((c) => PV_IN_PROCESS.includes(c.status));
    if (reportInProcess) return row('en_proceso', 'abrir', { communication: reportInProcess });
    const g = item.guests;
    if (g && r.start_date && r.start_date.slice(0, 10) >= todayIso(now) && (g.incomplete > 0 || g.unsigned > 0)) return row('antes_de_llegar', 'huespedes', { communication: accepted });
    return row('comunicadas', 'abrir', { communication: accepted });
  }
  if (['cancelada', 'perdida'].includes(r.status)) return null;
  if (!r.ses_enabled) return row('sin_ses', 'abrir');
  if (live) {
    if (live.status === 'error') return timed('reintentando', 'abrir', { communication: live, target: sesErrorTarget(live.error_code, 'RH') });
    if (live.status === 'preparada' && live.error_code && HELD.has(live.error_code)) return timed('retenidas', 'abrir', { communication: live, target: sesErrorTarget(live.error_code, 'RH') });
    return row('en_proceso', 'abrir', { communication: live });
  }
  if (!COMMUNICABLE_STATUSES.includes(r.status)) return null;
  if (latest?.status === 'rechazada') return timed('corregir', 'corregir', { communication: latest, target: sesErrorTarget(latest.error_code, 'RH') });
  if (!registeredAt) return row('esperando_pago', 'abrir');
  return timed('listas', 'comunicar');
}

export interface SesOverview {
  rows: SesRow[];
  byArea: Record<SesArea, SesRow[]>;
  /** Cosas por resolver (veredicto) y la primera: la que vence antes; sin plazo, la que empieza antes. */
  problems: number;
  first: SesRow | null;
  settings: SesOverviewData['settings'];
}

const startOf = (row: SesRow) => row.item.reservation.start_date ?? '9999-12-31';
const byUrgency = (a: SesRow, b: SesRow) => {
  const da = a.deadline ? Date.parse(a.deadline.dueAt) : Infinity;
  const db = b.deadline ? Date.parse(b.deadline.dueAt) : Infinity;
  return da !== db ? da - db : startOf(a).localeCompare(startOf(b));
};

/** La bandeja entera: filas por área, ordenadas por urgencia, y el veredicto («n cosas por resolver · la primera…» o «Todo en regla»). */
export function sesOverview(data: SesOverviewData, now = Date.now()): SesOverview {
  const rows = (data.items ?? []).map((item) => sesRowOf(item, now)).filter((row): row is SesRow => row !== null);
  const byArea = Object.fromEntries(SES_AREAS.map((area) => [area, rows.filter((row) => row.area === area).sort(byUrgency)])) as Record<SesArea, SesRow[]>;
  const pending = rows.filter((row) => SES_PROBLEM_AREAS.includes(row.area)).sort(byUrgency);
  return { rows, byArea, problems: pending.length, first: pending[0] ?? null, settings: data.settings ?? null };
}
