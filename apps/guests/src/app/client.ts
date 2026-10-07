import { createSyncClient, type ApiError, type SyncClient } from '@ikisai/sync-client';
import { t } from './i18n.ts';

export const APP = 'guests';

/**
 * Guests no tiene tablas propias (API.md §2): el cliente solo lleva la sesión (enlace personal y sesión única), la
 * renovación, `api()` y `onSessionEnd`. Los datos son de Booking y Central, y se leen con `read/…`.
 */
export function createClient(): SyncClient {
  return createSyncClient({ app: APP, apiBase: '/api/v1', tables: [], pullIntervalMs: 300_000 });
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

/** Errores de transporte: el cambio se queda en la cola y se reintenta al volver la red. */
export function isNetworkError(error: unknown): boolean {
  return ['NETWORK', 'OFFLINE', 'BACKEND_UNAVAILABLE'].includes(errorCode(error));
}

/** Mensaje claro, sin jerga, para el huésped (API.md §6.3). */
export function describeError(error: unknown): string {
  const e = error as Partial<ApiError>;
  switch (typeof e?.code === 'string' ? e.code : '') {
    case 'LINK_INVALID': return t('error.linkInvalid');
    case 'LINK_EXPIRED': return t('error.linkExpired');
    case 'VERSION_CONFLICT': return t('error.conflict');
    case 'GUEST_DATA_OFF': return t('error.dataOff');
    case 'OUT_OF_SCOPE':
    case 'NO_MEMBERSHIP':
    case 'FORBIDDEN': return t('error.noAccess');
    case 'CONSTRAINT_VIOLATION':
    case 'INVALID_VALUE':
    case 'INVALID_FIELDS': return t('error.invalid');
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED': return t('error.session');
    case 'FEEDBACK_RATE_LIMITED': return t('error.rateLimited');
    case 'NETWORK':
    case 'OFFLINE':
    case 'BACKEND_UNAVAILABLE': return t('error.offline');
    default: return t('error.generic');
  }
}

export function online(): boolean {
  return navigator.onLine !== false;
}
