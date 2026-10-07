/**
 * Ikisai Booking · validación compartida entre la Edge (`beforeCommit`) y el frontend (docs/booking/API.md §4.1).
 * Es pura: no conoce `_kit` ni el navegador. Los campos desconocidos no se juzgan aquí; los rechaza el núcleo.
 */
import {
  BED_KINDS, PROPOSAL_NATURES, PROPOSAL_STATUSES, RATE_LAYERS, RATE_SERVICES, RATE_UNITS, NEED_PRIORITIES, NEED_STATUSES, NEED_TYPES, STAFF_FUNCTIONS, STAFF_STATUSES, CHECKLIST_STATUSES, CHECKLIST_TYPES, SPACE_KINDS, CUSTOMER_TYPES, DOCUMENT_TYPES, EVENT_TYPES, GUEST_DATA_STATUSES, MEAL_PLANS, MENU_STYLES,
  PAYMENT_TYPES, PRIORITIES, PROCEDURES, RESERVATION_STATUSES, RESTRICTION_SEVERITIES, RESTRICTION_TYPES,
  RESTRICTION_TYPES_WITH_SEVERITY, RESTRICTION_TYPES_WITH_SUBJECT, SES_STATUSES, SETUP_STYLES, SEXES, TABLES, TASK_STATUSES_F,
  TASK_STATUSES_M, TECHNICAL_NEEDS, TRAVELER_REGISTRATION_STATUSES,
} from './catalog.ts';
import { missingForSes } from './guests.ts';
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
  | { kind: 'enumList'; values: readonly string[] }
  | { kind: 'bool' }
  | { kind: 'int'; nullable: boolean; min?: number }
  | { kind: 'number' }
  | { kind: 'money' }
  | { kind: 'date' }
  | { kind: 'time' }
  | { kind: 'timestamp' }
  | { kind: 'email' }
  | { kind: 'country' }
  | { kind: 'uuid'; nullable?: boolean }
  | { kind: 'file' };

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
  [TABLES.guests]: {
    event_id: { kind: 'uuid' },
    first_name: text(120, false),
    last_name_1: text(120),
    last_name_2: text(120),
    sex: choice(SEXES),
    document_type: choice(DOCUMENT_TYPES),
    document_number: text(40),
    document_support_number: text(40),
    nationality: { kind: 'country' },
    birth_date: { kind: 'date' },
    residence_address: text(300),
    residence_postal_code: text(20),
    residence_city: text(120),
    residence_country: { kind: 'country' },
    phone: text(40),
    email: { kind: 'email' },
    is_minor: { kind: 'bool' },
    guardian_name: text(200),
    kinship: text(80),
    signed_at: { kind: 'timestamp' },
    signed_by_name: text(200),
    signature_file_id: { kind: 'file' },
    data_status: choice(GUEST_DATA_STATUSES, false),
    ses_status: choice(SES_STATUSES, false),
    ses_sent_at: { kind: 'timestamp' },
    ses_sent_by: text(200),
    ses_receipt_ref: text(500),
    ses_receipt_file_id: { kind: 'file' },
    notes: text(LONG),
  },
  [TABLES.restrictions]: {
    event_id: { kind: 'uuid' },
    guest_id: { kind: 'uuid', nullable: true },
    restriction_type: choice(RESTRICTION_TYPES, false),
    subject: text(200),
    severity: choice(RESTRICTION_SEVERITIES),
    servings: { kind: 'int', nullable: true, min: 1 },
    kitchen_notes: text(2000),
    active: { kind: 'bool' },
  },
  [TABLES.checklist]: {
    event_id: { kind: 'uuid' },
    checklist_type: choice(CHECKLIST_TYPES, false),
    label: text(200, false),
    status: choice(CHECKLIST_STATUSES, false),
    responsible_name: text(200),
    reviewed_on: { kind: 'date' },
    notes: text(LONG),
    position: { kind: 'number' },
  },
};

