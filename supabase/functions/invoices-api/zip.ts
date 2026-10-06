/**
 * Escritor ZIP mínimo en streaming (método «store», sin compresión: PDF e imágenes ya vienen comprimidos).
 * Sin dependencias, válido en Deno y en Node; archivos hasta 4 GB (sin ZIP64), nombres en UTF-8 (bit 11).
 * Cabecera local con descriptor de datos (bit 3) para no conocer CRC ni tamaño antes de emitir el contenido.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Update(crc: number, bytes: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function u16(view: DataView, offset: number, value: number): void { view.setUint16(offset, value & 0xffff, true); }
function u32(view: DataView, offset: number, value: number): void { view.setUint32(offset, value >>> 0, true); }

interface Entry { name: Uint8Array; offset: number; crc: number; size: number; time: number; date: number }

export interface ZipEntrySource {
  /** Ruta dentro del ZIP, con `/` como separador. */
  name: string;
  /** Contenido: bytes o flujo de bytes. */
  data: Uint8Array | ReadableStream<Uint8Array>;
  modified?: Date;
}

/**
 * Crea un flujo ZIP a partir de un iterador asíncrono de entradas. Cada entrada se emite según llega; el directorio
 * central va al final. Si `onError` devuelve bytes, se añaden como archivo de aviso en lugar de abortar.
 */
export function zipStream(entries: AsyncIterable<ZipEntrySource> | Iterable<ZipEntrySource>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const central: Entry[] = [];
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (bytes: Uint8Array) => { controller.enqueue(bytes); offset += bytes.length; };
      try {
        for await (const entry of entries as AsyncIterable<ZipEntrySource>) {
          const name = encoder.encode(entry.name);
          const { time, date } = dosDateTime(entry.modified ?? new Date());
          const local = new Uint8Array(30 + name.length);
          const view = new DataView(local.buffer);
          u32(view, 0, 0x04034b50); u16(view, 4, 20); u16(view, 6, 0x0808); u16(view, 8, 0); u16(view, 10, time); u16(view, 12, date);
          u32(view, 14, 0); u32(view, 18, 0); u32(view, 22, 0); u16(view, 26, name.length); u16(view, 28, 0);
          local.set(name, 30);
          const start = offset;
          emit(local);
          let crc = 0; let size = 0;
          if (entry.data instanceof Uint8Array) {
            crc = crc32Update(crc, entry.data); size = entry.data.length; emit(entry.data);
          } else {
            const reader = entry.data.getReader();
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!value || !value.length) continue;
              crc = crc32Update(crc, value); size += value.length; emit(value);
            }
          }
          const descriptor = new Uint8Array(16);
          const dv = new DataView(descriptor.buffer);
          u32(dv, 0, 0x08074b50); u32(dv, 4, crc); u32(dv, 8, size); u32(dv, 12, size);
          emit(descriptor);
          central.push({ name, offset: start, crc, size, time, date });
        }
        const centralStart = offset;
        for (const e of central) {
          const header = new Uint8Array(46 + e.name.length);
          const view = new DataView(header.buffer);
          u32(view, 0, 0x02014b50); u16(view, 4, 20); u16(view, 6, 20); u16(view, 8, 0x0808); u16(view, 10, 0); u16(view, 12, e.time); u16(view, 14, e.date);
          u32(view, 16, e.crc); u32(view, 20, e.size); u32(view, 24, e.size); u16(view, 28, e.name.length); u16(view, 30, 0); u16(view, 32, 0); u16(view, 34, 0); u16(view, 36, 0);
          u32(view, 38, 0); u32(view, 42, e.offset);
          header.set(e.name, 46);
          emit(header);
        }
        const centralSize = offset - centralStart;
        const end = new Uint8Array(22);
        const ev = new DataView(end.buffer);
        u32(ev, 0, 0x06054b50); u16(ev, 4, 0); u16(ev, 6, 0); u16(ev, 8, central.length); u16(ev, 10, central.length); u32(ev, 12, centralSize); u32(ev, 16, centralStart); u16(ev, 20, 0);
        emit(end);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

/** Lee todo un flujo a memoria (para pruebas y para respuestas pequeñas). */
export async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of chunks) { out.set(c, pos); pos += c.length; }
  return out;
}

/** Nombres de las entradas de un ZIP (desde el directorio central), para pruebas. */
export function zipEntryNames(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let eocd = bytes.length - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('ZIP sin directorio central');
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new Error('entrada central inválida');
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    names.push(decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLength)));
    pos += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}
