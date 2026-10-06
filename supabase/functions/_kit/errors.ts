/** Errores del núcleo: siempre `{ error: { code, message, details } }` con estado HTTP. */
export class Fault extends Error {
  status: number;
  code: string;
  details: unknown;
  constructor(status: number, code: string, message: string, details: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export function fail(status: number, code: string, message: string, details: unknown = null): never {
  throw new Fault(status, code, message, details);
}

export const MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'Inicia sesión para continuar.',
  UNAUTHORIZED: 'La sesión no es válida o ha caducado.',
  FORBIDDEN: 'No tienes permiso para esta operación.',
  NO_MEMBERSHIP: 'Tu cuenta no tiene acceso a esta aplicación.',
  NOT_FOUND: 'No se encontró el elemento.',
  VERSION_CONFLICT: 'Otra persona ha cambiado este elemento. Revisa antes de guardar.',
  CURSOR_CONFLICT: 'Otro dispositivo acaba de guardar. Sincroniza y reintenta.',
  IDEMPOTENCY_REUSE: 'Este identificador de petición ya se usó para otro lote.',
  ROW_EXISTS: 'Ya existe un elemento con ese identificador.',
  ROW_DELETED: 'El elemento está en la papelera.',
  ROW_NOT_DELETED: 'El elemento no está en la papelera.',
  INVALID_FIELDS: 'Campos desconocidos o de solo lectura.',
  INVALID_OPERATION: 'Operación inválida.',
  INVALID_JSON: 'JSON inválido.',
  PAYLOAD_TOO_LARGE: 'La petición es demasiado grande.',
  UNDO_UNAVAILABLE: 'Este cambio no se puede deshacer.',
  UNDO_PLAN_CHANGED: 'El plan de deshacer ha cambiado. Revísalo de nuevo.',
  APP_NOT_FOUND: 'Aplicación desconocida.',
  BACKEND_UNAVAILABLE: 'No se pudo contactar con el servicio de datos.',
  STORAGE_UNAVAILABLE: 'No se pudo acceder al almacenamiento de archivos.',
  ORIGIN_REJECTED: 'Origen no autorizado.',
  RATE_LIMITED: 'Demasiados intentos. Espera un momento.',
  LOGIN_FAILED: 'Correo o contraseña incorrectos.',
  INVALID_ROLE: 'Rol inválido.',
  CURRENT_ACCOUNT: 'No puedes aplicar ese cambio a tu propia cuenta.',
  FILE_NOT_FOUND: 'Archivo no encontrado.',
  FILE_MISMATCH: 'El archivo subido no coincide con lo declarado.',
  EXTRACTION_UNAVAILABLE: 'La extracción automática no está disponible ahora mismo.',
  EXTRACTION_INVALID: 'El modelo no devolvió un documento utilizable.',
};

export function messageFor(code: string): string {
  return MESSAGES[code] ?? 'La operación no pudo completarse: ' + code;
}

export function isFault(error: unknown): error is Fault {
  return error instanceof Fault;
}
