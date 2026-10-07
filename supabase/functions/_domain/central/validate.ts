/**
 * Ikisai Central · validación de operaciones de fila (docs/central/API.md §4.1).
 * Reglas puras: corren en el cliente antes de encolar y otra vez en la Edge antes de core.commit.
 * Todo lo que PostgreSQL rechazaría con un check se rechaza aquí con el campo en `details`.
 */
import {
  AVAILABILITIES, BASE_ROLES, canSeeReserved, COVERAGES, ENGAGEMENTS, FREE_RECORD_TYPES, RECORD_KINDS, RECORD_STATUSES,
  recordTypesFor, RELATIONS, RESERVED_TABLES, TABLES, type RecordKind,
} from './people.ts';
import { ENTITY_TABLE, taxIdProblem } from './entity.ts';
import { KPI_TARGETS_TABLE } from './kpis.ts';
import {
  COMPLIANCE_TABLES, DOCUMENT_KINDS, FREQUENCIES, IMPACTS, KEY_DOCUMENT_STATUSES, REQUIREMENT_STATUSES, REQUIREMENT_TYPES, RISKS,
} from './compliance.ts';

export interface DomainOperation {
  op: string;
  table?: string;
  id?: string;
  fields?: Record<string, unknown>;
  procedure?: string;
  args?: Record<string, unknown>;
}

