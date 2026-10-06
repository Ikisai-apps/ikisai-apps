/**
 * Ikisai Booking · validación compartida entre la Edge (`beforeCommit`) y el frontend (docs/booking/API.md §4.1).
 * Es pura: no conoce `_kit` ni el navegador. Los campos desconocidos no se juzgan aquí; los rechaza el núcleo.
 */
import {
  CUSTOMER_TYPES, EVENT_TYPES, MEAL_PLANS, MENU_STYLES, PAYMENT_TYPES, PRIORITIES, PROCEDURES, RESERVATION_STATUSES,
  SETUP_STYLES, TABLES, TASK_STATUSES_F, TASK_STATUSES_M, TECHNICAL_NEEDS, TRAVELER_REGISTRATION_STATUSES,
} from './catalog.ts';
import { dayNumber, isValidDate } from './rules.ts';

export type Role = 'reader' | 'editor' | 'owner';

export interface Issue {
  status: 403 | 422;
  code: 'INVALID_FIELDS' | 'INVALID_OPERATION' | 'FORBIDDEN';
  message: string;
  details: Record<string, unknown>;
}

/** Forma mínima de una operación de `core.commit` (igual que `Operation` de `_kit` y `RowOperation` de `sync-client`). */
export interface OperationLike {
  op: string;
  table?: string;
  id?: string;
  fields?: Record<string, unknown>;
  procedure?: string;
  args?: Record<string, unknown>;
}

type Spec =
  | { kind: 'text'; max: number; nullable: boolean }
  | { kind: 'enum'; values: readonly string[]; nullable: boolean }
  | { kind: 'bool' }
  | { kind: 'int'; nullable: boolean }
  | { kind: 'money' }
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'timestamp' }
  | { kind: 'email' }
  | { kind: 'uuid' };

const text = (max: number, nullable = true): Spec => ({ kind: 'text', max, nullable });
const choice = (values: readonly string[], nullable = true): Spec => ({ kind: 'enum', values, nullable });
const LONG = 10_000;

export const FIELDS: Record<string, Record<string, Spec>> = {
  [TABLES.reservations]: {
    title: text(200, false),
    event_type: choice(EVENT_TYPES, false),
    status: choice(RESERVATION_STATUSES, false),
    priority: choice(PRIORITIES, false),
    start_date: { kind: 'date' },
    end_date: { kind: 'date' },
    expected_guests: { kind: 'int', nullable: true },
    minors_count: { kind: 'int', nullable: false },
    contact_name: text(200),
    contact_phone: text(40),
    contact_email: { kind: 'email' },
    customer_type: choice(CUSTOMER_TYPES),
    uses_accommodation: { kind: 'bool' },
    requires_meals: { kind: 'bool' },
    meal_plan_requested: choice(MEAL_PLANS),
    menu_style_requested: choice(MENU_STYLES),
    meal_notes: text(LONG),
    uses_interpretation_center: { kind: 'bool' },
    uses_outdoors: { kind: 'bool' },
    uses_pool: { kind: 'bool' },
    special_setup: { kind: 'bool' },
    technical_support: { kind: 'bool' },
    customer_notes: text(LONG),
    briefing_received: { kind: 'bool' },
    internal_notes: text(LONG),
    archived_at: { kind: 'timestamp' },
  },
  [TABLES.finance]: {
    budget_amount: { kind: 'money' },
    final_amount: { kind: 'money' },
    deposit_required: { kind: 'money' },
    deposit_paid: { kind: 'money' },
    payment_type: choice(PAYMENT_TYPES),
    payment_date: { kind: 'date' },
    payment_holder: text(200),
  },
  [TABLES.events]: {
    reservation_id: { kind: 'uuid' },
    responsible_name: text(200),
    arrival_time: { kind: 'time' },
    departure_time: { kind: 'time' },
    final_guests: { kind: 'int', nullable: true },
    meal_plan_confirmed: choice(MEAL_PLANS),
    menu_style_confirmed: choice(MENU_STYLES),
    room_distribution: text(LONG),
    rooms_count: { kind: 'int', nullable: true },
    setup_style: choice(SETUP_STYLES),
    technical_needs: choice(TECHNICAL_NEEDS),
    reinforced_cleaning: { kind: 'bool' },
    extra_support: { kind: 'bool' },
    preparation_status: choice(TASK_STATUSES_F, false),
    accommodation_status: choice(TASK_STATUSES_M, false),
    kitchen_status: choice(TASK_STATUSES_M, false),
    cleaning_status: choice(TASK_STATUSES_F, false),
    traveler_registration_status: choice(TRAVELER_REGISTRATION_STATUSES, false),
    operational_notes: text(LONG),
    closed_at: { kind: 'timestamp' },
    incidents: text(LONG),
    post_event_notes: text(LONG),
  },
};

