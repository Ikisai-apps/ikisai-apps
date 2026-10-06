/**
 * Tasks · ZIP mínimo para la copia portable y el respaldo (docs/tasks/API.md §6): entradas almacenadas sin comprimir,
 * nombres UTF-8, CRC-32. Lee solo lo que escribe: un ZIP comprimido por otra herramienta se rechaza con un error claro.
 */
import { reject } from './types.ts';

export interface ZipEntry { path: string; bytes: Uint8Array }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Crea un ZIP con las entradas dadas, sin compresión. */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 0, true);
    local.setUint16(10, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, entry.bytes.length, true); local.setUint32(22, entry.bytes.length, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, entry.bytes);
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true); header.setUint16(4, 20, true); header.setUint16(6, 20, true); header.setUint16(8, 0x0800, true); header.setUint16(10, 0, true);
    header.setUint16(12, 0, true); header.setUint16(14, 0x21, true);
    header.setUint32(16, crc, true); header.setUint32(20, entry.bytes.length, true); header.setUint32(24, entry.bytes.length, true);
    header.setUint16(28, name.length, true); header.setUint32(42, offset, true);
    central.push(new Uint8Array(header.buffer), name);
    offset += 30 + name.length + entry.bytes.length;
  }
  const centralSize = central.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
}

const invalid = (message: string): never => reject(422, 'INVALID_BUNDLE', 'Copia inválida: ' + message);

/** Lee un ZIP creado por `zipStore`. Comprueba tamaños y CRC de cada entrada. */
export function unzipStore(bytes: Uint8Array, limits: { maxEntries?: number } = {}): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) invalid('no es un ZIP.');
  const count = view.getUint16(end + 10, true);
  if (count > (limits.maxEntries ?? 5000)) invalid('demasiados archivos.');
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) invalid('directorio dañado.');
    const method = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true), size = view.getUint32(at + 20, true), stored = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true), local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (method !== 0 || size !== stored) invalid('este ZIP está comprimido; usa una copia exportada por Ikisai.');
    if (path.includes('..') || path.startsWith('/') || path.includes('\\')) invalid('ruta no permitida.');
    if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50) invalid('entrada dañada.');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + size > bytes.length) invalid('entrada truncada.');
    const data = bytes.slice(start, start + size);
    if (crc32(data) !== crc) invalid('un archivo no coincide con su suma de comprobación.');
    entries.push({ path, bytes: data });
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}
