/**
 * Código QR para imprimir (petición de Booking, visión V0.2: el QR de entrada de visitantes). Sin red y sin dependencias:
 * codificador propio en modo byte (UTF-8), nivel de corrección M, versiones 1 a 10 (hasta 213 bytes; una URL corta cabe en la 3
 * o la 4). Elige la máscara con menos penalización (reglas 1, 2, 3 y 4 de ISO/IEC 18004).
 * `renderQr` pinta un SVG negro sobre blanco en los dos temas (para imprimir), con `role="img"` y `aria-label`.
 * Prefijo de clases: `qr-`.
 */

const MAX_VERSION = 10;
/** Nivel M, versiones 1 a 10: codewords de corrección por bloque y número de bloques. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
/** Bits de formato del nivel M. */
const ECL_M = 0;

export interface QrOptions {
  /** Ancho y alto en px (por defecto 160). */
  size?: number;
  /** Texto para lectores de pantalla (por defecto, el propio texto). */
  label?: string;
  /** Margen blanco en módulos (por defecto 4, el que pide la norma). */
  margin?: number;
}

/** Módulos del código: `true` es negro. Lanza un error si el texto no cabe en la versión 10. Exportada para las pruebas. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= MAX_VERSION; version++) {
    const ccBits = version < 10 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= dataCodewords(version) * 8 && bytes.length < 1 << ccBits) break;
  }
  if (version > MAX_VERSION) throw new Error(`renderQr: el texto no cabe (${bytes.length} bytes; máximo ${dataCodewords(MAX_VERSION) - 3})`);

  // Datos: modo byte, longitud, bytes, terminador y relleno.
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = dataCodewords(version) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));

  const codewords = interleave(version, data);
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; fixed[y]![x] = true; };

  // Patrones fijos.
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  const align = alignmentPositions(version);
  for (let i = 0; i < align.length; i++) for (let j = 0; j < align.length; j++) {
    const last = align.length - 1;
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i]! + dx, align[j]! + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  drawFormat(set, size, 0);
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vbits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = ((vbits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // Datos en zigzag, de dos en dos columnas desde la derecha.
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (fixed[y]![x] || k >= codewords.length * 8) continue;
      modules[y]![x] = ((codewords[k >>> 3]! >>> (7 - (k & 7))) & 1) === 1;
      k++;
    }
  }

  // Máscara con menos penalización.
  let best = 0;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(modules, fixed, mask);
    drawFormat(set, size, mask);
    const score = penalty(modules);
    if (score < bestScore) { bestScore = score; best = mask; }
    applyMask(modules, fixed, mask);
  }
  applyMask(modules, fixed, best);
  drawFormat(set, size, best);
  return modules;
}

/** SVG del código, negro sobre blanco. */
export function renderQr(text: string, options: QrOptions = {}): SVGSVGElement {
  const modules = qrMatrix(text);
  const margin = Math.max(0, Math.round(options.margin ?? 4));
  const n = modules.length + margin * 2;
  const px = String(Math.round(options.size ?? 160));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ class: 'qr-code', viewBox: `0 0 ${n} ${n}`, width: px, height: px, role: 'img', 'aria-label': options.label ?? text, 'shape-rendering': 'crispEdges', 'data-qr-version': String((modules.length - 17) / 4) })) svg.setAttribute(k, v);
  const bg = document.createElementNS(ns, 'rect');
  for (const [k, v] of Object.entries({ width: String(n), height: String(n), fill: '#ffffff' })) bg.setAttribute(k, v);
  let d = '';
  modules.forEach((row, y) => row.forEach((dark, x) => { if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`; }));
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#000000');
  svg.append(bg, path);
  return svg;
}

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = Math.floor(version / 7) + 2;
    result -= (25 * n - 10) * n - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Resto Reed-Solomon de `data` con `degree` codewords de corrección. Exportada para las pruebas. */
export function rsRemainder(data: readonly number[], degree: number): number[] {
  const divisor = Array<number>(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      divisor[j] = gfMul(divisor[j]!, root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  const result = Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(divisor[i]!, factor);
  }
  return result;
}

function interleave(version: number, data: number[]): number[] {
  const blocks = BLOCKS[version - 1]!;
  const ecc = ECC_PER_BLOCK[version - 1]!;
  const raw = Math.floor(rawModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const all: number[][] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortLength - ecc + (i < shortBlocks ? 0 : 1);
    const part = data.slice(at, at + length);
    at += length;
    const block = [...part, ...rsRemainder(part, ecc)];
    if (i < shortBlocks) block.splice(length, 0, 0);
    all.push(block);
  }
  const out: number[] = [];
  for (let i = 0; i < all[0]!.length; i++) all.forEach((block, j) => { if (i !== shortLength - ecc || j >= shortBlocks) out.push(block[i]!); });
  return out;
}

/** Bits de formato (nivel M y máscara), con su BCH. Exportada para las pruebas. */
export function formatBits(mask: number): number {
  const data = (ECL_M << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(set: (x: number, y: number, dark: boolean) => void, size: number, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

/** Condición de cada máscara (x columna, y fila). Exportada para las pruebas. */
export function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(modules: boolean[][], fixed: boolean[][], mask: number): void {
  for (let y = 0; y < modules.length; y++) for (let x = 0; x < modules.length; x++) {
    if (!fixed[y]![x] && maskBit(mask, x, y)) modules[y]![x] = !modules[y]![x];
  }
}

function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    const seq: boolean[] = [];
    for (let i = 0; i < size; i++) {
      seq.push(get(i));
      if (i > 0 && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
    // Regla 3: 1:1:3:1:1 con cuatro claros a un lado.
    const s = seq.map((b) => (b ? '1' : '0')).join('');
    for (const pattern of ['10111010000', '00001011101']) for (let i = s.indexOf(pattern); i >= 0; i = s.indexOf(pattern, i + 1)) score += 40;
  };
  for (let y = 0; y < size; y++) line((x) => m[y]![x]!);
  for (let x = 0; x < size; x++) line((y) => m[y]![x]!);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y]![x]) dark++;
    if (x < size - 1 && y < size - 1) { const c = m[y]![x]; if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3; }
  }
  score += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return score;
}