/** Campos obligatorios al insertar. */
const REQUIRED_ON_INSERT: Record<string, string[]> = {
  [TABLES.reservations]: ['title'],
  [TABLES.events]: ['reservation_id'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INT = 100_000;
const MAX_MONEY = 9_999_999_999.99;

/** Devuelve el motivo por el que `value` no cumple `spec`, o null si es válido. */
export function checkValue(spec: Spec, value: unknown): string | null {
  const nullable = spec.kind === 'text' || spec.kind === 'enum' || spec.kind === 'int' ? spec.nullable : spec.kind !== 'bool' && spec.kind !== 'uuid';
  if (value === null) return nullable ? null : 'no puede quedar vacío';
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string') return 'debe ser un texto';
      if (value.length > spec.max) return `admite como máximo ${spec.max} caracteres`;
      if (!spec.nullable && !value.trim()) return 'no puede quedar vacío';
      return null;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? null : 'no es un valor admitido';
    case 'bool':
      return typeof value === 'boolean' ? null : 'debe ser sí o no';
    case 'int':
      return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_INT ? null : 'debe ser un número entero no negativo';
    case 'money':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_MONEY) return 'debe ser un importe no negativo';
      return Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 ? null : 'admite como máximo dos decimales';
    case 'date':
      return isValidDate(value) ? null : 'debe ser una fecha AAAA-MM-DD';
    case 'time':
      return typeof value === 'string' && TIME.test(value) ? null : 'debe ser una hora HH:MM';
    case 'timestamp':
      return typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value)) ? null : 'debe ser una fecha y hora ISO';
    case 'email':
      if (typeof value !== 'string' || value.length > 320) return 'debe ser un correo';
      return EMAIL.test(value) ? null : 'no tiene forma de correo';
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? null : 'debe ser un identificador uuid';
  }
}

function invalid(table: string, field: string, reason: string): Issue {
  return { status: 422, code: 'INVALID_FIELDS', message: `«${field}» ${reason}.`, details: { table, field } };
}

/**
 * Valida los campos de una operación de fila. Solo ve lo que viaja en `fields`: las coherencias entre un campo
 * enviado y otro ya guardado las cierran los `check` de la base (llegan como 422 `CONSTRAINT_VIOLATION`).
 */
export function validateFields(table: string, fields: Record<string, unknown>, mode: 'insert' | 'update'): Issue[] {
  const specs = FIELDS[table];
  if (!specs) return [];
  const issues: Issue[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const spec = specs[field];
    if (!spec) continue;
    const reason = checkValue(spec, value);
    if (reason) issues.push(invalid(table, field, reason));
  }
  if (mode === 'insert') {
    for (const field of REQUIRED_ON_INSERT[table] ?? []) {
      if (fields[field] === undefined) issues.push(invalid(table, field, 'es obligatorio'));
    }
  }
  if (issues.length) return issues;

  if (table === TABLES.reservations) {
    const start = dayNumber(fields.start_date as string | null | undefined);
    const end = dayNumber(fields.end_date as string | null | undefined);
    if (start !== null && end !== null && end < start) issues.push(invalid(table, 'end_date', 'no puede ser anterior a la fecha de entrada'));
    const guests = fields.expected_guests;
    const minors = fields.minors_count;
    if (typeof guests === 'number' && typeof minors === 'number' && minors > guests) issues.push(invalid(table, 'minors_count', 'no puede superar el número de personas'));
  }
  return issues;
}

function validateConfirmArgs(args: Record<string, unknown>): Issue[] {
  const bad = (field: string, reason: string): Issue => ({
    status: 422, code: 'INVALID_OPERATION', message: `Confirmar reserva: «${field}» ${reason}.`, details: { procedure: PROCEDURES.confirmReservation, field },
  });
  const issues: Issue[] = [];
  if (typeof args.reservation_id !== 'string' || !UUID.test(args.reservation_id)) issues.push(bad('reservation_id', 'debe ser un identificador uuid'));
  if (typeof args.event_id !== 'string' || !UUID.test(args.event_id)) issues.push(bad('event_id', 'debe ser un identificador uuid'));
  if (typeof args.from_status !== 'string' || !(RESERVATION_STATUSES as readonly string[]).includes(args.from_status)) issues.push(bad('from_status', 'no es un estado admitido'));
  if (args.expectedRevision !== undefined && args.expectedRevision !== null && !(Number.isSafeInteger(args.expectedRevision) && (args.expectedRevision as number) >= 1)) {
    issues.push(bad('expectedRevision', 'debe ser un entero positivo'));
  }
  return issues;
}

/** Reglas de `beforeCommit` para un lote completo. Devuelve todos los problemas; la Edge responde con el primero. */
export function validateOperations(operations: readonly OperationLike[], actor: { role: Role }): Issue[] {
  const issues: Issue[] = [];
  operations.forEach((op, index) => {
    const at = (issue: Issue): Issue => ({ ...issue, details: { ...issue.details, index } });
    if (op.op === 'call') {
      if (op.procedure === PROCEDURES.confirmReservation) issues.push(...validateConfirmArgs(op.args ?? {}).map(at));
      return;
    }
    const table = op.table ?? '';
    if (table === TABLES.events) {
      if (op.op === 'insert') {
        issues.push(at({ status: 422, code: 'INVALID_OPERATION', message: 'El evento operativo se crea al confirmar la reserva.', details: { table } }));
        return;
      }
      if ((op.op === 'delete' || op.op === 'restore') && actor.role !== 'owner') {
        issues.push(at({ status: 403, code: 'FORBIDDEN', message: 'Solo un propietario puede borrar o restaurar un evento operativo.', details: { table } }));
        return;
      }
      if (op.op === 'update' && op.fields && 'reservation_id' in op.fields) {
        issues.push(at(invalid(table, 'reservation_id', 'no se puede cambiar')));
        return;
      }
    }
    if (op.op === 'insert' || op.op === 'update') issues.push(...validateFields(table, op.fields ?? {}, op.op).map(at));
  });
  return issues;
}
