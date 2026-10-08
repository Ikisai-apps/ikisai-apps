/**
 * Facturas rectificativas RECIBIDAS (abonos y devoluciones de proveedores, migración 0227, API.md §2.1).
 *
 * - `detectRectification`: la lectura del PDF (o la nota de la IA) dice si es una rectificativa y a qué número rectifica.
 * - `negateDocument`: algunos proveedores imprimen el abono en positivo; como rectificativa se importa en negativo.
 * - `proposeRectificationAllocations`: el reparto de la rectificativa se propone igual que el de la original, en
 *   proporción y con signo negativo, para que el coste de la obra o del retiro baje solo. Editable antes de guardarlo.
 */
import type { ImportDocument } from './import-v1.schema.ts';

export interface RectificationDetection {
  isRectification: boolean;
  /** Número de la factura rectificada tal como lo imprime el proveedor. */
  number: string | null;
  /** Texto que lo delata (para la procedencia y el aviso). */
  evidence: string | null;
}

const MARKER = /(factura\s+rectificativa|rectificativa|nota\s+de\s+abono|factura\s+de\s+abono|\babono\b|devoluci[oó]n|credit\s+note)/i;
const RECTIFIED_NUMBER = /(?:rectifica(?:da|tiva)?(?:\s+(?:a|de))?(?:\s+(?:la|el))?(?:\s+factura)?|factura\s+(?:rectificada|original|de\s+origen|afectada)|abono\s+(?:de|a)\s+(?:la\s+)?factura|s\/\s*factura|ref(?:erencia)?\.?\s+factura)\s*(?:n(?:[ºo°]|úm(?:ero)?)?\.?\s*)?[:#]?\s*((?=[A-Z0-9\-/_.]*\d)[A-Z0-9][A-Z0-9\-/_.]{1,40})/i;

/** ¿Es una rectificativa? Por el texto del documento (líneas del PDF o notas de la IA) o por un total negativo. */
export function detectRectification(input: { text?: string | null; document?: ImportDocument | null }): RectificationDetection {
  const text = [input.text ?? '', input.document?.extraction_notes ?? '', input.document?.invoice.object ?? ''].join('\n');
  const marker = text.match(MARKER);
  const negative = (input.document?.document_totals.total ?? 0) < 0;
  const own = input.document?.invoice.invoice_number?.trim().toLowerCase() ?? null;
  let number: string | null = null;
  for (const m of text.matchAll(new RegExp(RECTIFIED_NUMBER.source, 'gi'))) {
    const candidate = m[1]!.replace(/[.,;:]+$/, '');
    if (candidate.toLowerCase() !== own && /\d/.test(candidate)) { number = candidate; break; }
  }
  const isRectification = !!marker || negative;
  return { isRectification, number: isRectification ? number : null, evidence: marker?.[0] ?? (negative ? 'total negativo' : null) };
}

const neg = (v: number | null | undefined) => (v === null || v === undefined ? v ?? null : v === 0 ? 0 : -Math.abs(v));

/** El mismo documento con base, impuestos, retención y total en negativo (abono impreso en positivo). */
export function negateDocument(document: ImportDocument): ImportDocument {
  return {
    ...document,
    lines: document.lines.map((l) => ({ ...l, net_amount: neg(l.net_amount) as number, vat_amount: neg(l.vat_amount), gross_amount: neg(l.gross_amount) })),
    taxes: document.taxes.map((t) => ({ ...t, taxable_base: neg(t.taxable_base), amount: neg(t.amount) as number })),
    document_totals: Object.fromEntries(Object.entries(document.document_totals).map(([k, v]) => [k, typeof v === 'number' ? neg(v) : v])) as ImportDocument['document_totals'],
  };
}

export interface AllocationLike {
  invoice_line_id: string; target_app: string; target_kind: string; target_id: string | null; target_code: string | null;
  target_label: string; target_revision: number | null; allocated_amount: number; deleted_at?: string | null;
}
export interface LineLike { id: string; net_amount: number; rectifies_line_id?: string | null; deleted_at?: string | null }
export type ProposedAllocation = Omit<AllocationLike, 'deleted_at'>;

const cents = (v: number) => Math.round(v * 100);

/**
 * Reparto propuesto para una rectificativa: cada línea devuelta (con `rectifies_line_id`) toma las asignaciones de su
 * línea original en proporción; las demás, las de toda la original en proporción a lo asignado. Importes negativos,
 * repartidos en céntimos sin pasar del valor absoluto de la línea.
 */
export function proposeRectificationAllocations(input: { rectLines: LineLike[]; originalLines: LineLike[]; originalAllocations: AllocationLike[] }): ProposedAllocation[] {
  const live = input.originalAllocations.filter((a) => !a.deleted_at && a.allocated_amount > 0);
  const lineById = new Map(input.originalLines.filter((l) => !l.deleted_at).map((l) => [l.id, l]));
  const out: ProposedAllocation[] = [];
  for (const line of input.rectLines.filter((l) => !l.deleted_at && l.net_amount < 0)) {
    const original = line.rectifies_line_id ? lineById.get(line.rectifies_line_id) : undefined;
    const sources = original ? live.filter((a) => a.invoice_line_id === original.id) : live;
    const weightTotal = original ? Math.abs(original.net_amount) : sources.reduce((n, a) => n + a.allocated_amount, 0);
    if (!sources.length || weightTotal <= 0) continue;
    const lineCents = cents(Math.abs(line.net_amount));
    // En proporción, sin pasar de la línea (una original asignada solo en parte deja el resto sin asignar).
    let budget = Math.min(lineCents, original ? Math.round(lineCents * Math.min(1, sources.reduce((n, a) => n + a.allocated_amount, 0) / weightTotal)) : lineCents);
    sources.forEach((a, i) => {
      const share = i === sources.length - 1 ? budget : Math.min(budget, Math.round(lineCents * (a.allocated_amount / weightTotal)));
      budget -= share;
      if (share > 0) {
        out.push({ invoice_line_id: line.id, target_app: a.target_app, target_kind: a.target_kind, target_id: a.target_id, target_code: a.target_code,
          target_label: a.target_label, target_revision: a.target_revision, allocated_amount: -share / 100 });
      }
    });
  }
  return out;
}
