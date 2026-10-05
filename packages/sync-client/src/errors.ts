import type { ApiError } from './types.ts';

/** Error de la API con la forma `{ status, code, message, details }` del contrato §5. */
export class SyncApiError extends Error implements ApiError {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.name = 'SyncApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toJSON(): ApiError {
    return { status: this.status, code: this.code, message: this.message, details: this.details };
  }
}

/** Código que usamos cuando `fetch` ni siquiera llega al servidor (sin red, DNS, CORS…). */
export const NETWORK_ERROR_CODE = 'NETWORK';

export function isApiError(error: unknown): error is SyncApiError {
  return error instanceof SyncApiError;
}

export function isNetworkError(error: unknown): boolean {
  return isApiError(error) && error.status === 0 && error.code === NETWORK_ERROR_CODE;
}

export function networkError(cause: unknown): SyncApiError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new SyncApiError(0, NETWORK_ERROR_CODE, `Sin conexión con el servidor: ${message}`, null);
}

/** Convierte cualquier excepción en un `ApiError` serializable para `status().lastError`. */
export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error.toJSON();
  if (error && typeof error === 'object' && 'status' in error && 'code' in error) {
    const e = error as Partial<ApiError>;
    return {
      status: typeof e.status === 'number' ? e.status : 0,
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
      message: typeof e.message === 'string' ? e.message : String(error),
      details: e.details ?? null,
    };
  }
  return { status: 0, code: 'UNKNOWN', message: error instanceof Error ? error.message : String(error), details: null };
}
