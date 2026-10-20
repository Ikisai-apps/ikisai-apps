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
  /** El outsider sube archivos (p. ej. fotos en comentarios de Tasks). Por defecto, no. */
  allowOutsiders?: boolean;
  /** Límites del outsider cuando `allowOutsiders`: por defecto, solo imágenes (JPEG, PNG, WebP) de hasta 10 MB. */
  outsiderMime?: string[];
  outsiderMaxBytes?: number;
  allowReaders?: boolean;
  /** K3 para miembros: si es `true`, un miembro que no sea propietario lee un archivo ajeno solo si ve (hook `visible`) una
   *  fila viva que lo referencia, como el portal y el outsider. La activa cada app tras revisar sus campos de archivo. */
  membersK3?: boolean;
}

const SHA = /^[0-9a-f]{64}$/;
const OUTSIDER_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const OUTSIDER_MAX_BYTES = 10 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un SVG es un documento: abierto con su URL firmada, ejecutaría lo que lleve dentro. La verificación rechaza el que traiga
 *  contenido activo (scripts, `foreignObject`, incrustados, manejadores `on…` o enlaces `javascript:`); el cliente sube el
 *  SVG ya limpio (MUELA-092). Devuelve el motivo, o `null` si está limpio. */
export function svgUnsafeReason(text: string): string | null {
  const t = text.replace(/<!--[\s\S]*?-->/g, '');
  if (/<\s*(?:[a-z0-9_-]+:)?script\b/i.test(t)) return 'script';
  if (/<\s*(?:[a-z0-9_-]+:)?foreignObject\b/i.test(t)) return 'foreignObject';
  if (/<\s*(?:[a-z0-9_-]+:)?(?:iframe|embed|object)\b/i.test(t)) return 'embed';
  if (/[\s"'\/]on[a-z]+\s*=/i.test(t)) return 'handler';
  if (/(?:java|vb)script\s*:|data\s*:\s*text\/html/i.test(t.replace(/&#x?[0-9a-f]+;?|[\t\n\r]/gi, ''))) return 'link';
  if (/<!ENTITY/i.test(t)) return 'entity';
  return null;
}

export function createUploads(supabase: Supabase, app: string, config: UploadsConfig, storage: StorageAccess = createStorage(supabase),
  visible?: (table: string, row: Record<string, unknown>, ctx: RequestContext) => boolean) {
  const maxBytes = config.maxBytes ?? 50 * 1024 * 1024;
  const hashUpTo = config.hashVerifyUpTo ?? 25 * 1024 * 1024;
  const readSeconds = config.readUrlSeconds ?? 600;

  // Portales (contrato §3.6): ser miembro de la app no basta; cada persona del portal solo ve los archivos que subió ella
  // (la firma de un huésped no la lee otro huésped aunque conozca el id). Se distingue por su ámbito `scopes.grants`.
  // El outsider (O1) tiene la misma regla: conocer un `file_id` no basta.
  // K3: un archivo ajeno se puede leer si alguna fila de la app que lo referencia (campos de `register_file_field`) es
  // visible para el miembro con el hook `visible` de la app; sin hook, solo los propios.
  async function ownInPortal(ctx: RequestContext, file: any) {
    const restricted = Array.isArray((ctx.membership as any)?.scopes?.grants) || ctx.membership?.role === 'outsider'
      || (config.membersK3 === true && !!visible && ctx.membership?.role !== 'owner');
    if (!restricted || file?.created_by === ctx.user.id) return;
    if (visible) {
      const refs = await supabase.rpc<Array<{ table: string; row: Record<string, unknown> }>>('core_file_referencing_rows', { p_app: app, p_file: file.id });
      if ((refs ?? []).some((r) => visible(r.table, r.row, ctx))) return;
    }
    fail(404, 'FILE_NOT_FOUND', messageFor('FILE_NOT_FOUND'));
  }

  async function create(ctx: RequestContext, body: any) {
    if ((ctx.membership.role === 'reader' && !config.allowReaders) || (ctx.membership.role === 'outsider' && !config.allowOutsiders)) fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (typeof body?.filename !== 'string' || !body.filename || body.filename.length > 255) fail(422, 'INVALID_OPERATION', 'Nombre de archivo inválido.');
    if (typeof body?.mime !== 'string' || !/^[a-z]+\/[a-z0-9.+-]+$/i.test(body.mime)) fail(422, 'INVALID_OPERATION', 'Tipo MIME inválido.');
    if (config.allowedMime?.length && !config.allowedMime.includes(body.mime.toLowerCase())) fail(422, 'UNSUPPORTED_MEDIA', 'Tipo de archivo no admitido.', { allowed: config.allowedMime });
    const outsider = ctx.membership.role === 'outsider';
    const outsiderMime = config.outsiderMime ?? OUTSIDER_MIME;
    if (outsider && !outsiderMime.includes(body.mime.toLowerCase())) fail(422, 'UNSUPPORTED_MEDIA', 'Tipo de archivo no admitido.', { allowed: outsiderMime });
    if (!Number.isSafeInteger(body?.size) || body.size < 0) fail(422, 'INVALID_OPERATION', 'Tamaño inválido.');
    const limit = outsider ? Math.min(maxBytes, config.outsiderMaxBytes ?? OUTSIDER_MAX_BYTES) : maxBytes;
    if (body.size > limit) fail(413, 'PAYLOAD_TOO_LARGE', 'El archivo supera el tamaño máximo.', { maxBytes: limit });
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
    await ownInPortal(ctx, file);
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
      if (String(file.mime).toLowerCase() === 'image/svg+xml') {
        const reason = svgUnsafeReason(new TextDecoder().decode(bytes));
        if (reason) {
          await supabase.rpc('core_file_mark', { p_id: id, p_status: 'missing', p_size: size, p_hash_verified: false });
          fail(422, 'UNSUPPORTED_MEDIA', 'El SVG lleva contenido activo (scripts o enlaces). Súbelo limpio.', { reason });
        }
      }
    } else {
      if (String(file.mime).toLowerCase() === 'image/svg+xml') {
        await response.body?.cancel();
        fail(422, 'UNSUPPORTED_MEDIA', 'El SVG es demasiado grande para comprobarlo.');
      }
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
    await ownInPortal(ctx, file);
    if (file.status !== 'verified') fail(404, 'FILE_NOT_FOUND', 'El archivo no está disponible.');
    const url = await storage.readUrl(file, readSeconds);
    return { id, url, expiresAt: new Date(Date.now() + readSeconds * 1000).toISOString(), filename: file.filename, mime: file.mime, size: file.size };
  }

  return { create, verify, readUrl };
}