FIELDS[TABLES.spaces] = {
  name: text(120, false),
  kind: choice(SPACE_KINDS, false),
  zone: text(120),
  capacity: { kind: 'int', nullable: true },
  accessible: { kind: 'bool' },
  active: { kind: 'bool' },
  bookable: { kind: 'bool' },
  position: { kind: 'number' },
  notes: text(LONG),
};
FIELDS[TABLES.beds] = {
  space_id: { kind: 'uuid' },
  label: text(80, false),
  kind: choice(BED_KINDS, false),
  capacity: { kind: 'int', nullable: false, min: 1 },
  active: { kind: 'bool' },
  position: { kind: 'number' },
};
FIELDS[TABLES.roomAssignments] = {
  event_id: { kind: 'uuid' },
  space_id: { kind: 'uuid' },
  bed_id: { kind: 'uuid', nullable: true },
  guest_id: { kind: 'uuid', nullable: true },
  group_label: text(120),
  persons: { kind: 'int', nullable: false, min: 1 },
  from_date: { kind: 'date' },
  to_date: { kind: 'date' },
  notes: text(LONG),
};

FIELDS[TABLES.staffAssignments] = {
  event_id: { kind: 'uuid' },
  person_name: text(120, false),
  member_user_id: { kind: 'uuid', nullable: true },
  person_ref_app: choice(['central']),
  person_ref_id: text(120),
  function: choice(STAFF_FUNCTIONS, false),
  work_date: { kind: 'date' },
  planned_hours: { kind: 'number' },
  actual_hours: { kind: 'number' },
  status: choice(STAFF_STATUSES, false),
  notes: text(LONG),
  position: { kind: 'number' },
};
FIELDS[TABLES.staffNeeds] = {
  event_id: { kind: 'uuid' },
  need_type: choice(NEED_TYPES, false),
  persons: { kind: 'int', nullable: false, min: 1 },
  priority: choice(NEED_PRIORITIES, false),
  status: choice(NEED_STATUSES, false),
  notes: text(LONG),
};

FIELDS[TABLES.rates] = {
  name: text(120, false),
  layer: choice(RATE_LAYERS, false),
  unit: choice(RATE_UNITS, false),
  amount: { kind: 'number' },
  service: choice(RATE_SERVICES),
  min_persons: { kind: 'int', nullable: true },
  max_persons: { kind: 'int', nullable: true },
  event_types: { kind: 'enumList', values: EVENT_TYPES },
  valid_from: { kind: 'date' },
  valid_to: { kind: 'date' },
  includes: text(LONG),
  excludes: text(LONG),
  active: { kind: 'bool' },
  position: { kind: 'number' },
};
FIELDS[TABLES.conditions] = {
  name: text(120, false),
  deposit_percent: { kind: 'number' },
  deposit_minimum: { kind: 'money' },
  deposit_days: { kind: 'int', nullable: false },
  deposit_days_short: { kind: 'int', nullable: false },
  short_notice_days: { kind: 'int', nullable: false },
  prices_include_vat: { kind: 'bool' },
  vat_rate: { kind: 'number' },
  text: text(LONG),
  is_default: { kind: 'bool' },
  active: { kind: 'bool' },
};
FIELDS[TABLES.cancellationTiers] = {
  conditions_id: { kind: 'uuid' },
  min_days_before: { kind: 'int', nullable: false },
  deposit_refund_pct: { kind: 'number' },
  extra_costs: { kind: 'bool' },
  position: { kind: 'number' },
};
FIELDS[TABLES.proposals] = {
  reservation_id: { kind: 'uuid' },
  status: choice(PROPOSAL_STATUSES, false),
  nature: choice(PROPOSAL_NATURES, false),
  conditions_id: { kind: 'uuid', nullable: true },
  start_date: { kind: 'date' },
  end_date: { kind: 'date' },
  persons: { kind: 'int', nullable: true },
  valid_until: { kind: 'date' },
  includes: text(LONG),
  excludes: text(LONG),
  notes: text(LONG),
  decided_at: { kind: 'timestamp' },
};
FIELDS[TABLES.proposalLines] = {
  proposal_id: { kind: 'uuid' },
  rate_id: { kind: 'uuid', nullable: true },
  description: text(300, false),
  unit: choice(RATE_UNITS, false),
  quantity: { kind: 'number' },
  unit_amount: { kind: 'number' },
  discount_pct: { kind: 'number' },
  position: { kind: 'number' },
};

