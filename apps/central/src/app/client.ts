import { createSyncClient, type ApiError, type SyncClient, type TableName } from '@ikisai/sync-client';
import { RESERVED_TABLES } from '@ikisai/domain-central';

export const APP = 'central';

export const T = {
  people: 'central.people',
  personPrivate: 'central.person_private',
  personRecords: 'central.person_records',
  entity: 'central.entity',
  requirements: 'central.requirements',
  keyDocuments: 'central.key_documents',
  requirementTasks: 'central.requirement_tasks',
  kpiTargets: 'central.kpi_targets',
  decisions: 'central.decisions',
  teams: 'central.teams',
  personTeams: 'central.person_teams',
  texts: 'central.texts',
} as const satisfies Record<string, TableName>;

/** Fila del espejo local: `_pending` lo pone el cliente offline mientras el servidor no confirma. */
export type Mirror<Row> = Row & { _pending?: boolean; [column: string]: unknown };

export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    tables: Object.values(T),
    pullIntervalMs: 30_000,
    // Datos reservados de personas: fuera del dispositivo al cerrar sesión (API.md §5.3).
    clearOnLogout: [...RESERVED_TABLES] as TableName[],
  });
}

/** Mensaje legible en español para un error de la API, de red o de las reglas de Central. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string; details?: Record<string, unknown> };
  const code = typeof e?.code === 'string' ? e.code : '';
  switch (code) {
    case 'LOGIN_FAILED': return 'Correo o contraseña incorrectos.';
    case 'NETWORK': return 'No hay conexión con el servidor.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED': return 'La sesión ha caducado. Vuelve a iniciar sesión.';
    case 'FORBIDDEN': return 'Tu cuenta no tiene permiso para esto.';
    case 'NO_MEMBERSHIP': return 'Tu cuenta no tiene acceso a Central.';
    case 'VERSION_CONFLICT': return 'Otra persona ha modificado esta fila.';
    case 'BACKEND_UNAVAILABLE': return 'El servidor no está disponible ahora mismo.';
    case 'LAST_OWNER': return 'Esa app se quedaría sin ninguna persona propietaria. Da antes la propiedad a otra persona.';
    case 'CURRENT_ACCOUNT': return 'No puedes quitarte ni rebajarte la administración a ti misma o a ti mismo.';
    case 'INVALID_ROLE': return 'Ese rol no está permitido para esta cuenta (un agente nunca es propietario ni entra en Central).';
    case 'APP_NOT_FOUND': return 'Esa app no existe.';
    case 'USER_EXISTS': return 'Ya existe una cuenta con ese correo.';
    case 'INVALID_ACCOUNT': return 'Esa cuenta no puede enlazarse a una persona.';
    case 'ORPHAN_CHILD': return 'Antes hay que enviar a la papelera lo que depende de esta ficha.';
    case 'PERSON_IN_USE': return 'Es responsable de alguna obligación o documento: cambia el responsable o márcala inactiva.';
    case 'TASKS_FORBIDDEN': return 'Tu cuenta no puede crear tareas en Tasks. Pide acceso de editor en Tasks.';
    case 'TASKS_UNAVAILABLE': return 'Tasks no responde ahora mismo. Inténtalo más tarde.';
    case 'TASKS_REJECTED': return e.message || 'Tasks no ha aceptado la petición.';
    case 'EXTERNAL_REF_IN_USE': return 'Esa tarea ya existe en Tasks y no la ves.';
    case 'IMMUTABLE_FIELD': return 'Ese dato no se puede cambiar.';
    case 'INVALID_FILE': return 'El archivo no se pudo enlazar. Vuelve a elegirlo.';
    case 'OFFLINE': return 'Esta acción necesita conexión.';
    default: return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}

/** Error de «sin red» en las acciones que no funcionan sin conexión (administración). */
export function offlineError(): ApiError {
  return { code: 'OFFLINE', message: 'Esta acción necesita conexión.', status: 0, details: null };
}
