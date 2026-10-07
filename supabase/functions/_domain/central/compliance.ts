/**
 * Ikisai Central · cumplimiento (C09; docs/central/API.md §2.4–2.6 y §3.2): listas cerradas, siguiente vencimiento de
 * una obligación periódica y vencimientos unificados (obligaciones, documentos clave y documentación de personas).
 */
import { dueState, type DueState } from './people.ts';

export const COMPLIANCE_TABLES = {
  requirements: 'central.requirements',
  keyDocuments: 'central.key_documents',
  requirementTasks: 'central.requirement_tasks',
} as const;

export const REQUIREMENT_TYPES = ['concesion', 'licencia_autorizacion', 'seguro', 'laboral_ss', 'prl', 'proteccion_datos', 'garantia',
  'entrega_recepcion', 'revision_tecnica', 'documentacion_contractual', 'cumplimiento_operativo', 'subvencion_ayuda_publica',
  'licitacion_concesion', 'reversion', 'otro'] as const;
export const REQUIREMENT_STATUSES = ['pendiente', 'en_revision', 'cumplido', 'bloqueado', 'no_aplica', 'cerrado'] as const;
export const FREQUENCIES = ['unica', 'mensual', 'trimestral', 'semestral', 'anual', 'bienal', 'trienal', 'quinquenal', 'otra'] as const;
export const RISKS = ['bajo', 'medio', 'alto', 'critico'] as const;
export const IMPACTS = ['legal', 'administrativo', 'economico', 'operativo', 'reputacional', 'mixto'] as const;
export const DOCUMENT_KINDS = ['contrato', 'anexo', 'poliza', 'certificado', 'licencia', 'autorizacion', 'acta', 'inventario', 'protocolo',
  'justificante_pago', 'factura', 'resolucion', 'memoria_justificativa', 'requerimiento', 'otro'] as const;
export const KEY_DOCUMENT_STATUSES = ['vigente', 'pendiente', 'en_revision', 'sustituido'] as const;

export type RequirementType = typeof REQUIREMENT_TYPES[number];
export type RequirementStatus = typeof REQUIREMENT_STATUSES[number];
export type Frequency = typeof FREQUENCIES[number];
export type Risk = typeof RISKS[number];

export const REQUIREMENT_TYPE_LABELS: Record<RequirementType, string> = {
  concesion: 'Concesión', licencia_autorizacion: 'Licencia o autorización', seguro: 'Seguro', laboral_ss: 'Laboral y Seguridad Social',
  prl: 'Prevención de riesgos', proteccion_datos: 'Protección de datos', garantia: 'Garantía', entrega_recepcion: 'Entrega y recepción',
  revision_tecnica: 'Revisión técnica', documentacion_contractual: 'Documentación contractual', cumplimiento_operativo: 'Cumplimiento operativo',
  subvencion_ayuda_publica: 'Subvención o ayuda pública', licitacion_concesion: 'Licitación de la concesión', reversion: 'Reversión', otro: 'Otro',
};
export const REQUIREMENT_STATUS_LABELS: Record<RequirementStatus, string> = {
  pendiente: 'Pendiente', en_revision: 'En revisión', cumplido: 'Cumplido', bloqueado: 'Bloqueado', no_aplica: 'No aplica', cerrado: 'Cerrado',
};
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  unica: 'Una vez', mensual: 'Mensual', trimestral: 'Trimestral', semestral: 'Semestral', anual: 'Anual', bienal: 'Cada 2 años',
  trienal: 'Cada 3 años', quinquenal: 'Cada 5 años', otra: 'Otra (meses)',
};
export const RISK_LABELS: Record<Risk, string> = { bajo: 'Bajo', medio: 'Medio', alto: 'Alto', critico: 'Crítico' };
export const IMPACT_LABELS: Record<string, string> = {
  legal: 'Legal', administrativo: 'Administrativo', economico: 'Económico', operativo: 'Operativo', reputacional: 'Reputacional', mixto: 'Mixto',
};
export const DOCUMENT_KIND_LABELS: Record<string, string> = {
  contrato: 'Contrato', anexo: 'Anexo', poliza: 'Póliza', certificado: 'Certificado', licencia: 'Licencia', autorizacion: 'Autorización',
  acta: 'Acta', inventario: 'Inventario', protocolo: 'Protocolo', justificante_pago: 'Justificante de pago', factura: 'Factura',
  resolucion: 'Resolución', memoria_justificativa: 'Memoria justificativa', requerimiento: 'Requerimiento', otro: 'Otro',
};
export const KEY_DOCUMENT_STATUS_LABELS: Record<string, string> = { vigente: 'Vigente', pendiente: 'Pendiente', en_revision: 'En revisión', sustituido: 'Sustituido' };

