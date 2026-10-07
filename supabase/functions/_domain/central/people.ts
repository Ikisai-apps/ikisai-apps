/**
 * Ikisai Central · personas (docs/central/API.md §2.1–2.3, §3.2 y §5).
 * Listas cerradas, etiquetas, visibilidad de los datos reservados y estado derivado de la documentación.
 */

export const TABLES = {
  people: 'central.people',
  personPrivate: 'central.person_private',
  personRecords: 'central.person_records',
} as const;

/** Tablas reservadas: solo owner, o editor con ámbito `people`. */
export const RESERVED_TABLES: readonly string[] = [TABLES.personPrivate, TABLES.personRecords];

export const RELATIONS = ['equipo', 'colaborador', 'voluntario', 'practicas', 'otro'] as const;
export const BASE_ROLES = ['direccion_general', 'direccion_operativa_comercial', 'cocina', 'mantenimiento_logistica', 'limpieza',
  'apoyo_tecnico_sonido', 'apoyo_implantacion_alojativa', 'refuerzo_eventual', 'otro'] as const;
export const COVERAGES = ['todo', 'solo_eventos', 'solo_mantenimiento', 'solo_cocina', 'solo_limpieza', 'solo_tecnico', 'solo_comercial'] as const;
export const AVAILABILITIES = ['alta', 'media', 'baja', 'segun_calendario', 'no_disponible'] as const;
export const ENGAGEMENTS = ['contrato_indefinido', 'contrato_temporal', 'autonomo', 'colaborador_externo', 'apoyo_puntual', 'voluntariado', 'sin_vinculo'] as const;
export const RECORD_KINDS = ['documento', 'formacion'] as const;
export const DOCUMENT_TYPES = ['contrato_o_vinculo', 'alta_ss_o_reta', 'datos_fiscales', 'prl_basico', 'certificado_delitos_sexuales', 'otro_documento'] as const;
export const TRAINING_TYPES = ['manipulador_alimentos', 'prl_basico', 'primeros_auxilios', 'socorrismo', 'otra_formacion'] as const;
export const RECORD_STATUSES = ['ok', 'pendiente', 'en_revision', 'no_aplica'] as const;
/** Tipos que exigen un título propio. */
export const FREE_RECORD_TYPES: readonly string[] = ['otro_documento', 'otra_formacion'];

export type Relation = typeof RELATIONS[number];
export type BaseRole = typeof BASE_ROLES[number];
export type Coverage = typeof COVERAGES[number];
export type Availability = typeof AVAILABILITIES[number];
export type Engagement = typeof ENGAGEMENTS[number];
export type RecordKind = typeof RECORD_KINDS[number];
export type RecordStatus = typeof RECORD_STATUSES[number];

export const RELATION_LABELS: Record<Relation, string> = {
  equipo: 'Equipo', colaborador: 'Colaborador', voluntario: 'Voluntariado', practicas: 'Prácticas', otro: 'Otra',
};
export const BASE_ROLE_LABELS: Record<BaseRole, string> = {
  direccion_general: 'Dirección general', direccion_operativa_comercial: 'Dirección operativa y comercial', cocina: 'Cocina',
  mantenimiento_logistica: 'Mantenimiento y logística', limpieza: 'Limpieza', apoyo_tecnico_sonido: 'Apoyo técnico y sonido',
  apoyo_implantacion_alojativa: 'Apoyo de alojamiento', refuerzo_eventual: 'Refuerzo eventual', otro: 'Otra función',
};
export const COVERAGE_LABELS: Record<Coverage, string> = {
  todo: 'Todo', solo_eventos: 'Solo eventos', solo_mantenimiento: 'Solo mantenimiento', solo_cocina: 'Solo cocina',
  solo_limpieza: 'Solo limpieza', solo_tecnico: 'Solo técnico', solo_comercial: 'Solo comercial',
};
export const AVAILABILITY_LABELS: Record<Availability, string> = {
  alta: 'Alta', media: 'Media', baja: 'Baja', segun_calendario: 'Según calendario', no_disponible: 'No disponible',
};
export const ENGAGEMENT_LABELS: Record<Engagement, string> = {
  contrato_indefinido: 'Contrato indefinido', contrato_temporal: 'Contrato temporal', autonomo: 'Autónomo',
  colaborador_externo: 'Colaborador externo', apoyo_puntual: 'Apoyo puntual', voluntariado: 'Voluntariado', sin_vinculo: 'Sin vínculo',
};
export const RECORD_TYPE_LABELS: Record<string, string> = {
  contrato_o_vinculo: 'Contrato o vínculo', alta_ss_o_reta: 'Alta en la Seguridad Social o RETA', datos_fiscales: 'Datos fiscales',
  prl_basico: 'PRL básico', certificado_delitos_sexuales: 'Certificado de delitos sexuales', otro_documento: 'Otro documento',
  manipulador_alimentos: 'Manipulador de alimentos', primeros_auxilios: 'Primeros auxilios', socorrismo: 'Socorrismo', otra_formacion: 'Otra formación',
};
export const RECORD_STATUS_LABELS: Record<RecordStatus, string> = { ok: 'Correcto', pendiente: 'Pendiente', en_revision: 'En revisión', no_aplica: 'No aplica' };

