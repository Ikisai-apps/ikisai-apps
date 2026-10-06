/**
 * Extracción de documentos con un modelo de visión (Claude, SDK oficial de Anthropic).
 *
 * Una app entrega archivos ya subidos y verificados en su bucket (PDF o imágenes) junto a su prompt de extracción, y recibe
 * el JSON que el modelo produce. El helper descarga los objetos con la service key, los adjunta en base64 y traduce cualquier
 * incidencia a `Fault` del núcleo:
 *   - `EXTRACTION_UNAVAILABLE 503`: sin clave, clave rechazada, cuota agotada, proveedor caído o sin red (la app ofrece la vía manual).
 *   - `EXTRACTION_INVALID 422 {errors, warnings}`: el modelo no devolvió un JSON utilizable (truncado, rechazo, prosa sin JSON).
 *   - `INVALID_FILE 422`: tipo no admitido, demasiado grande o rechazado por el proveedor.
 *   - `FILE_NOT_FOUND 404` / `STORAGE_UNAVAILABLE 503`: el objeto no está en el bucket o Storage no responde.
 * El helper no valida el documento contra el esquema de la app: eso lo hace la ruta que lo llama (y puede pasar `schema` para
 * que el modelo respete la forma exacta mediante salida estructurada).
 *
 * Este módulo no se reexporta desde `mod.ts` a propósito: solo lo importan las funciones que extraen (`../_kit/extract.ts`),
 * así el SDK solo se resuelve en ellas. En Deno el especificador `@anthropic-ai/sdk` lo resuelve `supabase/functions/import_map.json`.
 */
import Anthropic from '@anthropic-ai/sdk';
import { fail, isFault, messageFor } from './errors.ts';
import { createSupabase, type Supabase, type SupabaseConfig } from './supabase.ts';
import type { RequestContext } from './sync.ts';

export interface ExtractFile {
  id: string;
  bucket: string;
  path: string;
  mime: string;
  filename: string;
  size: number;
}

export interface ExtractArgs {
  /** Documentos de una misma unidad (por ejemplo las páginas de una factura), en orden. */
  files: ExtractFile[];
  /** Instrucciones de extracción de la app; van como system prompt con caché. */
  prompt: string;
  ctx: RequestContext;
  /** Esquema JSON opcional: con él la salida se fuerza a esa forma (salida estructurada) y no hay prosa que separar. */
  schema?: Record<string, unknown>;
}

export interface ExtractUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  latencyMs: number;
}

export interface ExtractResult {
  document: unknown;
  /** Prosa que el modelo escribió fuera del JSON (notas de ambigüedad) y avisos del propio helper. */
  warnings: string[];
  usage: ExtractUsage;
}

export type DocumentExtractor = (args: ExtractArgs) => Promise<ExtractResult>;

export interface ExtractorOptions {
  /** Clave de la API de Anthropic (secreto Edge `ANTHROPIC_API_KEY`). Sin ella cada llamada responde `EXTRACTION_UNAVAILABLE`. */
  apiKey?: string | null;
  /** Modelo de visión; por defecto `claude-opus-5-5`. */
  model?: string;
  /** Profundidad de razonamiento; `medium` basta para leer una factura. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Tope de tokens de salida; un documento de factura cabe de sobra en 16 000. */
  maxOutputTokens?: number;
  /** Bytes totales de los documentos de una llamada (la API admite 32 MB por petición, y base64 añade un tercio). */
  maxTotalBytes?: number;
  /** Bytes por imagen (límite de la API: 5 MB). */
  maxImageBytes?: number;
  /** Espera máxima de la llamada al modelo. */
  timeoutMs?: number;
  /** Reintentos del SDK ante 429/5xx/red. */
  maxRetries?: number;
  /** Transporte hacia Anthropic, inyectable en pruebas. */
  fetch?: typeof fetch;
}

const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const PDF_MIME = 'application/pdf';
const DEFAULT_MODEL = 'claude-opus-5-5';

