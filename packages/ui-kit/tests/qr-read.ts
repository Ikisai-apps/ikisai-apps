/**
 * Lector mínimo de QR para las pruebas de `renderQr` (v64): lee una matriz sin usar el codificador del kit. Busca la máscara
 * entre los 32 formatos válidos, rehace el mapa de patrones fijos, quita la máscara y recorre el zigzag. Después separa los
 * bloques, comprueba que los síndromes Reed-Solomon son cero y decodifica el modo byte.
 */
const ECC_PER_BLOCK: Record<string, number[]> = { M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26] };
const BLOCKS: Record<string, number[]> = { M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5] };
const ECL_CODE: Record<number, string> = { 0: 'M', 1: 'L', 2: 'H', 3: 'Q' };

const EXP: number[] = [];
const LOG: number[] = [];
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a]! + LOG[b]!) % 255]! : 0);

function bch(data: number): number {
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) if ((rem >>> i) & 1) rem ^= 0x537 << (i - 10);
  return ((data << 10) | rem) ^ 0x5412;
}

export interface QrRead { text: string; version: number; ecl: string; mask: number; syndromesOk: boolean }

export function readQr(m: boolean[][]): QrRead {
  const size = m.length;
  const version = (size - 17) / 4;
  // Formato, copia 1 (alrededor del buscador de arriba a la izquierda).
  const order: [number, number][] = [];
  for (let i = 0; i <= 5; i++) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) order.push([14 - i, 8]);
  let read = 0;
  order.forEach(([x, y], i) => { if (m[y]![x]) read |= 1 << i; });
  let best = -1; let dist = 99;
  for (let d = 0; d < 32; d++) {
    const diff = (bch(d) ^ read).toString(2).replace(/0/g, '').length;
    if (diff < dist) { dist = diff; best = d; }
  }
  if (dist > 0) throw new Error(`formato con ${dist} bits distintos`);
  const ecl = ECL_CODE[best >>> 3]!;
  const mask = best & 7;

  // Patrones fijos.
  const fixed = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < size && y < size) fixed[y]![x] = true; };
  box(0, 0, 9, 9); box(size - 8, 0, 8, 9); box(0, size - 8, 9, 8);
  box(6, 0, 1, size); box(0, 6, size, 1);
  if (version >= 2) {
    const table: Record<number, number[]> = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
    const pos = table[version]!;
    for (const cx of pos) for (const cy of pos) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos.at(-1)) || (cx === pos.at(-1) && cy === 6)) continue;
      box(cx - 2, cy - 2, 5, 5);
    }
  }
  if (version >= 7) { box(size - 11, 0, 3, 6); box(0, size - 11, 6, 3); }

  const maskAt = (x: number, y: number) => [
    (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
    (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0,
    (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ][mask]!;
  const bits: number[] = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j;
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (fixed[y]![x]) continue;
      bits.push((m[y]![x]! !== maskAt(x, y)) ? 1 : 0);
    }
  }
  const total = Math.floor(bits.length / 8);
  const codewords: number[] = [];
  for (let i = 0; i < total; i++) codewords.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));

  // Separar bloques: primero los datos intercalados (los bloques largos con uno más) y luego la corrección.
  const nb = BLOCKS[ecl]![version - 1]!;
  const ecc = ECC_PER_BLOCK[ecl]![version - 1]!;
  const dataTotal = total - nb * ecc;
  const shortData = Math.floor(dataTotal / nb);
  const longCount = dataTotal % nb;
  const blocks = Array.from({ length: nb }, (_, i) => ({ data: [] as number[], ecc: [] as number[], len: shortData + (i >= nb - longCount ? 1 : 0) }));
  let k = 0;
  for (let i = 0; i < shortData + 1; i++) for (const b of blocks) if (i < b.len) b.data.push(codewords[k++]!);
  for (let i = 0; i < ecc; i++) for (const b of blocks) b.ecc.push(codewords[k++]!);
  let syndromesOk = true;
  for (const b of blocks) {
    const word = [...b.data, ...b.ecc];
    for (let i = 0; i < ecc; i++) {
      let s = 0;
      for (const c of word) s = mul(s, EXP[i]!) ^ c;
      if (s !== 0) syndromesOk = false;
    }
  }
  const data = blocks.flatMap((b) => b.data);
  const stream = data.flatMap((byte) => Array.from({ length: 8 }, (_, i) => (byte >>> (7 - i)) & 1));
  let at = 0;
  const take = (n: number) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[at++]!; return v; };
  if (take(4) !== 0b0100) throw new Error('no es modo byte');
  const length = take(version < 10 ? 8 : 16);
  const bytes = Array.from({ length }, () => take(8));
  return { text: new TextDecoder().decode(new Uint8Array(bytes)), version, ecl, mask, syndromesOk };
}