/** Estados de una obligación que ya no vencen. */
export const CLOSED_REQUIREMENT_STATUSES: readonly string[] = ['no_aplica', 'cerrado'];

const FREQUENCY_MONTHS: Record<Frequency, number | null> = {
  unica: null, mensual: 1, trimestral: 3, semestral: 6, anual: 12, bienal: 24, trienal: 36, quinquenal: 60, otra: null,
};

/** Suma meses a una fecha `AAAA-MM-DD`; si el día no existe en el mes de destino, el último día del mes (31/01 + 1 → 28/02). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Siguiente vencimiento de una obligación periódica al cumplirla en `reference` (API.md §2.4); null si es única. */
export function nextExpiry(reference: string, frequency: string, frequencyMonths?: number | null): string | null {
  const months = frequency === 'otra' ? (frequencyMonths ?? null) : FREQUENCY_MONTHS[frequency as Frequency] ?? null;
  return months ? addMonths(reference, months) : null;
}

export interface DueItem {
  source: 'requirement' | 'key_document' | 'person_record';
  id: string;
  /** Persona (registros de documentación) u obligación (documentos) a la que pertenece. */
  parentId: string | null;
  code: string | null;
  title: string;
  dueOn: string;
  daysLeft: number;
  state: Exclude<DueState, 'al_dia'>;
  risk: string | null;
  blocksOperation: boolean;
}

type Row = Record<string, unknown>;

/**
 * Vencimientos unificados (C09 «vencimientos» + C05 documentación): lo vencido y lo que vence dentro de su antelación,
 * ordenado por fecha. `personRecords` solo debe traer lo que quien mira puede ver.
 */
export function dueItems(input: { requirements: Row[]; keyDocuments: Row[]; personRecords?: Row[]; peopleNames?: Map<string, string>; recordLabel?: (row: Row) => string }, today: string): DueItem[] {
  const out: DueItem[] = [];
  const days = (d: string) => Math.round((Date.parse(d + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86_400_000);
  for (const r of input.requirements) {
    if (r.deleted_at || !r.expires_on) continue;
    const state = dueState(String(r.expires_on), today, Number(r.notice_days ?? 30), CLOSED_REQUIREMENT_STATUSES.includes(String(r.status)));
    if (state === 'al_dia') continue;
    out.push({ source: 'requirement', id: String(r.id), parentId: null, code: (r.code as string) ?? null, title: String(r.name), dueOn: String(r.expires_on),
      daysLeft: days(String(r.expires_on)), state, risk: String(r.risk ?? 'medio'), blocksOperation: r.blocks_operation === true });
  }
  for (const d of input.keyDocuments) {
    if (d.deleted_at || !d.expires_on) continue;
    const state = dueState(String(d.expires_on), today, 30, d.status === 'sustituido');
    if (state === 'al_dia') continue;
    out.push({ source: 'key_document', id: String(d.id), parentId: (d.requirement_id as string) ?? null, code: (d.code as string) ?? null, title: String(d.name),
      dueOn: String(d.expires_on), daysLeft: days(String(d.expires_on)), state, risk: null, blocksOperation: false });
  }
  for (const p of input.personRecords ?? []) {
    if (p.deleted_at || !p.expires_on) continue;
    const state = dueState(String(p.expires_on), today, 30, p.status === 'no_aplica');
    if (state === 'al_dia') continue;
    const person = input.peopleNames?.get(String(p.person_id));
    if (input.peopleNames && person === undefined) continue; // persona en la papelera
    out.push({ source: 'person_record', id: String(p.id), parentId: String(p.person_id), code: null,
      title: `${input.recordLabel ? input.recordLabel(p) : String(p.record_type)}${person ? ` · ${person}` : ''}`,
      dueOn: String(p.expires_on), daysLeft: days(String(p.expires_on)), state, risk: null, blocksOperation: false });
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn) || a.title.localeCompare(b.title, 'es'));
}

/** Referencia estable de la tarea pedida a Tasks: el código de la obligación más el lote que la pide (reintentos idempotentes). */
export function taskExternalRef(code: string, requestId: string): string {
  return `${code}:${requestId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 36)}`;
}

/** Tipo de la petición a Tasks (ronda 4 de Core: `kind` `central.<tipo>`, sin área ni proyecto). */
export const TASK_KIND = 'central.compliance_due';
export const TASK_KIND_LABEL = 'Cumplimiento: obligación que vence';
