import { createSyncClient, type ApiError, type SyncClient } from '@ikisai/sync-client';
import { APP, TABLES } from '@ikisai/domain-flow';

/** Cliente de sincronización de Flow. Sin tablas todavía: sesión, bootstrap y cola del núcleo (docs/flow/ESTADO.md). */
export function createClient(): SyncClient {
  return createSyncClient({
    app: APP,
    apiBase: '/api/v1',
    tables: Object.values(TABLES),
    pullIntervalMs: 30_000,
  });
}

/** Mensaje legible en español para un error de la API o de red. */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError> & { message?: string };
  switch (typeof e?.code === 'string' ? e.code : '') {
    case 'LOGIN_FAILED': return 'Correo o contraseña incorrectos.';
    case 'NETWORK': return 'No hay conexión con el servidor.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED': return 'La sesión ha caducado. Vuelve a iniciar sesión.';
    case 'FORBIDDEN': return 'Tu cuenta no tiene permiso para esto.';
    case 'NO_MEMBERSHIP': return 'Tu cuenta no tiene acceso a Flow.';
    case 'BACKEND_UNAVAILABLE': return 'El servidor no está disponible ahora mismo.';
    default: return typeof e?.message === 'string' && e.message ? e.message : 'Ha ocurrido un error inesperado.';
  }
}
