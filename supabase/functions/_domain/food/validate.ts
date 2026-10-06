/**
 * Ikisai Food · validación de operaciones de fila (docs/food/API.md §4.1).
 * Reglas puras: corren en el cliente antes de encolar y otra vez en la Edge antes de core.commit.
 * Todo lo que PostgreSQL rechazaría con un check o un error de conversión se rechaza aquí con el campo en `details`.
 */
import { ALLERGENS, DIET_TAGS, EQUIPMENT_STATUSES, RECIPE_CATEGORIES, RECIPE_STATUSES } from './catalog.ts';
import { UNITS } from './units.ts';

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

type FieldSpec =
  | { kind: 'text'; max: number; required?: boolean; nullable?: boolean }
  | { kind: 'enum'; values: readonly string[]; nullable?: boolean }
  | { kind: 'number'; min: number; max: number; exclusiveMin?: boolean; integer?: boolean; nullable?: boolean }
  | { kind: 'boolean' }
  | { kind: 'tags'; values: readonly string[] }
  | { kind: 'uuid'; nullable?: boolean };

interface TableSpec {
  fields: Record<string, FieldSpec>;
  /** Campos que un insert debe traer (los demás tienen valor por defecto o admiten null). */
  required: string[];
  /** Campos que solo se fijan al insertar. */
  insertOnly?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_TEXT = 20000;
const QUANTITY_MAX = 999999999.999; // numeric(12,3)
const SERVINGS_MAX = 999999.99; // numeric(8,2)

const freeText: FieldSpec = { kind: 'text', max: LONG_TEXT, nullable: true };

export const TABLE_SPECS: Record<string, TableSpec> = {
  'food.recipes': {
    required: ['name', 'category', 'base_servings'],
    fields: {
      name: { kind: 'text', max: 160, required: true },
      public_name: { kind: 'text', max: 160, nullable: true },
      public_description: { kind: 'text', max: 600, nullable: true },
      category: { kind: 'enum', values: RECIPE_CATEGORIES },
      base_servings: { kind: 'number', min: 0, exclusiveMin: true, max: SERVINGS_MAX },
      method: freeText,
      conservation: freeText,
      freezable: { kind: 'boolean' },
      regeneration: freeText,
      service_notes: freeText,
      prep_minutes: { kind: 'number', min: 0, max: 2880, integer: true, nullable: true },
      status: { kind: 'enum', values: RECIPE_STATUSES },
      diet_tags: { kind: 'tags', values: DIET_TAGS },
      allergens: { kind: 'tags', values: ALLERGENS },
      allergens_checked: { kind: 'boolean' },
      photo_file_id: { kind: 'uuid', nullable: true },
      photo_thumb_file_id: { kind: 'uuid', nullable: true },
    },
  },
  'food.ingredients': {
    required: ['name'],
    fields: {
      name: { kind: 'text', max: 120, required: true },
      preferred_unit: { kind: 'enum', values: UNITS },
      preferred_supplier: { kind: 'text', max: 120, nullable: true },
      active: { kind: 'boolean' },
    },
  },
  'food.recipe_ingredients': {
    required: ['recipe_id', 'ingredient_id', 'quantity', 'unit'],
    insertOnly: ['recipe_id'],
    fields: {
      recipe_id: { kind: 'uuid' },
      ingredient_id: { kind: 'uuid' },
      quantity: { kind: 'number', min: 0, exclusiveMin: true, max: QUANTITY_MAX },
      unit: { kind: 'enum', values: UNITS },
      position: { kind: 'number', min: -1e9, max: 1e9 },
      notes: freeText,
    },
  },
  'food.equipment': {
    required: ['name'],
    fields: {
      name: { kind: 'text', max: 120, required: true },
      category: { kind: 'text', max: 60, nullable: true },
      quantity: { kind: 'number', min: 0, max: 100000, integer: true },
      capacity: freeText,
      location: freeText,
      status: { kind: 'enum', values: EQUIPMENT_STATUSES },
      notes: freeText,
    },
  },
  'food.recipe_equipment': {
    required: ['recipe_id', 'equipment_id'],
    insertOnly: ['recipe_id'],
    fields: {
      recipe_id: { kind: 'uuid' },
      equipment_id: { kind: 'uuid' },
      quantity_required: { kind: 'number', min: 1, max: 100000, integer: true },
      notes: freeText,
    },
  },
};

function issue(code: string, message: string, details: Record<string, unknown>): Issue {
  return { code, message, details };
}

function checkField(field: string, value: unknown, spec: FieldSpec): string | null {
  if (value === null) {
    return 'nullable' in spec && spec.nullable ? null : 'no admite vacío';
  }
  switch (spec.kind) {
    case 'text':
      if (typeof value !== 'string') return 'debe ser un texto';
      if (spec.required && !value.trim()) return 'es obligatorio';
      if (value.length > spec.max) return `admite como máximo ${spec.max} caracteres`;
      return null;
    case 'enum':
      return typeof value === 'string' && spec.values.includes(value) ? null : 'tiene un valor desconocido';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'debe ser un número';
      if (spec.integer && !Number.isInteger(value)) return 'debe ser un número entero';
      if (value < spec.min || (spec.exclusiveMin && value === spec.min)) return spec.exclusiveMin ? `debe ser mayor que ${spec.min}` : `no puede ser menor que ${spec.min}`;
      if (value > spec.max) return `no puede ser mayor que ${spec.max}`;
      return null;
    case 'boolean':
      return typeof value === 'boolean' ? null : 'debe ser sí o no';
    case 'tags':
      if (!Array.isArray(value)) return 'debe ser una lista';
      if (value.some((v) => typeof v !== 'string' || !spec.values.includes(v))) return 'contiene un valor desconocido';
      if (new Set(value).size !== value.length) return 'contiene valores repetidos';
      return null;
    case 'uuid':
      return typeof value === 'string' && UUID.test(value) ? null : 'debe ser un identificador';
  }
}

/** Valida una operación de fila sobre una tabla de Food. Devuelve el primer problema o `null`. */
export function validateOperation(op: DomainOperation): Issue | null {
  if (op.op !== 'insert' && op.op !== 'update') return null;
  const spec = op.table ? TABLE_SPECS[op.table] : undefined;
  if (!spec) return null; // tabla ajena a este módulo: decide el núcleo
  const fields = op.fields ?? {};
  for (const [field, value] of Object.entries(fields)) {
    const fieldSpec = spec.fields[field];
    if (!fieldSpec) return issue('INVALID_FIELDS', `El campo ${field} no existe o es de solo lectura.`, { table: op.table, field });
    const problem = checkField(field, value, fieldSpec);
    if (problem) {
      const allowed = fieldSpec.kind === 'enum' || fieldSpec.kind === 'tags' ? { allowed: fieldSpec.values } : {};
      return issue('INVALID_FIELDS', `El campo ${field} ${problem}.`, { table: op.table, field, ...allowed });
    }
  }
  if (op.op === 'insert') {
    for (const field of spec.required) {
      if (fields[field] === undefined) return issue('INVALID_FIELDS', `Falta el campo ${field}.`, { table: op.table, field });
    }
  } else {
    for (const field of spec.insertOnly ?? []) {
      if (field in fields) return issue('IMMUTABLE_FIELD', `El campo ${field} no se puede cambiar.`, { table: op.table, field });
    }
  }
  if (op.table === 'food.recipes' && fields.status === 'validada') {
    // En un update que no trae allergens_checked decide el trigger con la fila actual.
    const unchecked = op.op === 'insert' ? fields.allergens_checked !== true : fields.allergens_checked === false;
    if (unchecked) return issue('ALLERGENS_UNCHECKED', 'Revisa los alérgenos antes de validar la receta.', { table: op.table, field: 'allergens_checked' });
  }
  return null;
}

/** Valida un lote. El problema devuelto lleva en `details.index` la posición de la operación. */
export function validateOperations(operations: DomainOperation[]): Issue | null {
  for (let index = 0; index < operations.length; index++) {
    const found = validateOperation(operations[index]!);
    if (found) return { ...found, details: { ...found.details, index } };
  }
  return null;
}
