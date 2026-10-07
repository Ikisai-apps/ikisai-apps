import { createSyncClient, type ApiError, type SyncClient } from '@ikisai/sync-client';

export const APP = 'organizers';

/**
 * Organizers no tiene tablas propias (API.md §2): el cliente solo lleva la sesión (enlace personal y sesión única),
 * la renovación, `api()` y `onSessionEnd`. Los datos son de Booking y se leen con `read/booking.portal_*`.
 */
export function createClient(): SyncClient {
  return createSyncClient({ app: APP, apiBase: '/api/v1', tables: [], pullIntervalMs: 300_000 });
}

/** Mensaje claro, sin jerga, para quien organiza el retiro (API.md §6.3). `name` es el asistente afectado, si lo hay. */
export function describeError(error: unknown, name?: string): string {
  const e = error as Partial<ApiError> & { message?: string; details?: Record<string, unknown> };
  const code = typeof e?.code === 'string' ? e.code : '';
  const who = name || 'Esta persona';
  switch (code) {
    case 'LINK_INVALID': return 'Este enlace no es válido o ya no está activo. Pide uno nuevo a Ikisai.';
    case 'LINK_EXPIRED': return 'Este enlace ha caducado. Si tu retiro sigue en marcha, pide uno nuevo a Ikisai.';
    case 'RESERVATION_NOT_CONFIRMED': return 'Podrás añadir a tus asistentes cuando la reserva esté confirmada.';
    case 'GUEST_DATA_OFF': return 'En este retiro no hace falta la lista de asistentes.';
    case 'DECLARATION_REQUIRED': return 'Antes de guardar, marca la casilla de conformidad.';
    case 'FIELD_OWNED_BY_GUEST': return `${who} ya ha rellenado este dato. No hace falta que lo cambies.`;
    case 'GUEST_CHECKED_IN': return `${who} ya ha hecho la entrada. Para darle de baja, habla con Ikisai.`;
    case 'VERSION_CONFLICT': return 'Alguien ha cambiado estos datos mientras los editabas. Te enseñamos lo último; lo que escribiste sigue en el formulario.';
    case 'ROW_EXISTS': return 'Ese asistente ya existe. Recarga la lista.';
    case 'OUT_OF_SCOPE':
    case 'NO_MEMBERSHIP':
    case 'FORBIDDEN': return 'Ya no tienes acceso a este retiro.';
    case 'INVALID_FIELDS': return 'Revisa los datos: falta el nombre o hay alguno con un formato que no vale.';
    case 'INVALID_VALUE':
    case 'CONSTRAINT_VIOLATION': return 'Algún dato tiene un formato que no vale. Revísalo.';
    case 'UNAUTHENTICATED':
    case 'UNAUTHORIZED': return 'Tu acceso ha caducado. Abre de nuevo el enlace que te enviamos.';
    case 'FEEDBACK_RATE_LIMITED': return 'Has enviado muchos comentarios hoy. Inténtalo mañana.';
    case 'NETWORK':
    case 'OFFLINE':
    case 'BACKEND_UNAVAILABLE': return 'Sin conexión. Tus cambios no se han guardado; inténtalo cuando vuelvas a tener red.';
    default: return 'Algo ha fallado. Inténtalo de nuevo en un momento.';
  }
}

export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' ? code : '';
}

/** Sin red: los botones de guardar se desactivan (API.md §10). */
export function online(): boolean {
  return navigator.onLine !== false;
}
