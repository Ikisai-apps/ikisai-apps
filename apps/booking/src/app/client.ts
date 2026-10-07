import { createSyncClient, type ApiError, type SyncClient, type SyncedRow, type TableName } from '@ikisai/sync-client';
import { STATUS_LABELS, TABLES, type EventType, type ReservationStatus } from '@ikisai/domain-booking';

export const APP = 'booking';
export const RESERVATIONS: TableName = TABLES.reservations;
export const FINANCE: TableName = TABLES.finance;
export const EVENTS: TableName = TABLES.events;
export const GUESTS: TableName = TABLES.guests;
export const SPACES: TableName = TABLES.spaces;
export const BEDS: TableName = TABLES.beds;
export const ASSIGNMENTS: TableName = TABLES.roomAssignments;
export const STAFF: TableName = TABLES.staffAssignments;
export const NEEDS: TableName = TABLES.staffNeeds;
export const RATES: TableName = TABLES.rates;
export const CONDITIONS: TableName = TABLES.conditions;
export const TIERS: TableName = TABLES.cancellationTiers;
export const PROPOSALS: TableName = TABLES.proposals;
export const PROPOSAL_LINES: TableName = TABLES.proposalLines;

/** Fila de reserva tal y como la devuelve el espejo local (`_pending` lo pone el cliente offline). */
export interface ReservationRow extends SyncedRow {
  code: string | null;
  title: string;
  event_type: EventType;
  status: ReservationStatus;
  start_date: string | null;
  end_date: string | null;
  expected_guests: number | null;
  contact_name: string | null;
  contact_phone: string | null;
  briefing_received: boolean;
  archived_at: string | null;
  _pending?: boolean;
}

export interface EventRow extends SyncedRow {
  code: string | null;
  reservation_id: string;
  final_guests: number | null;
  _pending?: boolean;
}

export interface FinanceRow extends SyncedRow {
  deposit_required: number | string | null;
  deposit_paid: number | string | null;
}

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  retiro: 'Retiro',
  convivencia: 'Convivencia',
  formacion: 'Formación',
  encuentro: 'Encuentro',
  actividad_divulgativa: 'Actividad divulgativa',
  alquiler_grupo: 'Alquiler de grupo',
  otro: 'Otro',
};

export function statusLabel(value: unknown): string {
  return typeof value === 'string' && value in STATUS_LABELS ? STATUS_LABELS[value as ReservationStatus] : '—';
}

export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    // Sin `tables`: el espejo guarda las tablas legibles para el rol (un lector no recibe importes ni huéspedes).
    pullIntervalMs: 30_000,
    // Datos personales e importes no se quedan en el dispositivo al cerrar sesión (docs/booking/API.md §5.3).
    clearOnLogout: [GUESTS, FINANCE, RATES, CONDITIONS, TIERS, PROPOSALS, PROPOSAL_LINES],
  });
}

/** ¿Puede leer la tabla el usuario actual? (según el último bootstrap) */
export function canRead(client: SyncClient, table: TableName): boolean {
  return client.bootstrap()?.tables.some((t) => t.table === table && t.readable) ?? false;
}

export function canWrite(client: SyncClient): boolean {
  const role = client.bootstrap()?.membership.role;
  return role === 'editor' || role === 'owner';
}

export const LOCAL_ERROR_MESSAGE = 'No se pudo guardar en este dispositivo. Reintenta; si sigue, cierra y abre la app.';

/** ¿Es un fallo del dispositivo y no de la API? (sin estado HTTP y sin código propio: `sync-client` lo marca `UNKNOWN`). */
export function isLocalError(error: unknown): boolean {
  const e = error as Partial<ApiError> | null;
  if (!e || typeof e !== 'object') return false;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) return true;
  return (e.code === 'UNKNOWN' || e.code === undefined) && (e.status === 0 || e.status === undefined);
}

/** Texto técnico original de un error, para mostrarlo plegado. */
export function technicalDetail(error: unknown): string {
  const e = error as { name?: string; message?: string; code?: string } | null;
  return [e?.name && e.name !== 'Error' ? e.name : null, e?.code && e.code !== 'UNKNOWN' ? e.code : null, e?.message].filter(Boolean).join(' · ') || String(error);
}

