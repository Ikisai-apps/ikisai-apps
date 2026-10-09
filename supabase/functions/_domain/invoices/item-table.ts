/**
 * Artículos aprendidos (9-10-2026, petición del usuario vía Core). Al validar una factura con sus artículos, se localiza
 * en el texto del PDF la tabla de artículos (fila de cabecera y columnas de descripción, cantidad, precio e importe) y se
 * guarda en la plantilla del proveedor (`fields.__items`). En la siguiente factura de ese proveedor, las filas de esa
 * tabla salen como líneas. Los totales no se tocan: si la suma de las filas no cuadra con la base, se dejan las líneas por
 * tipo de IVA y se avisa.
 */
import { amountsIn, type PdfCell, type PdfLine } from './pdf-extract.ts';

export interface ItemColumn { x: number; x2: number }
export interface ItemTableRule {
  kind: 'items_table';
  /** Palabras de la fila de cabecera («descripcion», «cantidad», «precio», «importe»…). */
  header: string[];
  page: number;
  columns: { description: ItemColumn; amount: ItemColumn; quantity: ItemColumn | null; unit_price: ItemColumn | null };
  hits: number;
  misses: number;
  streak_misses: number;
  retired?: boolean;
}
/** Un artículo confirmado (las líneas de la factura validada). */
export interface ConfirmedItem { description: string; quantity: number | null; unit_price: number | null; net_amount: number }
/** Un artículo leído de la tabla. */
export interface ReadItem { description: string; quantity: number | null; unit_price: number | null; net_amount: number; page: number; text: string }

export const ITEMS_KEY = '__items';
const RETIRE_AFTER_MISSES = 3;
/** Fin de la tabla: los totales o el pie. */
const STOP = /^(?:base imponible|base|subtotal|sub total|suma|total|importe neto|neto|iva\b|i v a|cuota|forma de pago|vencimiento|observaciones|recargo)/;
/** Líneas genéricas que pone el lector (una por tipo de IVA): no son artículos. */
const GENERIC = /seg[uú]n documento$/i;

const norm = (t: string) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const words = (t: string) => norm(t).split(' ').filter((w) => w.length >= 3 && !/\d/.test(w));
const cents = (v: number) => Math.round(Math.abs(v) * 100);
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const col = (cells: PdfCell[]): ItemColumn => ({ x: Math.round(median(cells.map((c) => c.x))), x2: Math.round(median(cells.map((c) => c.x2))) });
const amountsOf = (c: PdfCell) => amountsIn(c.text);
/** Números de una celda: importes y también cantidades enteras («2», «12 uds»). */
const numbersOf = (c: PdfCell) => { const a = amountsIn(c.text); if (a.length) return a; const m = c.text.trim().match(/^(-?\d{1,6})(?:\s*[a-z.]{0,5})?$/i); return m ? [Number(m[1])] : []; };
/** La celda está en la columna: se solapan o sus bordes derechos (números alineados a la derecha) casi coinciden. */
const inColumn = (c: PdfCell, k: ItemColumn, slack = 12) => (c.x <= k.x2 + slack && c.x2 >= k.x - slack) || Math.abs(c.x2 - k.x2) <= slack;

/** Aprende la tabla de artículos a partir de las líneas confirmadas; `null` si no se localiza con seguridad. */
export function learnItemTable(lines: PdfLine[], items: ConfirmedItem[]): ItemTableRule | null {
  const real = items.filter((i) => i.net_amount && !GENERIC.test(i.description.trim()));
  if (real.length < 2) return null;
  const used = new Set<PdfLine>();
  const rows: Array<{ line: PdfLine; item: ConfirmedItem; amount: PdfCell; desc: PdfCell; qty: PdfCell | null; price: PdfCell | null }> = [];
  for (const item of real) {
    const want = words(item.description);
    let best: (typeof rows)[number] | null = null; let bestScore = 0;
    for (const line of lines) {
      if (used.has(line) || !line.cells?.length) continue;
      const amount = [...line.cells].reverse().find((c) => amountsOf(c).some((a) => cents(a) === cents(item.net_amount)));
      if (!amount) continue;
      const desc = line.cells.filter((c) => c !== amount).map((c) => ({ c, score: words(c.text).filter((w) => want.includes(w)).length })).sort((a, b) => b.score - a.score)[0];
      if (!desc || desc.score < 1) continue;
      const score = desc.score / Math.max(1, want.length);
      if (score > bestScore) {
        const qty = item.quantity !== null ? line.cells.find((c) => c !== amount && c !== desc.c && numbersOf(c).some((a) => Math.abs(a - Number(item.quantity)) < 0.0005)) ?? null : null;
        const price = item.unit_price !== null ? line.cells.find((c) => c !== amount && c !== desc.c && c !== qty && amountsOf(c).some((a) => Math.abs(a - Number(item.unit_price)) < 0.00005)) ?? null : null;
        best = { line, item, amount, desc: desc.c, qty, price }; bestScore = score;
      }
    }
    if (best) { rows.push(best); used.add(best.line); }
  }
  if (rows.length < Math.max(2, Math.ceil(real.length * 0.6))) return null;
  // Cabecera: la línea más cercana por encima de la primera fila, en su página, con varias palabras y sin importes.
  const first = rows.reduce((a, b) => (b.line.page < a.line.page || (b.line.page === a.line.page && b.line.y > a.line.y) ? b : a));
  const idx = lines.indexOf(first.line);
  let header: string[] = [];
  for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
    const l = lines[i]!;
    if (l.page !== first.line.page) break;
    if (!amountsIn(l.text).length && words(l.text).length >= 2) { header = [...new Set(words(l.text))].slice(0, 12); break; }
  }
  if (header.length < 2) return null;
  const qtys = rows.map((r) => r.qty).filter(Boolean) as PdfCell[];
  const prices = rows.map((r) => r.price).filter(Boolean) as PdfCell[];
  return {
    kind: 'items_table', header, page: first.line.page,
    columns: { description: col(rows.map((r) => r.desc)), amount: col(rows.map((r) => r.amount)), quantity: qtys.length >= rows.length / 2 ? col(qtys) : null, unit_price: prices.length >= rows.length / 2 ? col(prices) : null },
    hits: 1, misses: 0, streak_misses: 0,
  };
}