/** Columna de enlace con el padre: se escribe en el alta y no se puede cambiar después. */
const PARENT_LINK: Record<string, string> = {
  [TABLES.events]: 'reservation_id',
  [TABLES.guests]: 'event_id',
  [TABLES.restrictions]: 'event_id',
  [TABLES.checklist]: 'event_id',
  [TABLES.beds]: 'space_id',
  [TABLES.roomAssignments]: 'event_id',
  [TABLES.staffAssignments]: 'event_id',
  [TABLES.staffNeeds]: 'event_id',
  [TABLES.cancellationTiers]: 'conditions_id',
  [TABLES.proposals]: 'reservation_id',
  [TABLES.proposalLines]: 'proposal_id',
};

/** Campos obligatorios al insertar. */
const REQUIRED_ON_INSERT: Record<string, string[]> = {
  [TABLES.reservations]: ['title'],
  [TABLES.events]: ['reservation_id'],
  [TABLES.guests]: ['event_id', 'first_name'],
  [TABLES.restrictions]: ['event_id', 'restriction_type'],
  [TABLES.checklist]: ['event_id', 'checklist_type', 'label'],
  [TABLES.spaces]: ['name', 'kind'],
  [TABLES.beds]: ['space_id', 'label'],
  [TABLES.roomAssignments]: ['event_id', 'space_id'],
  [TABLES.staffAssignments]: ['event_id', 'person_name', 'function'],
  [TABLES.staffNeeds]: ['event_id', 'need_type'],
  [TABLES.rates]: ['name', 'layer', 'unit', 'amount'],
  [TABLES.conditions]: ['name'],
  [TABLES.cancellationTiers]: ['conditions_id', 'min_days_before', 'deposit_refund_pct'],
  [TABLES.proposals]: ['reservation_id'],
  [TABLES.proposalLines]: ['proposal_id', 'description', 'unit', 'unit_amount'],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY = /^[A-Z]{3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_INT = 100_000;
const MAX_MONEY = 9_999_999_999.99;
/** `numeric(5,2)` de las horas del personal. */
const MAX_HOURS = 999.99;

/** Devuelve el motivo por el que `value` no cumple `spec`, o null si es válido. */
export function checkValue(spec: Spec, value: unknown): string | null {
  const nullable = spec.kind === 'text' || spec.kind === 'enum' || spec.kind === 'int' ? spec.nullable
    : spec.kind === 'uuid' ? spec.nullable === true
    : spec.kind !== 'bool' && spec.kind !== 'number';
  if (value === null) return nullable ? null : 'no puede quedar vacío';
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string') return 'debe ser un texto';
      if (value.length > spec.max) return `admite como máximo ${spec.max} caracteres`;
      if (!spec.nullable && !value.trim()) return 'no puede quedar vacío';
      return null;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? null : 'no es un valor admitido';
    case 'enumList':
      return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && spec.values.includes(v)) && new Set(value).size === value.length
        ? null : 'debe ser una lista de valores admitidos';
    case 'bool':
      return typeof value === 'boolean' ? null : 'debe ser sí o no';
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value > MAX_INT) return 'debe ser un número entero';
      return value >= (spec.min ?? 0) ? null : `debe ser como mínimo ${spec.min ?? 0}`;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e9 ? null : 'debe ser un número';
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
    case 'country':
      return typeof value === 'string' && COUNTRY.test(value) ? null : 'debe ser un código de país de tres letras (ESP, FRA…)';
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? null : 'debe ser un identificador uuid';
    case 'file': {
      // id de `core.files`, o el marcador `{"$blob": "<sha256>"}` que `sync-client` sustituye al subir el adjunto
      if (typeof value === 'string') return UUID.test(value) ? null : 'debe ser un identificador de archivo';
      const sha = typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).$blob : undefined;
      return typeof sha === 'string' && SHA256.test(sha) ? null : 'debe ser un identificador de archivo';
    }
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

  if (table === TABLES.restrictions) {
    const has = (field: string) => fields[field] !== undefined;
    const type = fields.restriction_type as string | undefined;
    if (mode === 'insert' || (has('guest_id') && has('servings'))) {
      const guest = fields.guest_id ?? null;
      const servings = fields.servings ?? null;
      if (guest !== null && servings !== null) issues.push(invalid(table, 'servings', 'no se indica cuando la restricción es de un huésped concreto'));
      if (guest === null && servings === null) issues.push(invalid(table, 'servings', 'es obligatorio cuando la restricción no es de un huésped concreto'));
    }
    if (type !== undefined && (mode === 'insert' || has('severity'))) {
      if ((fields.severity ?? null) !== null && !RESTRICTION_TYPES_WITH_SEVERITY.includes(type)) issues.push(invalid(table, 'severity', 'solo se indica en alergias e intolerancias'));
    }
    if (type !== undefined && (mode === 'insert' || has('subject'))) {
      const subject = fields.subject;
      if (RESTRICTION_TYPES_WITH_SUBJECT.includes(type) && !(typeof subject === 'string' && subject.trim())) issues.push(invalid(table, 'subject', 'es obligatorio en alergias, intolerancias y «otra»'));
    }
  }

  if (table === TABLES.beds && typeof fields.capacity === 'number' && fields.capacity > 2) issues.push(invalid(table, 'capacity', 'admite como máximo 2 personas'));

  if (table === TABLES.rates || table === TABLES.proposalLines) {
    const amountField = table === TABLES.rates ? 'amount' : 'unit_amount';
    const value = fields[amountField];
    const percent = fields.unit === 'porcentaje';
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) issues.push(invalid(table, amountField, 'admite como máximo dos decimales'));
      else if (percent && Math.abs(value) > 100) issues.push(invalid(table, amountField, 'un porcentaje va de -100 a 100'));
      else if (!percent && table === TABLES.rates && value < 0) issues.push(invalid(table, amountField, 'no puede ser negativo (los descuentos van en porcentaje)'));
      else if (Math.abs(value) > MAX_MONEY) issues.push(invalid(table, amountField, 'es demasiado grande'));
    }
    if (table === TABLES.proposalLines && typeof fields.quantity === 'number' && (fields.quantity < 0 || fields.quantity > 99_999_999)) issues.push(invalid(table, 'quantity', 'no puede ser negativa'));
    if (table === TABLES.rates && typeof fields.min_persons === 'number' && typeof fields.max_persons === 'number' && fields.max_persons < fields.min_persons) {
      issues.push(invalid(table, 'max_persons', 'debe ser mayor o igual que el mínimo'));
    }
    if (table === TABLES.rates) {
      const from = dayNumber(fields.valid_from as string | null | undefined);
      const to = dayNumber(fields.valid_to as string | null | undefined);
      if (from !== null && to !== null && to < from) issues.push(invalid(table, 'valid_to', 'debe ser igual o posterior al inicio'));
    }
  }
  if (table === TABLES.conditions || table === TABLES.cancellationTiers || table === TABLES.proposalLines) {
    for (const field of ['deposit_percent', 'vat_rate', 'deposit_refund_pct', 'discount_pct']) {
      const value = fields[field];
      if (typeof value === 'number' && (value < 0 || value > 100)) issues.push(invalid(table, field, 'es un porcentaje de 0 a 100'));
    }
  }
  if (table === TABLES.proposals && typeof fields.status === 'string' && !['borrador', 'rechazada', 'caducada'].includes(fields.status)) {
    issues.push(invalid(table, 'status', 'enviar y aceptar una propuesta va por su botón, no editando el estado'));
  }

  if (table === TABLES.staffAssignments) {
    const day = fields.work_date !== undefined && fields.work_date !== null;
    for (const field of ['planned_hours', 'actual_hours']) {
      const value = fields[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (value < 0) issues.push(invalid(table, field, 'no puede ser negativo'));
      else if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) issues.push(invalid(table, field, 'admite como máximo dos decimales'));
      else if (value > MAX_HOURS) issues.push(invalid(table, field, `admite como máximo ${MAX_HOURS} horas`));
      else if (day && value > 24) issues.push(invalid(table, field, 'un turno de un día no pasa de 24 horas'));
    }
    if (mode === 'insert' || fields.person_ref_app !== undefined || fields.person_ref_id !== undefined) {
      const app = fields.person_ref_app ?? null;
      const ref = fields.person_ref_id ?? null;
      if ((app === null) !== (ref === null)) issues.push(invalid(table, 'person_ref_id', 'el enlace a la ficha de personal lleva app e identificador'));
    }
  }

  if (table === TABLES.roomAssignments) {
    const has = (field: string) => fields[field] !== undefined;
    if (mode === 'insert' || has('guest_id') || has('group_label')) {
      const guest = fields.guest_id ?? null;
      const group = typeof fields.group_label === 'string' ? fields.group_label.trim() : null;
      if (mode === 'insert' && !guest && !group) issues.push(invalid(table, 'group_label', 'indica un huésped o el nombre de un grupo'));
      if (guest && group) issues.push(invalid(table, 'group_label', 'no se indica cuando la asignación es de un huésped concreto'));
      if (guest && typeof fields.persons === 'number' && fields.persons !== 1) issues.push(invalid(table, 'persons', 'es 1 cuando la asignación es de un huésped concreto'));
    }
    const from = dayNumber(fields.from_date as string | null | undefined);
    const to = dayNumber(fields.to_date as string | null | undefined);
    if (from !== null && to !== null && to <= from) issues.push(invalid(table, 'to_date', 'debe ser posterior a la fecha de entrada'));
  }

  if (table === TABLES.guests) {
    const has = (field: string) => fields[field] !== undefined;
    if (fields.ses_status === 'enviado_SES' && (mode === 'insert' || has('ses_sent_at')) && !fields.ses_sent_at) issues.push(invalid(table, 'ses_sent_at', 'es obligatorio al marcar el envío a SES'));
    if (fields.ses_status === 'listo_para_envio' && (mode === 'insert' || has('data_status')) && (fields.data_status ?? 'pendiente_datos') !== 'datos_revisados') {
      issues.push(invalid(table, 'ses_status', 'no puede ser «listo para envío» sin los datos revisados'));
    }
    if (has('signature_file_id') && fields.signature_file_id !== null && (mode === 'insert' || has('signed_at')) && !fields.signed_at) issues.push(invalid(table, 'signed_at', 'es obligatorio al guardar la firma'));
    // Solo en el alta viaja la fila completa; en una edición lo comprueba la app con la fila fusionada (`missingForSes`).
    if (mode === 'insert' && fields.data_status === 'datos_revisados') {
      const missing = missingForSes(fields);
      if (missing.length) issues.push({ status: 422, code: 'INVALID_FIELDS', message: 'Faltan datos obligatorios para dar al huésped por revisado.', details: { table, field: 'data_status', missing } });
    }
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
export function validateOperations(operations: readonly OperationLike[], actor: { role: Role; canSeeGuests?: boolean }): Issue[] {
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
    }
    if (table === 'booking.portal_declarations') {
      issues.push(at({ status: 422, code: 'INVALID_OPERATION', message: 'La declaración del organizador solo la registra su portal.', details: { table } }));
      return;
    }
    if (table === TABLES.guests && op.fields && ['allergies_visible_to_organizer', 'privacy_ack_at', 'privacy_ack_version'].some((f) => f in op.fields!)) {
      issues.push(at({ status: 422, code: 'INVALID_OPERATION', message: 'El consentimiento y el aviso legal solo los marca el propio huésped desde su enlace.', details: { table } }));
      return;
    }
    if (table === TABLES.guests && !(actor.canSeeGuests ?? actor.role === 'owner')) {
      issues.push(at({ status: 403, code: 'FORBIDDEN', message: 'Los datos de huéspedes están restringidos a los responsables designados.', details: { table } }));
      return;
    }
    const link = PARENT_LINK[table];
    if (link && op.op === 'update' && op.fields && link in op.fields) {
      issues.push(at(invalid(table, link, 'no se puede cambiar')));
      return;
    }
    if (op.op === 'insert' || op.op === 'update') issues.push(...validateFields(table, op.fields ?? {}, op.op).map(at));
  });
  return issues;
}