/** Mensaje legible en español para un error de la API o de red. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string };
  const code = typeof e?.code === 'string' ? e.code : '';
  switch (code) {
    case 'LOGIN_FAILED':
      return 'Correo o contraseña incorrectos.';
    case 'NETWORK':
      return 'No hay conexión con el servidor.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED':
      return 'La sesión ha caducado. Vuelve a iniciar sesión.';
    case 'FORBIDDEN':
      return 'No tienes permiso para esta operación.';
    case 'LINK_INVALID':
      return 'El enlace no existe o ya se revocó.';
    case 'LINK_EXPIRED':
      return 'El enlace ha caducado. Amplía su fecha o genera otro.';
    case 'NO_MEMBERSHIP':
      return 'Tu cuenta no tiene acceso a Booking.';
    case 'VERSION_CONFLICT':
      return 'Otra persona ha modificado esta fila.';
    case 'BACKEND_UNAVAILABLE':
      return 'El servidor no está disponible ahora mismo.';
    case 'EVENT_REQUIRED':
      return 'Para pasar a ese estado hay que confirmar la reserva (se crea su evento operativo).';
    case 'STATUS_CHANGED':
      return 'Otra persona cambió el estado de la reserva mientras tanto. Revísala antes de confirmar.';
    case 'CONFIRM_REQUIREMENTS':
      return 'Faltan las fechas o el número de personas para poder confirmar.';
    case 'INVALID_TRANSITION':
      return 'Una reserva cancelada, perdida o archivada hay que reabrirla antes de confirmar.';
    case 'PROPOSAL_LOCKED':
      return 'Esta propuesta ya está enviada y no se puede modificar: crea una nueva versión.';
    case 'PROPOSAL_INCOMPLETE': {
      const missing = (e?.details as { missing?: unknown } | null | undefined)?.missing;
      const list = Array.isArray(missing) ? missing : [];
      return list.includes('conditions_id') && list.includes('lines') ? 'Para enviar la propuesta elige unas condiciones y añade al menos una línea.'
        : list.includes('conditions_id') ? 'Para enviar la propuesta elige unas condiciones.' : 'Para enviar la propuesta añade al menos una línea.';
    }
    case 'PROPOSAL_NEGATIVE':
      return 'El total de la propuesta sería negativo: revisa los descuentos.';
    case 'CONDITIONS_IN_USE':
      return 'Estas condiciones ya se usaron en una propuesta enviada: crea unas nuevas.';
    case 'CONSTRAINT_VIOLATION':
      return 'Los datos no cumplen una regla de la reserva (por ejemplo, fechas obligatorias desde la pre-reserva).';
    case 'ORPHAN_CHILD': {
      const table = (e?.details as { table?: unknown } | null | undefined)?.table;
      if (table === TABLES.roomAssignments) return 'No se puede borrar: hay asignaciones de alojamiento vivas que usan este espacio o esta cama. Quítalas primero.';
      if (table === TABLES.staffAssignments || table === TABLES.staffNeeds) return 'No se puede borrar el evento: hay turnos o refuerzos vivos en él. Quítalos primero.';
      if (table === TABLES.beds) return 'No se puede borrar el espacio: quedan camas vivas en él.';
      return 'No se puede borrar: quedan datos vivos que dependen de esto.';
    }
    case 'ORPHAN_EVENT':
    case 'ORPHAN_FINANCE':
      return 'No se puede borrar: quedan datos vivos que dependen de esta reserva.';
    case 'BED_OVERBOOKED':
      return 'Esa cama ya está ocupada esas noches en otra reserva.';
    case 'BED_SPACE_MISMATCH':
      return 'La cama no es de esa habitación.';
    case 'GUEST_MISMATCH':
      return 'El huésped no es de este evento o ya no existe.';
    default:
      // Un fallo del propio dispositivo (almacenamiento local, navegador) llega sin código de la API: el texto del
      // navegador no le dice nada a quien usa la app, así que se da un mensaje claro y el detalle queda aparte.
      if (isLocalError(error)) return LOCAL_ERROR_MESSAGE;
      return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}

/** Fecha local de hoy como AAAA-MM-DD. */
export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const DAY = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** «30 oct» a partir de AAAA-MM-DD; «—» si no hay fecha. */
export function shortDay(date: string | null | undefined): string {
  if (!date) return '—';
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? '—' : DAY.format(ms).replace('.', '');
}

const FULL_DAY = new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/** «2 oct 2026» a partir de AAAA-MM-DD (fecha civil, sin hora); «—» si no hay fecha. */
export function fullDay(date: string | null | undefined): string {
  if (!date) return '—';
  const ms = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? '—' : FULL_DAY.format(ms);
}

export function dateRange(row: Pick<ReservationRow, 'start_date' | 'end_date'>): string {
  if (!row.start_date && !row.end_date) return 'Sin fechas';
  return `${shortDay(row.start_date)} → ${shortDay(row.end_date)}`;
}
