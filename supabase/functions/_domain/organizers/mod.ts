/**
 * Ikisai Organizers · código de dominio compartido entre la Edge `organizers-api` y la PWA (docs/organizers/API.md §15 y §16).
 * Reglas puras: corren en el dispositivo antes de encolar y otra vez en la Edge antes de core.commit. El ámbito por reserva
 * lo comprueba además el gancho `organizers.validate_batch` en la base de datos.
 */

export const TABLES = {
  experiences: 'organizers.experiences',
  materials: 'organizers.materials',
  questions: 'organizers.questions',
  answers: 'organizers.answers',
  offers: 'organizers.offers',
} as const;
export const ALL_TABLES = Object.values(TABLES);

export const WINDOWS = ['before', 'during', 'after', 'always'] as const;
export const LODGING_CAPABILITIES = ['view', 'prefer', 'choose', 'request'] as const;
export const MATERIAL_KINDS = ['file', 'link', 'text'] as const;
export const QUESTION_TYPES = ['text', 'choice', 'multi', 'yes_no', 'number', 'date'] as const;
/** Sin SVG (puede llevar código): el logotipo, en PNG o WebP (decisión de Core del 8-10-2026). */
export const MATERIAL_MIME = ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'];
export const MATERIAL_MAX_BYTES = 15 * 1024 * 1024;

export type Window = (typeof WINDOWS)[number];
export type QuestionType = (typeof QUESTION_TYPES)[number];

export interface DomainOperation {
  op: string;
  table?: string;
  id?: string;
  fields?: Record<string, unknown>;
}

