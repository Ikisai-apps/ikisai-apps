/** Acceso a Supabase desde la Edge: PostgREST (RPC con service key), Auth y Storage. */
import { fail, Fault, messageFor } from './errors.ts';

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  serviceKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface RemoteOptions {
  service?: boolean;
  bearer?: string | null;
  method?: string;
  body?: unknown;
  raw?: boolean;
  headers?: Record<string, string>;
  binary?: Uint8Array | ArrayBuffer | ReadableStream | null;
}

export interface Supabase {
  remote(path: string, options?: RemoteOptions): Promise<any>;
  rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T>;
  base: string;
  config: SupabaseConfig;
}

export function createSupabase(config: SupabaseConfig): Supabase {
  const transport = config.fetch ?? fetch;
  const base = config.url.replace(/\/$/, '');
  const timeout = config.timeoutMs ?? 15000;

  async function remote(path: string, options: RemoteOptions = {}): Promise<any> {
    const { service = false, bearer = null, method = 'GET', body = null, raw = false, binary = null } = options;
    const key = service ? config.serviceKey : config.anonKey;
    const headers: Record<string, string> = { apikey: key, ...(options.headers ?? {}) };
    if (!binary && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    if (service || bearer) headers.Authorization = 'Bearer ' + (bearer ?? key);
    let response: Response;
    try {
      response = await transport(base + path, {
        method,
        headers,
        body: binary ?? (body === null ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeout),
      } as RequestInit);
    } catch {
      fail(503, 'BACKEND_UNAVAILABLE', messageFor('BACKEND_UNAVAILABLE'));
    }
    if (raw) return response;
    const out = await response.json().catch(() => ({}));
    if (!response.ok) {
      translate(path, response.status, out);
    }
    return out;
  }

  function translate(path: string, status: number, out: any): never {
    // PostgREST: { code: 'PT409', message: 'VERSION_CONFLICT', details: '{...}' }
    if (typeof out?.code === 'string' && /^PT\d{3}$/.test(out.code)) {
      const http = Number(out.code.slice(2));
      let details: unknown = null;
      if (typeof out.details === 'string' && out.details) {
        try { details = JSON.parse(out.details); } catch { details = out.details; }
      } else if (out.details) details = out.details;
      const code = typeof out.message === 'string' && /^[A-Z_]+$/.test(out.message) ? out.message : 'BACKEND_ERROR';
      fail(http, code, messageFor(code), details);
    }
    if (['40001', '40P01'].includes(out?.code)) fail(409, 'CURSOR_CONFLICT', messageFor('CURSOR_CONFLICT'));
    // Errores SQL definitivos: nunca 503 (el cliente los reintentaría sin fin). Se devuelven como 422 con el SQLSTATE.
    if (typeof out?.code === 'string' && path.startsWith('/rest/v1/rpc/')) {
      const sqlstate: string = out.code;
      const info = { sqlstate, message: typeof out.message === 'string' ? out.message : null, details: out.details ?? null, hint: out.hint ?? null };
      if (/^23[0-9A-Z]{3}$/.test(sqlstate)) fail(422, 'CONSTRAINT_VIOLATION', 'Los datos no cumplen una restricción de la base de datos.', info);
      if (/^22[0-9A-Z]{3}$/.test(sqlstate)) fail(422, 'INVALID_VALUE', 'Algún valor tiene un formato o tipo inválido.', info);
      if (sqlstate === 'P0001') fail(422, 'DOMAIN_ERROR', info.message ?? 'La operación no cumple una regla de la aplicación.', info);
      if (/^(42|2[0-9A-F]|0[0-9A-Z]|P0)[0-9A-Z]{3}$/.test(sqlstate)) fail(422, 'SQL_ERROR', 'La operación no se pudo ejecutar en la base de datos.', info);
    }
    if (path.startsWith('/auth/v1/admin/')) {
      const authCode: string | null = typeof (out?.error_code ?? out?.code) === 'string' ? (out.error_code ?? out.code) : null;
      if (['email_exists', 'user_already_exists'].includes(authCode ?? '')) fail(409, 'USER_EXISTS', 'Ya existe una cuenta con ese correo.');
      // El motivo de Auth llega a quien da el alta: un 502 genérico no deja saber qué falló (8-10-2026).
      const authInfo = { authStatus: status, authCode, authMessage: typeof (out?.msg ?? out?.message) === 'string' ? String(out.msg ?? out.message).slice(0, 300) : null };
      if (authCode === 'email_address_invalid' || authCode === 'validation_failed') fail(422, 'INVALID_EMAIL', 'Ese correo no se acepta para crear una cuenta. Revísalo.', authInfo);
      if (authCode === 'weak_password') fail(422, 'WEAK_PASSWORD', 'La contraseña no cumple los requisitos de seguridad.', authInfo);
      if (status === 429 || authCode === 'over_request_rate_limit' || authCode === 'over_email_send_rate_limit') fail(429, 'RATE_LIMITED', messageFor('RATE_LIMITED'), authInfo);
      console.error('[ikisai] auth admin', path.split('?')[0], JSON.stringify(authInfo));
      fail(502, 'AUTH_ADMIN_FAILED', 'No se pudo completar la operación de cuentas.', authInfo);
    }
    if (path.startsWith('/auth/')) {
      if (status === 429) fail(429, 'RATE_LIMITED', messageFor('RATE_LIMITED'));
      fail(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    }
    if (path.startsWith('/storage/')) fail(status === 404 ? 404 : 503, status === 404 ? 'FILE_NOT_FOUND' : 'STORAGE_UNAVAILABLE', messageFor(status === 404 ? 'FILE_NOT_FOUND' : 'STORAGE_UNAVAILABLE'));
    throw new Fault(503, 'BACKEND_UNAVAILABLE', messageFor('BACKEND_UNAVAILABLE'));
  }

  const rpc = <T = unknown>(name: string, args: Record<string, unknown>) =>
    remote('/rest/v1/rpc/' + name, { service: true, method: 'POST', body: args }) as Promise<T>;

  return { remote, rpc, base, config };
}

/** SHA-256 en hexadecimal de un texto o bytes. */
export async function sha256Hex(input: string | Uint8Array | ArrayBuffer): Promise<string> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** JSON con claves ordenadas, para digests estables. */
export function stable(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]));
  }
  return value;
}