export function createDocumentExtractor(supabaseOrConfig: Supabase | SupabaseConfig, options: ExtractorOptions = {}): DocumentExtractor {
  const supabase: Supabase = 'rpc' in supabaseOrConfig ? supabaseOrConfig : createSupabase(supabaseOrConfig);
  const apiKey = options.apiKey?.trim() || null;
  const model = options.model ?? DEFAULT_MODEL;
  const effort = options.effort ?? 'medium';
  const maxOutputTokens = options.maxOutputTokens ?? 16000;
  const maxTotalBytes = options.maxTotalBytes ?? 20 * 1024 * 1024;
  const maxImageBytes = options.maxImageBytes ?? 5 * 1024 * 1024;
  const client = apiKey
    ? new Anthropic({ apiKey, timeout: options.timeoutMs ?? 120_000, maxRetries: options.maxRetries ?? 1, ...(options.fetch ? { fetch: options.fetch as any } : {}) })
    : null;

  return async function extract({ files, prompt, schema }: ExtractArgs): Promise<ExtractResult> {
    if (!client) fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), { reason: 'NO_API_KEY' });
    if (!files.length) fail(422, 'INVALID_OPERATION', 'No hay documentos que extraer.');
    if (typeof prompt !== 'string' || !prompt.trim()) fail(422, 'INVALID_OPERATION', 'Falta el prompt de extracción.');

    const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
    let total = 0;
    for (const [index, file] of files.entries()) {
      const mime = file.mime.toLowerCase();
      const isPdf = mime === PDF_MIME;
      if (!isPdf && !IMAGE_MIMES.has(mime)) fail(422, 'INVALID_FILE', 'Tipo de documento no admitido para la extracción.', { index, id: file.id, mime });
      const bytes = await download(supabase, file);
      total += bytes.byteLength;
      if (!isPdf && bytes.byteLength > maxImageBytes) fail(422, 'INVALID_FILE', 'La imagen supera el tamaño admitido por el modelo.', { index, id: file.id, bytes: bytes.byteLength, maxImageBytes });
      if (total > maxTotalBytes) fail(422, 'INVALID_FILE', 'Los documentos superan el tamaño admitido en una sola extracción.', { bytes: total, maxTotalBytes });
      const data = base64(bytes);
      blocks.push(isPdf
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: file.filename }
        : { type: 'image', source: { type: 'base64', media_type: mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data } });
    }
    blocks.push({ type: 'text', text: files.length === 1 ? 'Documento adjunto: ' + files[0]!.filename : 'Documentos adjuntos, en orden: ' + files.map((f) => f.filename).join(', ') + '. Forman una sola unidad.' });

    const started = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model,
        max_tokens: maxOutputTokens,
        // Sin este opt-in un rechazo del clasificador de seguridad se queda en `stop_reason: refusal`; con él la petición se
        // reintenta en el servidor sobre el modelo que Anthropic recomienda para esa categoría.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
        system: [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: blocks }],
      });
    } catch (error) {
      throw translate(error);
    }

    const usage: ExtractUsage = {
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
    };
    if (response.stop_reason === 'refusal') {
      fail(422, 'EXTRACTION_INVALID', 'El modelo no ha podido procesar este documento.', { errors: ['REFUSAL'], warnings: [], category: response.stop_details?.category ?? null, usage });
    }
    const text = response.content.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text').map((block) => block.text).join('\n');
    if (response.stop_reason === 'max_tokens') {
      fail(422, 'EXTRACTION_INVALID', 'La respuesta del modelo se cortó antes de terminar el JSON.', { errors: ['TRUNCATED'], warnings: [], usage });
    }
    const parsed = parseDocument(text);
    if (!parsed.ok) fail(422, 'EXTRACTION_INVALID', 'El modelo no devolvió un JSON utilizable.', { errors: [parsed.error], warnings: parsed.warnings, usage });
    return { document: parsed.document, warnings: parsed.warnings, usage };
  };
}

async function download(supabase: Supabase, file: ExtractFile): Promise<Uint8Array> {
  const path = file.path.split('/').map(encodeURIComponent).join('/');
  const response: Response = await supabase.remote(`/storage/v1/object/${file.bucket}/${path}`, { service: true, raw: true });
  if (response.status === 404 || response.status === 400) fail(404, 'FILE_NOT_FOUND', 'El documento ya no está en el almacenamiento.', { id: file.id });
  if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', messageFor('STORAGE_UNAVAILABLE'));
  return new Uint8Array(await response.arrayBuffer());
}

/** Base64 por bloques, sin `Buffer`, válido en Deno y en Node. */
export function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Separa el JSON de la prosa: la nota que el modelo escribe antes (ambigüedades) pasa a `warnings`. */
export function parseDocument(text: string): { ok: true; document: unknown; warnings: string[] } | { ok: false; error: string; warnings: string[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  const warnings: string[] = [];
  if (start < 0 || end <= start) return { ok: false, error: 'NO_JSON', warnings: text.trim() ? [text.trim()] : [] };
  const before = text.slice(0, start).replace(/```(?:json)?\s*$/i, '').trim();
  const after = text.slice(end + 1).replace(/^\s*```/, '').trim();
  if (before) warnings.push(before);
  if (after) warnings.push(after);
  try {
    return { ok: true, document: JSON.parse(text.slice(start, end + 1)), warnings };
  } catch {
    return { ok: false, error: 'INVALID_JSON', warnings };
  }
}

/** Errores del SDK → Fault. Definitivos (400/404/413/422) como INVALID_FILE; el resto, EXTRACTION_UNAVAILABLE para que la app ofrezca la vía manual. */
function translate(error: unknown): unknown {
  if (isFault(error)) return error;
  const detail = (reason: string, extra: Record<string, unknown> = {}) => ({ reason, ...extra });
  try {
    if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
      fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('API_KEY_REJECTED', { status: error.status }));
    }
    if (error instanceof Anthropic.RateLimitError) fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('RATE_LIMITED', { status: 429 }));
    if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.UnprocessableEntityError) {
      fail(422, 'INVALID_FILE', 'El proveedor rechazó los documentos: ' + error.message, detail('PROVIDER_REJECTED', { status: error.status }));
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('TIMEOUT'));
    if (error instanceof Anthropic.APIConnectionError) fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('NETWORK'));
    if (error instanceof Anthropic.APIError) fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('PROVIDER_ERROR', { status: error.status ?? null }));
    fail(503, 'EXTRACTION_UNAVAILABLE', messageFor('EXTRACTION_UNAVAILABLE'), detail('UNEXPECTED', { message: (error as Error)?.message ?? null }));
  } catch (fault) {
    return fault;
  }
}