export interface Issue {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** Quién escribe: rol y ámbitos de Central de la sesión. */
export interface Actor {
  role: string;
  scopes?: unknown;
}

type FieldSpec =
  | { kind: 'text'; max: number; min?: number; nullable?: boolean; email?: boolean; pattern?: RegExp; patternText?: string }
  | { kind: 'enum'; values: readonly string[]; nullable?: boolean }
  | { kind: 'boolean' }
  /** `file`: también admite el marcador `{"$blob": sha}` que sync-client sustituye por el id al subir el archivo. */
  | { kind: 'uuid'; nullable?: boolean; file?: boolean }
  | { kind: 'date'; nullable?: boolean }
  | { kind: 'number'; nullable?: boolean };

interface TableSpec {
  fields: Record<string, FieldSpec>;
  required: string[];
  /** Columnas que no cambian después del alta. */
  immutable?: string[];
}

const SPECS: Record<string, TableSpec> = {
  [TABLES.people]: {
    fields: {
      display_name: { kind: 'text', min: 1, max: 80 },
      relation: { kind: 'enum', values: RELATIONS },
      base_role: { kind: 'enum', values: BASE_ROLES },
      coverage: { kind: 'enum', values: COVERAGES },
      availability: { kind: 'enum', values: AVAILABILITIES },
      availability_notes: { kind: 'text', max: 300, nullable: true },
      active: { kind: 'boolean' },
      committed_post: { kind: 'boolean' },
      user_id: { kind: 'uuid', nullable: true },
      position: { kind: 'number' },
    },
    required: ['display_name', 'relation'],
  },
  [TABLES.personPrivate]: {
    fields: {
      person_id: { kind: 'uuid' },
      legal_name: { kind: 'text', max: 160, nullable: true },
      phone: { kind: 'text', max: 32, nullable: true },
      email: { kind: 'text', max: 320, nullable: true, email: true },
      engagement: { kind: 'enum', values: ENGAGEMENTS, nullable: true },
      engaged_from: { kind: 'date', nullable: true },
      engaged_until: { kind: 'date', nullable: true },
      emergency_contact: { kind: 'text', max: 160, nullable: true },
      notes: { kind: 'text', max: 1000, nullable: true },
    },
    required: ['person_id'],
    immutable: ['person_id'],
  },
  [TABLES.personRecords]: {
    fields: {
      person_id: { kind: 'uuid' },
      kind: { kind: 'enum', values: RECORD_KINDS },
      record_type: { kind: 'text', min: 1, max: 40 },
      title: { kind: 'text', min: 1, max: 120, nullable: true },
      status: { kind: 'enum', values: RECORD_STATUSES },
      issued_on: { kind: 'date', nullable: true },
      expires_on: { kind: 'date', nullable: true },
      reviewed_on: { kind: 'date', nullable: true },
      file_id: { kind: 'uuid', nullable: true, file: true },
      notes: { kind: 'text', max: 500, nullable: true },
      position: { kind: 'number' },
    },
    required: ['person_id', 'kind', 'record_type'],
    immutable: ['person_id'],
  },
  [COMPLIANCE_TABLES.requirements]: {
    fields: {
      name: { kind: 'text', min: 1, max: 160 },
      requirement_type: { kind: 'enum', values: REQUIREMENT_TYPES },
      description: { kind: 'text', max: 2000, nullable: true },
      source: { kind: 'text', max: 300, nullable: true },
      authority: { kind: 'text', max: 160, nullable: true },
      responsible_person_id: { kind: 'uuid', nullable: true },
      status: { kind: 'enum', values: REQUIREMENT_STATUSES },
      reference_date: { kind: 'date', nullable: true },
      expires_on: { kind: 'date', nullable: true },
      frequency: { kind: 'enum', values: FREQUENCIES },
      frequency_months: { kind: 'number', nullable: true },
      notice_days: { kind: 'number' },
      risk: { kind: 'enum', values: RISKS },
      impact: { kind: 'enum', values: IMPACTS, nullable: true },
      blocks_operation: { kind: 'boolean' },
      generates_cost: { kind: 'boolean' },
      next_action: { kind: 'text', max: 300, nullable: true },
      next_action_on: { kind: 'date', nullable: true },
      notes: { kind: 'text', max: 1000, nullable: true },
      position: { kind: 'number' },
    },
    required: ['name', 'requirement_type'],
  },
  [COMPLIANCE_TABLES.keyDocuments]: {
    fields: {
      requirement_id: { kind: 'uuid', nullable: true },
      document_type: { kind: 'enum', values: DOCUMENT_KINDS },
      name: { kind: 'text', min: 1, max: 160 },
      description: { kind: 'text', max: 1000, nullable: true },
      status: { kind: 'enum', values: KEY_DOCUMENT_STATUSES },
      document_date: { kind: 'date', nullable: true },
      reviewed_on: { kind: 'date', nullable: true },
      expires_on: { kind: 'date', nullable: true },
      version: { kind: 'text', max: 40, nullable: true },
      signed: { kind: 'boolean' },
      file_id: { kind: 'uuid', nullable: true, file: true },
      external_url: { kind: 'text', max: 500, nullable: true, pattern: /^https:\/\//, patternText: 'debe empezar por https://' },
      responsible_person_id: { kind: 'uuid', nullable: true },
      notes: { kind: 'text', max: 1000, nullable: true },
    },
    required: ['document_type', 'name'],
  },
  [COMPLIANCE_TABLES.requirementTasks]: {
    fields: {
      target_label: { kind: 'text', max: 500, nullable: true },
      target_revision: { kind: 'number', nullable: true },
      due_on: { kind: 'date', nullable: true },
    },
    required: [],
    immutable: ['requirement_id', 'target_app', 'target_kind', 'target_id', 'external_ref'],
  },
  [KPI_TARGETS_TABLE]: {
    fields: {
      kpi: { kind: 'text', min: 3, max: 80, pattern: /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, patternText: 'clave «app.nombre»' },
      period: { kind: 'text', min: 1, max: 7, pattern: /^(\*|\d{4}|\d{4}-\d{2}|\d{4}T[1-4])$/, patternText: '«*», «AAAA», «AAAA-MM» o «AAAAT1»…«T4»' },
      target: { kind: 'number', nullable: true },
      warn_at: { kind: 'number', nullable: true },
      critical_at: { kind: 'number', nullable: true },
      direction: { kind: 'enum', values: ['up', 'down'] },
      notes: { kind: 'text', max: 300, nullable: true },
    },
    required: ['kpi'],
  },
  [ENTITY_TABLE]: {
    fields: {
      legal_name: { kind: 'text', min: 1, max: 200 },
      trade_name: { kind: 'text', min: 1, max: 120, nullable: true },
      tax_id: { kind: 'text', min: 8, max: 15, pattern: /^[A-Z0-9]+$/, patternText: 'solo letras mayúsculas y cifras, sin espacios' },
      address_line: { kind: 'text', min: 1, max: 200 },
      postal_code: { kind: 'text', min: 3, max: 12 },
      city: { kind: 'text', min: 1, max: 80 },
      province: { kind: 'text', min: 1, max: 80, nullable: true },
      country: { kind: 'text', min: 2, max: 2, pattern: /^[A-Z]{2}$/, patternText: 'código de país de dos letras' },
      email: { kind: 'text', max: 320, nullable: true, email: true },
      phone: { kind: 'text', max: 32, nullable: true },
      website: { kind: 'text', max: 200, nullable: true, pattern: /^https:\/\//, patternText: 'debe empezar por https://' },
      logo_file_id: { kind: 'uuid', nullable: true, file: true },
    },
    required: ['legal_name', 'tax_id', 'address_line', 'postal_code', 'city'],
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(value + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function checkField(spec: FieldSpec, value: unknown): string | null {
  if (value === null) return 'nullable' in spec && spec.nullable ? null : 'no puede estar vacío';
  switch (spec.kind) {
    case 'text': {
      if (typeof value !== 'string') return 'debe ser texto';
      const length = value.trim().length;
      if (length < (spec.min ?? 0)) return 'no puede estar vacío';
      if (value.length > spec.max) return `admite como mucho ${spec.max} caracteres`;
      if (spec.email && !EMAIL.test(value)) return 'no es un correo válido';
      if (spec.pattern && !spec.pattern.test(value)) return spec.patternText ?? 'formato no válido';
      return null;
    }
    case 'enum': return typeof value === 'string' && spec.values.includes(value) ? null : 'valor no admitido';
    case 'boolean': return typeof value === 'boolean' ? null : 'debe ser sí o no';
    case 'uuid':
      if (spec.file && typeof value === 'object' && typeof (value as { $blob?: unknown }).$blob === 'string') return null;
      return typeof value === 'string' && UUID.test(value) ? null : 'identificador inválido';
    case 'date': return typeof value === 'string' && isDate(value) ? null : 'fecha inválida';
    case 'number': return typeof value === 'number' && Number.isFinite(value) ? null : 'debe ser un número';
  }
}

const fieldIssue = (index: number, table: string, field: string, reason: string): Issue => ({
  code: 'INVALID_FIELDS', message: `Campo ${field}: ${reason}.`, details: { index, table, field, reason },
});

/**
 * Valida un lote de Central. `current` (opcional) da la fila actual por id para comprobar coherencias en un update
 * cuando el cliente solo envía parte de los campos (en la Edge no hace falta: lo garantizan los check de PostgreSQL).
 */
export function validateOperations(operations: readonly DomainOperation[], actor: Actor, current?: (table: string, id: string) => Record<string, unknown> | undefined): Issue | null {
  for (const [index, op] of operations.entries()) {
    if (op.op === 'call') return { code: 'INVALID_OPERATION', message: 'Central no tiene procedimientos.', details: { index } };
    const table = op.table ?? '';
    const spec = SPECS[table];
    if (!spec) continue; // tabla desconocida: la rechaza el núcleo
    if (RESERVED_TABLES.includes(table) && !canSeeReserved(actor)) {
      return { code: 'FORBIDDEN', message: 'No tienes acceso a los datos reservados de personas.', details: { index, table } };
    }
    if (op.op !== 'insert' && op.op !== 'update' && op.op !== 'restore') continue;
    const fields = op.fields ?? {};
    for (const [field, value] of Object.entries(fields)) {
      const fieldSpec = spec.fields[field];
      if (!fieldSpec) continue; // el núcleo responde INVALID_FIELDS con su lista blanca
      const reason = checkField(fieldSpec, value);
      if (reason) return fieldIssue(index, table, field, reason);
    }
    if (op.op === 'insert') {
      for (const field of spec.required) if (fields[field] === undefined || fields[field] === null) return fieldIssue(index, table, field, 'es obligatorio');
    } else {
      for (const field of spec.immutable ?? []) {
        if (field in fields) return { code: 'IMMUTABLE_FIELD', message: `El campo ${field} no se puede cambiar.`, details: { index, table, field } };
      }
    }
    if (table === COMPLIANCE_TABLES.requirementTasks && op.op === 'insert') {
      return { code: 'INVALID_OPERATION', message: 'Las tareas se piden a Tasks desde la obligación («Crear tarea en Tasks»).', details: { index, table } };
    }
    if (table === COMPLIANCE_TABLES.requirements) {
      if (typeof fields.frequency_months === 'number' && (!Number.isInteger(fields.frequency_months) || fields.frequency_months < 1 || fields.frequency_months > 120)) {
        return fieldIssue(index, table, 'frequency_months', 'debe ser un número de meses entre 1 y 120');
      }
      if (typeof fields.notice_days === 'number' && (!Number.isInteger(fields.notice_days) || fields.notice_days < 0 || fields.notice_days > 365)) {
        return fieldIssue(index, table, 'notice_days', 'debe ser un número de días entre 0 y 365');
      }
      const row = { ...(op.id && current ? current(table, op.id) ?? {} : {}), ...fields } as Record<string, unknown>;
      if ((row.frequency ?? 'unica') === 'otra' && (row.frequency_months === null || row.frequency_months === undefined)) {
        return fieldIssue(index, table, 'frequency_months', 'indica cada cuántos meses');
      }
      if (row.frequency !== 'otra' && row.frequency !== undefined && row.frequency_months !== null && row.frequency_months !== undefined) {
        return fieldIssue(index, table, 'frequency_months', 'solo se usa con frecuencia «otra»');
      }
    }
    if (table === COMPLIANCE_TABLES.keyDocuments) {
      const row = { ...(op.id && current ? current(table, op.id) ?? {} : {}), ...fields } as Record<string, unknown>;
      if (typeof row.document_date === 'string' && typeof row.expires_on === 'string' && row.expires_on < row.document_date) {
        return fieldIssue(index, table, 'expires_on', 'no puede ser anterior a la fecha del documento');
      }
    }
    if (table === KPI_TARGETS_TABLE && actor.role !== 'owner') {
      return { code: 'FORBIDDEN', message: 'Solo quien administra puede fijar objetivos.', details: { index, table } };
    }
    if (table === ENTITY_TABLE && actor.role !== 'owner') {
      return { code: 'FORBIDDEN', message: 'Solo quien administra puede cambiar los datos de la entidad.', details: { index, table } };
    }
    if (table === ENTITY_TABLE && typeof fields.tax_id === 'string') {
      const problem = taxIdProblem(fields.tax_id);
      const country = (op.id && current ? current(table, op.id)?.country : undefined) ?? fields.country ?? 'ES';
      if (problem && country === 'ES') return fieldIssue(index, table, 'tax_id', problem);
    }
    if (table === TABLES.people && 'user_id' in fields && actor.role !== 'owner') {
      return { code: 'FORBIDDEN', message: 'Solo quien administra puede enlazar una cuenta.', details: { index, table, field: 'user_id' } };
    }
    const row = { ...(op.id && current ? current(table, op.id) ?? {} : {}), ...fields } as Record<string, unknown>;
    if (table === TABLES.personPrivate && typeof row.engaged_from === 'string' && typeof row.engaged_until === 'string' && row.engaged_until < row.engaged_from) {
      return fieldIssue(index, table, 'engaged_until', 'no puede ser anterior al inicio');
    }
    if (table === TABLES.personRecords) {
      const kind = row.kind as RecordKind | undefined;
      if (kind && typeof row.record_type === 'string' && !recordTypesFor(kind).includes(row.record_type)) {
        return fieldIssue(index, table, 'record_type', 'no corresponde a ese tipo de registro');
      }
      if (typeof row.record_type === 'string' && FREE_RECORD_TYPES.includes(row.record_type) && (typeof row.title !== 'string' || !row.title.trim())) {
        return fieldIssue(index, table, 'title', 'es obligatorio con «otro»');
      }
      if (typeof row.issued_on === 'string' && typeof row.expires_on === 'string' && row.expires_on < row.issued_on) {
        return fieldIssue(index, table, 'expires_on', 'no puede ser anterior a la fecha del documento');
      }
    }
  }
  return null;
}
