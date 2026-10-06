/**
 * Validador del documento `ikisai.invoice.v1` (03_IKISAI_INVOICE_IMPORT_V1.schema.json del handoff),
 * escrito a mano para no depender de una librería de JSON Schema en la Edge ni en el navegador.
 * Reproduce el schema al pie de la letra: `additionalProperties: false` en todos los objetos, obligatorios,
 * tipos, enumeraciones, `minItems: 1` en `lines`, `minLength: 1`, rangos de `confidence`.
 */
import { DEDUCTIBILITIES, ITEM_TYPES, TAX_TYPES, type Deductibility, type ItemType, type TaxType } from './types.ts';

export const IMPORT_SCHEMA_VERSION = 'ikisai.invoice.v1';

export interface ImportInvoice {
  invoice_date: string;
  supplier_name: string;
  supplier_tax_id?: string | null;
  invoice_number?: string | null;
  object: string;
  currency: string;
  deductibility_suggestion?: Deductibility | null;
  notes?: string | null;
}

export interface ImportLine {
  description: string;
  quantity?: number | null;
  unit?: string | null;
  unit_price?: number | null;
  discount_amount?: number | null;
  net_amount: number;
  vat_rate?: number | null;
  vat_amount?: number | null;
  gross_amount?: number | null;
  suggested_item_type?: ItemType | null;
  suggested_match_name?: string | null;
  confidence?: number | null;
  notes?: string | null;
}

export interface ImportTax {
  tax_type: TaxType;
  rate?: number | null;
  taxable_base?: number | null;
  amount: number;
  notes?: string | null;
}

export interface ImportTotals {
  base: number;
  vat: number;
  withholding: number;
  total: number;
}

export interface ImportDocument {
  schema_version: typeof IMPORT_SCHEMA_VERSION;
  invoice: ImportInvoice;
  lines: ImportLine[];
  taxes: ImportTax[];
  document_totals: ImportTotals;
  extraction_notes?: string | null;
  overall_confidence?: number | null;
}

export interface SchemaError {
  path: string;
  reason: string;
}

export type ImportValidation = { ok: true; document: ImportDocument } | { ok: false; errors: SchemaError[] };

type Kind = 'string' | 'number' | 'object' | 'array';

interface Field {
  required?: boolean;
  types: Kind[];
  nullable?: boolean;
  minLength?: number;
  min?: number;
  max?: number;
  enum?: readonly string[];
  const?: string;
}

const INVOICE_FIELDS: Record<string, Field> = {
  invoice_date: { required: true, types: ['string'], minLength: 1 },
  supplier_name: { required: true, types: ['string'], minLength: 1 },
  supplier_tax_id: { types: ['string'], nullable: true },
  invoice_number: { types: ['string'], nullable: true },
  object: { required: true, types: ['string'], minLength: 1 },
  currency: { required: true, types: ['string'] },
  deductibility_suggestion: { types: ['string'], nullable: true, enum: DEDUCTIBILITIES },
  notes: { types: ['string'], nullable: true },
};

const LINE_FIELDS: Record<string, Field> = {
  description: { required: true, types: ['string'] },
  quantity: { types: ['number'], nullable: true },
  unit: { types: ['string'], nullable: true },
  unit_price: { types: ['number'], nullable: true },
  discount_amount: { types: ['number'], nullable: true },
  net_amount: { required: true, types: ['number'] },
  vat_rate: { types: ['number'], nullable: true },
  vat_amount: { types: ['number'], nullable: true },
  gross_amount: { types: ['number'], nullable: true },
  suggested_item_type: { types: ['string'], nullable: true, enum: ITEM_TYPES },
  suggested_match_name: { types: ['string'], nullable: true },
  confidence: { types: ['number'], nullable: true, min: 0, max: 1 },
  notes: { types: ['string'], nullable: true },
};

const TAX_FIELDS: Record<string, Field> = {
  tax_type: { required: true, types: ['string'], enum: TAX_TYPES },
  rate: { types: ['number'], nullable: true },
  taxable_base: { types: ['number'], nullable: true },
  amount: { required: true, types: ['number'] },
  notes: { types: ['string'], nullable: true },
};

const TOTALS_FIELDS: Record<string, Field> = {
  base: { required: true, types: ['number'] },
  vat: { required: true, types: ['number'] },
  withholding: { required: true, types: ['number'] },
  total: { required: true, types: ['number'] },
};

