/**
 * Ikisai Booking · SES.HOSPEDAJES: empaquetado (ZIP + Base64), sobres SOAP de las operaciones y lectura de respuestas
 * (docs/booking/API.md §17.3). Puro: usa solo APIs web estándar (CompressionStream), igual en Deno y en Node.
 */
import { escapeXml, SES_NS } from './xml.ts';

// ---------------------------------------------------------------------------
// ZIP con una sola entrada (método deflate), como pide la especificación, y Base64
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP de un único archivo. Fecha fija (1-1-1980) para que el mismo contenido dé siempre los mismos bytes. */
export async function zipSingle(filename: string, content: string): Promise<Uint8Array> {
  const name = new TextEncoder().encode(filename);
  const raw = new TextEncoder().encode(content);
  const packed = await deflateRaw(raw);
  const crc = crc32(raw);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 8, true);
  local.setUint16(10, 0, true); local.setUint16(12, 0x21, true); local.setUint32(14, crc, true);
  local.setUint32(18, packed.length, true); local.setUint32(22, raw.length, true); local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true); central.setUint16(8, 0x0800, true);
  central.setUint16(10, 8, true); central.setUint16(12, 0, true); central.setUint16(14, 0x21, true); central.setUint32(16, crc, true);
  central.setUint32(20, packed.length, true); central.setUint32(24, raw.length, true); central.setUint16(28, name.length, true);
  central.setUint32(42, 0, true);
  const centralOffset = 30 + name.length + packed.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
  end.setUint32(12, 46 + name.length, true); end.setUint32(16, centralOffset, true);
  const parts = [new Uint8Array(local.buffer), name, packed, new Uint8Array(central.buffer), name, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

/** Lee el único archivo de un ZIP propio (para las pruebas y el SES simulado). */
export async function unzipSingle(zip: Uint8Array): Promise<{ filename: string; content: string }> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.getUint32(0, true) !== 0x04034b50) throw new Error('ZIP inválido');
  const method = view.getUint16(8, true);
  const size = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  const extra = view.getUint16(28, true);
  const filename = new TextDecoder().decode(zip.subarray(30, 30 + nameLength));
  const body = zip.subarray(30 + nameLength + extra, 30 + nameLength + extra + size);
  const raw = method === 0 ? body : new Uint8Array(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return { filename, content: new TextDecoder().decode(raw) };
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Sobres SOAP
// ---------------------------------------------------------------------------
export type SesOperation = 'A' | 'B';
export type SesKind = 'RH' | 'PV';

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${SES_NS.soap}" xmlns:com="${SES_NS.comunicacion}"><soapenv:Header/><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

/** Operación `comunicacion`: alta (A) de RH o PV, o anulación (B). La solicitud va en ZIP y Base64. */
export async function communicationEnvelope(input: { landlordCode: string; application: string; operation: SesOperation; kind?: SesKind; solicitud: string }): Promise<{ xml: string; contentSha256: string }> {
  const zip = await zipSingle('solicitud.xml', `<?xml version="1.0" encoding="UTF-8"?>${input.solicitud}`);
  const xml = envelope('<com:comunicacionRequest><peticion><cabecera>'
    + `<codigoArrendador>${escapeXml(input.landlordCode)}</codigoArrendador>`
    + `<aplicacion>${escapeXml(input.application.slice(0, 50))}</aplicacion>`
    + `<tipoOperacion>${input.operation}</tipoOperacion>`
    + (input.kind ? `<tipoComunicacion>${input.kind}</tipoComunicacion>` : '')
    + `</cabecera><solicitud>${toBase64(zip)}</solicitud></peticion></com:comunicacionRequest>`);
  return { xml, contentSha256: await sha256Hex(input.solicitud) };
}

/** Operación `consultaLote`: estado de uno o varios lotes. */
export function batchQueryEnvelope(lots: string[]): string {
  return envelope('<com:consultaLoteRequest><codigosLote>' + lots.map((l) => `<lote>${escapeXml(l)}</lote>`).join('') + '</codigosLote></com:consultaLoteRequest>');
}

// ---------------------------------------------------------------------------
// Lectura de respuestas (tolerante: los ejemplos oficiales usan `codigoRetorno` donde el XSD dice `codigo`, y escriben
// `resutadoComunicacion` en algún sitio)
// ---------------------------------------------------------------------------
const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m ? m[1]!.trim() : null;
};
const tags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g'))].map((m) => m[1]!.trim());
const unescape = (s: string | null) => s?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&') ?? null;

export interface SesSubmitResult { code: number; description: string; lot: string | null }

/** Respuesta de `comunicacion`: 0 = lote aceptado para proceso (con su número); otro código = rechazo de la petición. */
export function parseCommunicationResponse(xml: string): SesSubmitResult {
  const fault = tag(xml, 'faultstring');
  if (fault) return { code: -1, description: unescape(fault) ?? 'SOAP Fault', lot: null };
  const respuesta = tag(xml, 'respuesta') ?? xml;
  const code = Number(tag(respuesta, 'codigoRetorno') ?? tag(respuesta, 'codigo'));
  return { code: Number.isFinite(code) ? code : -1, description: unescape(tag(respuesta, 'descripcion')) ?? '', lot: tag(respuesta, 'lote') };
}

export interface SesItemResult { order: number; code: string | null; cancelled: boolean; errorType: string | null; error: string | null }
export interface SesBatchResult { lot: string; stateCode: number; stateText: string; processedAt: string | null; items: SesItemResult[] }

/** Estado del lote (spec §4): 1 tramitado sin errores, 2 error de cabecera o formato, 3 error inesperado, 4 en proceso,
 * 5 pendiente, 6 tramitado con errores en algunas comunicaciones. */
export type SesBatchOutcome = 'aceptado' | 'en_proceso' | 'parcial' | 'rechazado' | 'error';
export function batchOutcome(stateCode: number): SesBatchOutcome {
  switch (stateCode) {
    case 1: return 'aceptado';
    case 4: case 5: return 'en_proceso';
    case 6: return 'parcial';
    case 2: return 'rechazado';
    default: return 'error';
  }
}

/** Respuesta de `consultaLote`: estado de cada lote y, por comunicación, su código asignado o su error. */
export function parseBatchResponse(xml: string): { code: number; description: string; batches: SesBatchResult[] } {
  const respuesta = tag(xml, 'respuesta') ?? '';
  const code = Number(tag(respuesta, 'codigoRetorno') ?? tag(respuesta, 'codigo') ?? '0');
  const batches = tags(xml, 'resultado').filter((r) => tag(r, 'lote')).map((r) => ({
    lot: tag(r, 'lote')!,
    stateCode: Number(tag(r, 'codigoEstado') ?? -1),
    stateText: unescape(tag(r, 'descEstado')) ?? '',
    processedAt: tag(r, 'fechaProcesamiento'),
    items: [...tags(r, 'resultadoComunicacion'), ...tags(r, 'resutadoComunicacion')].map((c) => ({
      order: Number(tag(c, 'orden') ?? 0),
      code: tag(c, 'codigoComunicacion'),
      cancelled: tag(c, 'anulada') === 'true',
      errorType: unescape(tag(c, 'tipoError')),
      error: unescape(tag(c, 'error')),
    })),
  }));
  return { code: Number.isFinite(code) ? code : -1, description: unescape(tag(respuesta, 'descripcion')) ?? '', batches };
}