/** Las filas de la tabla aprendida en este documento (todas las páginas donde se repite la cabecera). */
export function applyItemTable(lines: PdfLine[], rule: ItemTableRule): ReadItem[] {
  const head = new Set(rule.header);
  const need = Math.min(head.size, Math.max(2, Math.ceil(head.size * 0.6)));
  const out: ReadItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!;
    if (words(h.text).filter((w) => head.has(w)).length < need || amountsIn(h.text).length) continue;
    let gaps = 0;
    for (let j = i + 1; j < lines.length && lines[j]!.page === h.page; j++) {
      const l = lines[j]!;
      if (STOP.test(norm(l.text))) break;
      const cells = l.cells ?? [];
      const amount = [...cells].reverse().find((c) => inColumn(c, rule.columns.amount) && amountsOf(c).length);
      const descCells = cells.filter((c) => c !== amount && inColumn(c, rule.columns.description, 20) && !(rule.columns.quantity && inColumn(c, rule.columns.quantity)) && !(rule.columns.unit_price && inColumn(c, rule.columns.unit_price)));
      const description = descCells.map((c) => c.text).join(' ').trim();
      if (!amount) {
        // Continuación de la descripción de la fila anterior, o un hueco (como mucho uno seguido).
        if (description && out.length && out[out.length - 1]!.page === l.page && j > i + 1) { out[out.length - 1]!.description = `${out[out.length - 1]!.description} ${description}`.slice(0, 500); continue; }
        if (++gaps > 1) break;
        continue;
      }
      gaps = 0;
      const amounts = amountsOf(amount);
      const pick = (k: ItemColumn | null) => { if (!k) return null; const c = cells.find((x) => x !== amount && inColumn(x, k)); const a = c ? numbersOf(c) : []; return a.length ? a[a.length - 1]! : null; };
      out.push({ description: description || `Artículo ${out.length + 1}`, quantity: pick(rule.columns.quantity), unit_price: pick(rule.columns.unit_price), net_amount: amounts[amounts.length - 1]!, page: l.page, text: l.text });
    }
  }
  return out;
}

/** ¿La tabla leída da exactamente los artículos confirmados (mismos importes)? */
export function itemsMatch(read: ReadItem[], confirmed: ConfirmedItem[]): boolean {
  const real = confirmed.filter((i) => i.net_amount && !GENERIC.test(i.description.trim()));
  if (read.length !== real.length) return false;
  const a = read.map((r) => cents(r.net_amount)).sort((x, y) => x - y);
  const b = real.map((r) => cents(r.net_amount)).sort((x, y) => x - y);
  return a.every((v, i) => v === b[i]);
}

/** Lo que una confirmación enseña sobre la tabla: acierto, fallo (sin cambiarla por una factura rara) o regla nueva. */
export function learnItemsFromConfirmation(lines: PdfLine[], items: ConfirmedItem[], current: ItemTableRule | null): { rule: ItemTableRule | null; outcome: 'hit' | 'miss' | 'learned' | 'none' } {
  if (current && !current.retired) {
    if (itemsMatch(applyItemTable(lines, current), items)) return { rule: { ...current, hits: current.hits + 1, streak_misses: 0 }, outcome: 'hit' };
    const fresh = learnItemTable(lines, items);
    if (!fresh) return { rule: current, outcome: 'none' }; // sin artículos reconocibles en el documento: no cuenta como fallo
    const streak = current.streak_misses + 1;
    return { rule: { ...current, misses: current.misses + 1, streak_misses: streak, retired: streak >= RETIRE_AFTER_MISSES }, outcome: 'miss' };
  }
  const fresh = learnItemTable(lines, items);
  return fresh ? { rule: fresh, outcome: 'learned' } : { rule: current, outcome: 'none' };
}