export function recordTypesFor(kind: RecordKind): readonly string[] {
  return kind === 'documento' ? DOCUMENT_TYPES : TRAINING_TYPES;
}

/** Ámbitos de Central (`core.memberships.scopes`): `{people: true}` abre los datos reservados a un editor. */
export function canSeeReserved(membership: { role: string; scopes?: unknown } | null | undefined): boolean {
  if (!membership) return false;
  if (membership.role === 'owner') return true;
  const scopes = membership.scopes as { people?: unknown } | null | undefined;
  return membership.role === 'editor' && scopes?.people === true;
}

/** Hook `visible` de central-api: las tablas reservadas solo para quien puede verlas. */
export function visibleRow(table: string, membership: { role: string; scopes?: unknown }): boolean {
  return !RESERVED_TABLES.includes(table) || canSeeReserved(membership);
}

export type DueState = 'vencido' | 'por_vencer' | 'al_dia';

/** Días entre dos fechas `AAAA-MM-DD` (b − a), sin husos horarios. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

/**
 * Estado derivado de una fecha de caducidad (API.md §3.2). `today` en `AAAA-MM-DD` (hora de Madrid en el cliente).
 * Lo cerrado o que no aplica no vence nunca.
 */
export function dueState(expiresOn: string | null | undefined, today: string, noticeDays = 30, closed = false): DueState {
  if (closed || !expiresOn) return 'al_dia';
  const left = daysBetween(today, expiresOn);
  if (left < 0) return 'vencido';
  return left <= noticeDays ? 'por_vencer' : 'al_dia';
}

export interface RecordLike { kind: string; status: string; expires_on?: string | null; deleted_at?: string | null }

/**
 * Estado documental y de formación de una persona (C05 `estado_documental` / `estado_formacion_minima`):
 * `caducado` si algún registro vivo ha vencido; `pendiente` si alguno está pendiente o en revisión;
 * `no_aplica` si no hay registros de ese tipo; si no, `completo` (documentos) u `ok` (formación).
 */
export function personStatus(records: readonly RecordLike[], today: string): { documents: string; training: string } {
  const summary = (kind: RecordKind, done: string) => {
    const alive = records.filter((r) => r.kind === kind && !r.deleted_at && r.status !== 'no_aplica');
    if (!alive.length) return 'no_aplica';
    if (alive.some((r) => dueState(r.expires_on, today, 0) === 'vencido')) return 'caducado';
    if (alive.some((r) => r.status === 'pendiente' || r.status === 'en_revision')) return 'pendiente';
    return done;
  };
  return { documents: summary('documento', 'completo'), training: summary('formacion', 'ok') };
}

/** Fecha de hoy en Madrid, `AAAA-MM-DD`. */
export function todayInMadrid(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
