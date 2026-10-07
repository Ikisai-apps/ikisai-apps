/** Subidas: ticket + URL firmada de subida directa al bucket, verificación y URL firmada de lectura. */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';
import { createStorage, type StorageAccess } from './storage.ts';

export interface UploadsConfig {
  bucket: string;
  /** Tamaño máximo aceptado por la app (bytes). El bucket tiene su propio límite. */
  maxBytes?: number;
  /** MIME aceptados; vacío = cualquiera. */
  allowedMime?: string[];
  /** Hasta este tamaño la Edge descarga el objeto y comprueba el sha256; por encima, solo tamaño. */
  hashVerifyUpTo?: number;
  /** Segundos de validez de las URL firmadas de lectura. */
  readUrlSeconds?: number;
  /** Admite subidas de lectores (feedback: cualquier miembro puede adjuntar una imagen a su comentario). */
  allowReaders?: boolean;
}

const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createUploads(supabase: Supabase, app: string, config: UploadsConfig, storage: StorageAccess = createStorage(supabase)) {
  const maxBytes = config.maxBytes ?? 50 * 1024 * 1024;
  const hashUpTo = config.hashVerifyUpTo ?? 25 * 1024 * 1024;
  const readSeconds = config.readUrlSeconds ?? 600;

  async function create(ctx: RequestContext, body: any) {
    if (ctx.membership.role === 'reader' && !config.allowReaders) fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (typeof body?.filename !== 'string' || !body.filename || body.filename.length > 255) fail(422, 'INVALID_OPERATION', 'Nombre de archivo inválido.');
    if (typeof body?.mime !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(body.mime)) fail(422, 'INVALID_OPERATION', 'Tipo MIME inválido.');
    if (config.allowedMime?.length && !config.allowedMime.includes(body.mime.toLowerCase())) fail(422, 'UNSUPPORTED_MEDIA', 'Tipo de archivo no admitido.', { allowed: config.allowedMime });
    if (!Number.isSafeInteger(body?.size) || body.size < 0) fail(422, 'INVALID_OPERATION', 'Tamaño inválido.');
    if (body.size > maxBytes) fail(413, 'PAYLOAD_TOO_LARGE', 'El archivo supera el tamaño máximo.', { maxBytes });
    if (typeof body?.sha256 !== 'string' || !SHA.test(body.sha256)) fail(422, 'INVALID_OPERATION', 'sha256 inválido.');
    const file = await supabase.rpc<any>('core_file_create', {
      p_app: app, p_actor: ctx.user.id, p_bucket: config.bucket, p_filename: body.filename, p_mime: body.mime.toLowerCase(), p_size: body.size, p_sha256: body.sha256.toLowerCase(),
      p_provider: storage.defaultProvider,
    });
    const upload = await storage.uploadUrl({ bucket: config.bucket, path: file.path, storage_provider: file.storageProvider }, body.mime.toLowerCase());
    return {
      id: file.id,
      path: file.path,
      uploadUrl: upload.url,
      method: 'PUT',
      headers: upload.headers,
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      duplicateOf: file.duplicateOf ?? null,
    };
  }

  async function verify(ctx: RequestContext, id: string) {
    if (!UUID.test(id)) fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
    const file = await supabase.rpc<any>('core_file_get', { p_app: app, p_actor: ctx.user.id, p_id: id });
    if (file.status === 'verified') return { id, sha256: file.sha256, size: file.size, verified: true, hashVerified: file.hash_verified };
    const response: Response = await storage.download(file);
    if (response.status === 404 || response.status === 400) {
      await supabase.rpc('core_file_mark', { p_id: id, p_status: 'missing', p_size: null, p_hash_verified: false });
      fail(404, 'FILE_NOT_FOUND', 'El archivo no se ha subido todavía.');
    }
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'));
    const declared = Number(file.size);
    const lengthHeader = response.headers.get('content-length');
    let size = lengthHeader ? Number(lengthHeader) : NaN;
    let hashVerified = false;
    if (declared <= hashUpTo) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      size = bytes.byteLength;
      const digest = await sha256Hex(bytes);
      if (digest !== file.sha256) {
        await supabase.rpc('core_file_mark', { p_id: id, p_status: 'missing', p_size: size, p_hash_verified: false });
        fail(422, 'FILE_MISMATCH', messageFor('FILE_MISMATCH'), { expected: file.sha256, actual: digest });
      }
      hashVerified = true;
    } else {
      await response.body?.cancel();
    }
    if (Number.isFinite(size) && size !== declared) {
      await supabase.rpc('core_file_mark', { p_id: id, p_status: 'missing', p_size: size, p_hash_verified: false });
      fail(422, 'FILE_MISMATCH', messageFor('FILE_MISMATCH'), { expectedSize: declared, actualSize: size });
    }
    await supabase.rpc('core_file_mark', { p_id: id, p_status: 'verified', p_size: Number.isFinite(size) ? size : declared, p_hash_verified: hashVerified });
    return { id, sha256: file.sha256, size: Number.isFinite(size) ? size : declared, verified: true, hashVerified };
  }

  async function readUrl(ctx: RequestContext, id: string) {
    if (!UUID.test(id)) fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
    const file = await supabase.rpc<any>('core_file_get', { p_app: app, p_actor: ctx.user.id, p_id: id });
    if (file.status !== 'verified') fail(404, 'FILE_NOT_FOUND', 'El archivo no está disponible.');
    const url = await storage.readUrl(file, readSeconds);
    return { id, url, expiresAt: new Date(Date.now() + readSeconds * 1000).toISOString(), filename: file.filename, mime: file.mime, size: file.size };
  }

  return { create, verify, readUrl };
}