const ROOT_FIELDS: Record<string, Field> = {
  schema_version: { required: true, types: ['string'], const: IMPORT_SCHEMA_VERSION },
  invoice: { required: true, types: ['object'] },
  lines: { required: true, types: ['array'] },
  taxes: { required: true, types: ['array'] },
  document_totals: { required: true, types: ['object'] },
  extraction_notes: { types: ['string'], nullable: true },
  overall_confidence: { types: ['number'], nullable: true, min: 0, max: 1 },
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function kindOf(value: unknown): Kind | 'null' | 'other' {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number') return Number.isFinite(value) ? 'number' : 'other';
  if (typeof value === 'object') return 'object';
  return 'other';
}

function checkObject(value: unknown, fields: Record<string, Field>, path: string, errors: SchemaError[]): value is Record<string, unknown> {
  if (kindOf(value) !== 'object') {
    errors.push({ path, reason: 'debe ser un objeto' });
    return false;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in fields) && obj[key] !== undefined) errors.push({ path: `${path}.${key}`, reason: 'propiedad no permitida por el schema' });
  }
  for (const [key, field] of Object.entries(fields)) {
    const here = `${path}.${key}`;
    if (!(key in obj) || obj[key] === undefined) {
      if (field.required) errors.push({ path: here, reason: 'obligatorio' });
      continue;
    }
    const v = obj[key];
    const kind = kindOf(v);
    if (kind === 'null') {
      if (!field.nullable) errors.push({ path: here, reason: 'no admite null' });
      continue;
    }
    if (kind === 'other' || !field.types.includes(kind)) {
      errors.push({ path: here, reason: `tipo inválido (se espera ${field.types.join(' | ')})` });
      continue;
    }
    if (field.const !== undefined && v !== field.const) errors.push({ path: here, reason: `debe ser "${field.const}"` });
    if (field.enum && !field.enum.includes(v as string)) errors.push({ path: here, reason: `valor fuera de la lista (${field.enum.join(', ')})` });
    if (field.minLength !== undefined && (v as string).length < field.minLength) errors.push({ path: here, reason: 'no puede estar vacío' });
    if (field.min !== undefined && (v as number) < field.min) errors.push({ path: here, reason: `mínimo ${field.min}` });
    if (field.max !== undefined && (v as number) > field.max) errors.push({ path: here, reason: `máximo ${field.max}` });
  }
  return true;
}

/** Valida un valor cualquiera (ya parseado) contra el schema `ikisai.invoice.v1`. */
export function validateImportDocument(value: unknown): ImportValidation {
  const errors: SchemaError[] = [];
  if (!checkObject(value, ROOT_FIELDS, '$', errors)) return { ok: false, errors };
  const root = value as Record<string, unknown>;
  if (checkObject(root.invoice, INVOICE_FIELDS, '$.invoice', errors)) {
    const inv = root.invoice as Record<string, unknown>;
    if (typeof inv.invoice_date === 'string' && !ISO_DATE.test(inv.invoice_date)) errors.push({ path: '$.invoice.invoice_date', reason: 'fecha con formato AAAA-MM-DD' });
    else if (typeof inv.invoice_date === 'string' && Number.isNaN(Date.parse(inv.invoice_date + 'T00:00:00Z'))) errors.push({ path: '$.invoice.invoice_date', reason: 'fecha inválida' });
  }
  if (Array.isArray(root.lines)) {
    if (root.lines.length === 0) errors.push({ path: '$.lines', reason: 'debe tener al menos una línea' });
    root.lines.forEach((line, index) => checkObject(line, LINE_FIELDS, `$.lines[${index}]`, errors));
  }
  if (Array.isArray(root.taxes)) root.taxes.forEach((tax, index) => checkObject(tax, TAX_FIELDS, `$.taxes[${index}]`, errors));
  checkObject(root.document_totals, TOTALS_FIELDS, '$.document_totals', errors);
  if (errors.length) return { ok: false, errors };
  return { ok: true, document: value as unknown as ImportDocument };
}

/** Parsea texto JSON y valida; los errores de sintaxis se devuelven como error de schema en `$`. */
export function parseImportDocument(text: string): ImportValidation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [{ path: '$', reason: 'JSON inválido: ' + (error as Error).message }] };
  }
  return validateImportDocument(value);
}

/** SHA-256 en hexadecimal del documento serializado de forma canónica (claves ordenadas). */
export async function importDocumentSha256(document: ImportDocument): Promise<string> {
  const bytes = new TextEncoder().encode(stableStringify(document));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON con claves ordenadas recursivamente (misma forma en cliente y servidor). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}
