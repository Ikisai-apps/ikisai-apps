/**
 * Proveedores de almacenamiento (contrato §3.9, coordinacion/ampliacion/ALMACENAMIENTO.md). Las apps guardan `file_id`; dónde
 * vive el objeto lo dice `core.files.storage_provider`. Hoy: Supabase Storage y Cloudflare R2 (S3, URL prefirmadas SigV4).
 * El `bucket` de core.files es lógico: en R2 todo va a un bucket físico con el lógico como prefijo (`<bucket>/<path>`).
 *
 * R2 se activa con los secretos R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY y R2_BUCKET, más
 * IKISAI_STORAGE_PROVIDER=r2 para que los archivos nuevos vayan allí. Sin ellos, todo sigue en Supabase.
 */
import { fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';

export type ProviderName = 'supabase' | 'r2';
export interface StoredObject { bucket: string; path: string; storage_provider?: ProviderName | null }
export interface R2Config { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string; endpoint?: string }

const enc = new TextEncoder();
const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(text: string) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmac(key: ArrayBuffer | Uint8Array, data: string) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}
/** Codificación de URI de AWS: todo salvo A-Z a-z 0-9 - _ . ~ (la barra se conserva en la ruta). */
export function awsEncode(s: string, keepSlash = false): string {
  const out = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? out.replace(/%2F/g, '/') : out;
}

/**
 * URL prefirmada SigV4 (consulta), válida para GET, PUT, HEAD y DELETE. `host` y `path` ya resueltos (estilo ruta o virtual).
 * Probada con el ejemplo oficial de AWS (S3, «Authenticating Requests: Using Query Parameters»).
 */
export async function presign(opts: {
  method: string; host: string; path: string; accessKeyId: string; secretAccessKey: string; region: string; expires: number; now?: Date; service?: string;
}): Promise<string> {
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const service = opts.service ?? 's3';
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${opts.accessKeyId}/${scope}`, 'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(opts.expires), 'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query).sort().map((k) => `${awsEncode(k)}=${awsEncode(query[k]!)}`).join('&');
  const canonicalPath = awsEncode(opts.path, true);
  const canonical = [opts.method, canonicalPath, canonicalQuery, `host:${opts.host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  let key: ArrayBuffer = await hmac(enc.encode('AWS4' + opts.secretAccessKey), day);
  key = await hmac(key, opts.region);
  key = await hmac(key, service);
  key = await hmac(key, 'aws4_request');
  const signature = hex(await hmac(key, toSign));
  return `https://${opts.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export function r2ConfigFromEnv(get: (name: string) => string | undefined): R2Config | null {
  const accountId = get('R2_ACCOUNT_ID'); const accessKeyId = get('R2_ACCESS_KEY_ID'); const secretAccessKey = get('R2_SECRET_ACCESS_KEY'); const bucket = get('R2_BUCKET');
  return accountId && accessKeyId && secretAccessKey && bucket ? { accountId, accessKeyId, secretAccessKey, bucket, endpoint: get('R2_ENDPOINT') } : null;
}

export interface StorageAccess {
  /** Proveedor para los archivos nuevos. */
  defaultProvider: ProviderName;
  uploadUrl(o: StoredObject, mime: string, seconds?: number): Promise<{ url: string; headers: Record<string, string> }>;
  readUrl(o: StoredObject, seconds?: number): Promise<string>;
  /** Descarga desde la Edge (verificación de huella, extracción). */
  download(o: StoredObject): Promise<Response>;
  remove(o: StoredObject): Promise<void>;
}

export function createStorage(supabase: Supabase, options: { r2?: R2Config | null; defaultProvider?: ProviderName; fetch?: typeof fetch } = {}): StorageAccess {
  const r2 = options.r2 ?? null;
  const transport = options.fetch ?? supabase.config.fetch ?? fetch;
  const defaultProvider: ProviderName = options.defaultProvider === 'r2' && r2 ? 'r2' : 'supabase';
  const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const provider = (o: StoredObject): ProviderName => (o.storage_provider === 'r2' ? 'r2' : 'supabase');
  const r2Url = (method: string, o: StoredObject, seconds: number) => {
    if (!r2) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'), { provider: 'r2' });
    const host = r2!.endpoint ?? `${r2!.accountId}.r2.cloudflarestorage.com`;
    return presign({ method, host, path: `/${r2!.bucket}/${o.bucket}/${o.path}`, accessKeyId: r2!.accessKeyId, secretAccessKey: r2!.secretAccessKey, region: 'auto', expires: seconds });
  };

  return {
    defaultProvider,
    async uploadUrl(o, mime, seconds = 7200): Promise<{ url: string; headers: Record<string, string> }> {
      if (provider(o) === 'r2') return { url: await r2Url('PUT', o, seconds), headers: { 'Content-Type': mime } };
      const signed = await supabase.remote(`/storage/v1/object/upload/sign/${o.bucket}/${encodePath(o.path)}`, { service: true, method: 'POST', body: {} });
      if (typeof signed?.url !== 'string') fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'));
      return { url: supabase.base + '/storage/v1' + signed.url, headers: { 'Content-Type': mime, 'x-upsert': 'false' } };
    },
    async readUrl(o, seconds = 600) {
      if (provider(o) === 'r2') return r2Url('GET', o, seconds);
      const signed = await supabase.remote(`/storage/v1/object/sign/${o.bucket}/${encodePath(o.path)}`, { service: true, method: 'POST', body: { expiresIn: seconds } });
      const url = typeof signed?.signedURL === 'string' ? signed.signedURL : typeof signed?.signedUrl === 'string' ? signed.signedUrl : null;
      if (!url) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'));
      return supabase.base + '/storage/v1' + url;
    },
    async download(o) {
      if (provider(o) === 'r2') return transport(await r2Url('GET', o, 300));
      return supabase.remote(`/storage/v1/object/${o.bucket}/${encodePath(o.path)}`, { service: true, raw: true });
    },
    async remove(o) {
      if (provider(o) === 'r2') {
        const res = await transport(await r2Url('DELETE', o, 300), { method: 'DELETE' });
        if (!res.ok && res.status !== 404) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'), { status: res.status });
        return;
      }
      await supabase.remote(`/storage/v1/object/${o.bucket}`, { service: true, method: 'DELETE', body: { prefixes: [o.path] } });
    },
  };
}