export interface Issue {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

/** Reservas del ámbito del organizador (`scopes.grants` de su pertenencia). */
export function grantedReservations(membership: { scopes?: unknown } | null | undefined): Set<string> {
  const grants = (membership?.scopes as { grants?: Array<{ reservation_id?: unknown }> } | null | undefined)?.grants;
  return new Set((Array.isArray(grants) ? grants : []).map((g) => String(g?.reservation_id ?? '')).filter(Boolean));
}

/** Tablas con biblioteca del organizador: sus materiales y preguntas le acompañan a sus próximos retiros. */
export const OWNED_TABLES: readonly string[] = [TABLES.materials, TABLES.questions];

/**
 * Una fila de Organizers se ve si su reserva está en el ámbito o, en materiales y preguntas, si la creó esa persona
 * (decisión del usuario del 8-10-2026: se conservan para sus próximos retiros). Lo que no es de Organizers, como siempre.
 */
export function visibleRow(table: string, row: Record<string, unknown>, membership: { scopes?: unknown } | null | undefined, userId?: string | null): boolean {
  if (!table.startsWith('organizers.')) return true;
  if (userId && OWNED_TABLES.includes(table) && row.owner_id === userId) return true;
  return grantedReservations(membership).has(String(row.reservation_id ?? ''));
}

type Spec =
  | { kind: 'text'; max: number; min?: number; nullable?: boolean; https?: boolean }
  | { kind: 'enum'; values: readonly string[]; nullable?: boolean }
  | { kind: 'boolean' }
  | { kind: 'uuid'; nullable?: boolean; file?: boolean }
  | { kind: 'date'; nullable?: boolean }
  | { kind: 'number'; nullable?: boolean; min?: number; integer?: boolean }
  | { kind: 'options'; max: number; shape: 'choice' | 'lodging' };

const WRITABLE: Record<string, { fields: Record<string, Spec>; required: string[] }> = {
  [TABLES.experiences]: {
    fields: {
      reservation_id: { kind: 'uuid' },
      program_visible: { kind: 'boolean' }, program_window: { kind: 'enum', values: WINDOWS },
      menu_visible: { kind: 'boolean' }, menu_window: { kind: 'enum', values: WINDOWS },
      materials_visible: { kind: 'boolean' }, questions_visible: { kind: 'boolean' },
      lodging_visible: { kind: 'boolean' }, lodging_capability: { kind: 'enum', values: LODGING_CAPABILITIES },
      lodging_choose_until: { kind: 'date', nullable: true }, lodging_options: { kind: 'options', max: 12, shape: 'lodging' },
      map_visible: { kind: 'boolean' },
      organizer_message: { kind: 'text', max: 1000, nullable: true }, message_lang: { kind: 'enum', values: ['es', 'en'], nullable: true },
    },
    required: ['reservation_id'],
  },
  [TABLES.materials]: {
    fields: {
      reservation_id: { kind: 'uuid' }, owner_id: { kind: 'uuid' }, kind: { kind: 'enum', values: MATERIAL_KINDS },
      title: { kind: 'text', min: 1, max: 160 }, description: { kind: 'text', max: 1000, nullable: true },
      file_id: { kind: 'uuid', nullable: true, file: true }, url: { kind: 'text', max: 600, nullable: true, https: true },
      body: { kind: 'text', max: 4000, nullable: true }, is_logo: { kind: 'boolean' }, published: { kind: 'boolean' },
      window: { kind: 'enum', values: WINDOWS }, position: { kind: 'number' },
    },
    required: ['reservation_id', 'owner_id', 'kind', 'title'],
  },
  [TABLES.questions]: {
    fields: {
      reservation_id: { kind: 'uuid' }, owner_id: { kind: 'uuid' }, type: { kind: 'enum', values: QUESTION_TYPES },
      label: { kind: 'text', min: 1, max: 300 }, help: { kind: 'text', max: 600, nullable: true },
      options: { kind: 'options', max: 12, shape: 'choice' }, required: { kind: 'boolean' },
      opens_at: { kind: 'date', nullable: true }, closes_at: { kind: 'date', nullable: true },
      published: { kind: 'boolean' }, position: { kind: 'number' },
    },
    required: ['reservation_id', 'owner_id', 'type', 'label'],
  },
  [TABLES.offers]: {
    fields: {
      reservation_id: { kind: 'uuid' }, name: { kind: 'text', min: 1, max: 120 }, description: { kind: 'text', max: 600, nullable: true },
      price: { kind: 'number', min: 0 }, includes: { kind: 'text', max: 600, nullable: true },
      capacity: { kind: 'number', nullable: true, min: 0, integer: true }, expected: { kind: 'number', nullable: true, min: 0, integer: true },
      available_from: { kind: 'date', nullable: true }, available_until: { kind: 'date', nullable: true },
      on_poster: { kind: 'boolean' }, position: { kind: 'number' },
    },
    required: ['reservation_id', 'name', 'price'],
  },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const isBlob = (v: unknown) => !!v && typeof v === 'object' && typeof (v as { $blob?: unknown }).$blob === 'string';
const str = (v: unknown) => typeof v === 'string';

function fieldProblem(spec: Spec, value: unknown): string | null {
  if (value === null || value === undefined) {
    return ('nullable' in spec && spec.nullable) || spec.kind === 'options' ? null : 'es obligatorio';
  }
  switch (spec.kind) {
    case 'text':
      if (!str(value)) return 'debe ser texto';
      if ((value as string).trim().length < (spec.min ?? 0)) return 'es obligatorio';
      if ((value as string).length > spec.max) return `admite hasta ${spec.max} caracteres`;
      if (spec.https && !/^https:\/\/\S+$/.test(value as string)) return 'debe empezar por https://';
      return null;
    case 'enum': return spec.values.includes(value as string) ? null : 'no es un valor admitido';
    case 'boolean': return typeof value === 'boolean' ? null : 'debe ser sí o no';
    case 'uuid': return (str(value) && UUID.test(value as string)) || (spec.file && isBlob(value)) ? null : 'no es un identificador válido';
    case 'date': return str(value) && DATE.test(value as string) ? null : 'debe ser una fecha';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'debe ser un número';
      if (spec.min !== undefined && value < spec.min) return `debe ser ${spec.min} o más`;
      if (spec.integer && !Number.isInteger(value)) return 'debe ser un número entero';
      return null;
    case 'options': {
      if (!Array.isArray(value)) return 'debe ser una lista';
      if (value.length > spec.max) return `admite hasta ${spec.max} opciones`;
      const keys = new Set<string>();
      for (const item of value) {
        const o = item as Record<string, unknown>;
        const key = spec.shape === 'choice' ? o?.value : o?.key;
        if (!o || typeof o !== 'object' || !str(key) || !(key as string).trim() || (key as string).length > 60) return 'tiene una opción sin clave';
        if (!str(o.label) || !(o.label as string).trim() || (o.label as string).length > 120) return 'tiene una opción sin texto';
        if (spec.shape === 'lodging' && o.guest_note !== undefined && o.guest_note !== null && (!str(o.guest_note) || (o.guest_note as string).length > 200)) return 'tiene una nota demasiado larga';
        if (keys.has(key as string)) return 'tiene opciones repetidas';
        keys.add(key as string);
      }
      return null;
    }
  }
}

/**
 * Valida un lote del organizador. `current` da la fila que hay (para los cambios parciales); en la Edge se omite y la base
 * de datos completa la comprobación con sus checks y el gancho de ámbito.
 */
export function validateOperations(
  operations: DomainOperation[],
  membership: { role?: string; scopes?: unknown } | null | undefined,
  current: (table: string, id: string) => Record<string, unknown> | undefined = () => undefined,
  userId?: string | null,
): Issue | null {
  const granted = grantedReservations(membership);
  for (const op of operations) {
    if (op.op === 'call') return { code: 'FORBIDDEN', message: 'Organizers no admite procedimientos en sus lotes.', details: {} };
    const table = op.table ?? '';
    if (table === TABLES.answers) return { code: 'FORBIDDEN', message: 'Las respuestas las escribe cada asistente desde su portal.', details: { table } };
    const spec = WRITABLE[table];
    if (!spec) return { code: 'INVALID_OPERATION', message: 'Tabla desconocida.', details: { table } };
    if (op.op === 'delete' || op.op === 'restore') continue;
    const fields = op.fields ?? {};
    for (const [key, value] of Object.entries(fields)) {
      const f = spec.fields[key];
      if (!f) return { code: 'INVALID_FIELDS', message: `Campo ${key} no se puede escribir.`, details: { table, field: key } };
      const problem = fieldProblem(f, value);
      if (problem) return { code: 'INVALID_FIELDS', message: `Campo ${key} ${problem}.`, details: { table, field: key } };
    }
    if (op.op === 'insert') {
      for (const key of spec.required) if (fields[key] === undefined || fields[key] === null) return { code: 'INVALID_FIELDS', message: `Campo ${key} es obligatorio.`, details: { table, field: key } };
      if (!granted.has(String(fields.reservation_id))) return { code: 'OUT_OF_SCOPE', message: 'Ese retiro no es tuyo.', details: { reservation_id: fields.reservation_id } };
      if (userId && OWNED_TABLES.includes(table) && fields.owner_id !== userId) return { code: 'INVALID_FIELDS', message: 'Campo owner_id debe ser quien lo crea.', details: { table, field: 'owner_id' } };
    } else {
      for (const key of ['reservation_id', 'owner_id']) {
        if (!(key in fields)) continue;
        const before = current(table, op.id ?? '');
        if (!before || before[key] !== fields[key]) return { code: 'IMMUTABLE_FIELD', message: `Campo ${key} no cambia.`, details: { table, field: key } };
      }
    }
    const row = { ...(current(table, op.id ?? '') ?? {}), ...fields };
    if (table === TABLES.materials && row.kind !== undefined) {
      const need = row.kind === 'file' ? 'file_id' : row.kind === 'link' ? 'url' : 'body';
      if (row[need] === null || row[need] === undefined || row[need] === '') return { code: 'INVALID_FIELDS', message: `Campo ${need} es obligatorio.`, details: { table, field: need } };
    }
    if (table === TABLES.questions) {
      if ((row.type === 'choice' || row.type === 'multi') && (!Array.isArray(row.options) || row.options.length < 2)) {
        return { code: 'INVALID_FIELDS', message: 'Campo options necesita al menos dos opciones.', details: { table, field: 'options' } };
      }
      if (str(row.opens_at) && str(row.closes_at) && (row.closes_at as string) < (row.opens_at as string)) {
        return { code: 'INVALID_FIELDS', message: 'Campo closes_at es anterior a la apertura.', details: { table, field: 'closes_at' } };
      }
    }
  }
  return null;
}

/** Ventana actual de un retiro por sus fechas (hora de Madrid, `AAAA-MM-DD`). */
export function currentWindow(today: string, start: string | null, end: string | null): Exclude<Window, 'always'> {
  if (!start || today < start) return 'before';
  if (!end || today <= end) return 'during';
  return 'after';
}

/** Valor legible de una respuesta para la tabla y el CSV. */
export function answerText(type: string, value: unknown, options: Array<{ value: string; label: string }> = [], yes = 'Sí', no = 'No'): string {
  if (value === null || value === undefined) return '';
  const label = (v: unknown) => options.find((o) => o.value === v)?.label ?? String(v);
  if (type === 'yes_no') return value === true ? yes : value === false ? no : '';
  if (type === 'choice') return label(value);
  if (type === 'multi') return Array.isArray(value) ? value.map(label).join(', ') : '';
  return String(value);
}

/** CSV con `;` (Excel en español), comillas dobles y BOM para los acentos. */
export function toCsv(rows: string[][]): string {
  const cell = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n') + '\r\n';
}

/**
 * O7 (Guests §13.6): las preguntas del organizador no piden salud, alergias ni documentos, porque eso lo recoge Ikisai con
 * su consentimiento. Aviso en el editor si el texto lo parece (no bloquea: es orientativo).
 */
const SENSITIVE = /alerg|intoleran|celiac|cel[ií]ac|salud|enfermedad|m[eé]dic|medicaci|tratamiento|discapacidad|embaraz|lesi[oó]n|diagn[oó]stic|\bdni\b|\bnie\b|pasaporte|documento de identidad|allerg|intoleran|coeliac|celiac|health|illness|medic|disabilit|pregnan|injur|passport|id card|identity document/i;
export function sensitiveQuestion(text: string): boolean {
  return SENSITIVE.test(text);
}
