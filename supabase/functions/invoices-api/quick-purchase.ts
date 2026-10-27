/**
 * Capacidad «Registrar compra rápida» (V0.2, primer recorrido de Flow; API.md §18). `POST /api/v1/purchases/quick`.
 *
 * Da de alta una compra con lo mínimo: proveedor (por id, o por nombre y NIF: se reutiliza si ya existe), fecha, importe
 * con IVA, foto o PDF opcional (un archivo de Finance ya subido y verificado) y destino (un evento de Booking o un destino
 * general). Por dentro son las operaciones de fila de siempre (proveedor, factura, línea, IVA, documento y asignación) por
 * `sync.commit`: pasan por `beforeCommit` (documento comprobado en `core.files`, evento resuelto con el token de la persona),
 * el riesgo de agentes y `core.commit`.
 *
 * Idempotente por `requestId`: los ids salen de la persona y el `requestId`, así que repetir la misma petición devuelve el
 * mismo resultado (`replayed: true`) sin duplicar nada; otra petición con el mismo `requestId`, 409 IDEMPOTENCY_REUSE.
 * La compra queda pendiente de revisión: la oficina la completa y la valida en Finance.
 */
import { fail, type CommitResult, type Operation, type RequestContext, type Supabase } from '../_kit/mod.ts';
import { TABLES, TARGET_KINDS, domainMessage } from '../_domain/invoices/mod.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VAT_RATES = [0, 4, 5, 10, 21] as const;

export interface QuickPurchaseInput {
  requestId: string;
  supplier: { id: string } | { name: string; tax_id: string | null };
  date: string;
  /** Importe total con IVA, en euros (dos decimales). */
  total: number;
  /** Tipo de IVA si se sabe; sin él, la línea va por el total y la oficina lo completa al revisar. */
  vat_rate: number | null;
  description: string;
  file_id: string | null;
  target: { app: 'booking'; kind: 'event'; id: string } | { app: 'general'; kind: string };
  notes: string | null;
}

export interface QuickPurchaseResult {
  invoice_id: string;
  code: string | null;
  status: string;
  supplier: { id: string; name: string; created: boolean };
  total: number;
  base: number;
  vat: number | null;
  target: { app: string; kind: string; id: string | null; label: string };
  file_id: string | null;
  replayed: boolean;
  /** Una línea para quien lo pidió: «FVR_2026_012 · Makro · 45,90 € · Retiro de octubre». */
  summary: string;
}

type Commit = (ctx: RequestContext, body: { requestId: string; operations: Operation[] }) => Promise<CommitResult>;

const bad = (field: string, message: string): never => fail(422, 'INVALID_FIELDS', message, { field });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, field: string, max: number, required: boolean): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return required ? bad(field, `Falta ${field}.`) : null;
  if (typeof v !== 'string' || v.trim().length > max) return bad(field, `${field}: texto de hasta ${max} caracteres.`);
  return v.trim();
};
const fold = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const taxKey = (s: string | null | undefined) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const round2 = (n: number) => Math.round(n * 100) / 100;
const eur = (n: number) => `${n.toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')} €`;

/** Valida la entrada de la capacidad; los errores son 422 con `details.field`. */
export function parseQuickPurchase(body: unknown): QuickPurchaseInput {
  if (!isObject(body)) fail(400, 'INVALID_JSON', 'El cuerpo debe ser un objeto JSON.');
  const b = body as Record<string, unknown>;
  if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) bad('requestId', 'requestId: de 1 a 100 caracteres [A-Za-z0-9_.:-].');
  let supplier: QuickPurchaseInput['supplier'];
  if (!isObject(b.supplier)) return bad('supplier', 'Indica el proveedor: {id} o {name, tax_id?}.');
  if (b.supplier.id !== undefined) {
    if (typeof b.supplier.id !== 'string' || !UUID.test(b.supplier.id)) bad('supplier.id', 'Id de proveedor inválido.');
    supplier = { id: (b.supplier.id as string).toLowerCase() };
  } else {
    supplier = { name: text(b.supplier.name, 'supplier.name', 200, true)!, tax_id: text(b.supplier.tax_id, 'supplier.tax_id', 32, false) };
  }
  if (typeof b.date !== 'string' || !DATE.test(b.date) || Number.isNaN(Date.parse(`${b.date}T00:00:00Z`))) bad('date', 'Fecha AAAA-MM-DD.');
  if (typeof b.total !== 'number' || !Number.isFinite(b.total) || b.total <= 0 || b.total > 1_000_000 || round2(b.total) !== b.total) bad('total', 'Importe con IVA, positivo y con dos decimales como mucho.');
  let vat: number | null = null;
  if (b.vat_rate !== undefined && b.vat_rate !== null) {
    if (typeof b.vat_rate !== 'number' || !(VAT_RATES as readonly number[]).includes(b.vat_rate)) bad('vat_rate', 'Tipo de IVA: 0, 4, 5, 10 o 21.');
    vat = b.vat_rate as number;
  }
  const description = text(b.description, 'description', 120, true)!;
  let fileId: string | null = null;
  if (b.file_id !== undefined && b.file_id !== null) {
    if (typeof b.file_id !== 'string' || !UUID.test(b.file_id)) bad('file_id', 'Id de archivo inválido.');
    fileId = (b.file_id as string).toLowerCase();
  }
  if (!isObject(b.target)) return bad('target', 'Indica el destino: {app: "booking", kind: "event", id} o {app: "general", kind}.');
  let target: QuickPurchaseInput['target'];
  if (b.target.app === 'booking') {
    if (b.target.kind !== 'event' || typeof b.target.id !== 'string' || !UUID.test(b.target.id)) bad('target', 'Evento de Booking: {app: "booking", kind: "event", id}.');
    target = { app: 'booking', kind: 'event', id: (b.target.id as string).toLowerCase() };
  } else if (b.target.app === 'general') {
    if (typeof b.target.kind !== 'string' || !TARGET_KINDS.general.includes(b.target.kind)) bad('target.kind', `Destino general: ${TARGET_KINDS.general.join(', ')}.`);
    target = { app: 'general', kind: b.target.kind as string };
  } else return bad('target.app', 'Destino: booking (evento) o general.');
  return { requestId: b.requestId as string, supplier, date: b.date as string, total: b.total as number, vat_rate: vat, description, file_id: fileId, target, notes: text(b.notes, 'notes', 2000, false) };
}

const GENERAL_LABELS: Record<string, string> = { unassigned: 'Sin asignar', operating_expense: 'Gasto de explotación', investment: 'Inversión' };

export function createQuickPurchase(deps: { supabase: Supabase; commit: Commit; allRows: <T>(ctx: RequestContext, table: string) => Promise<T[]>; stableUuid: (seed: string) => Promise<string> }) {
  return async function registerQuickPurchase(ctx: RequestContext, body: unknown): Promise<QuickPurchaseResult> {
    if (!['editor', 'owner'].includes(ctx.membership.role)) fail(403, 'FORBIDDEN', 'Registrar una compra necesita permiso de edición en Finance.');
    const input = parseQuickPurchase(body);
    const seed = (part: string) => deps.stableUuid(`quick-purchase:${ctx.user.id}:${input.requestId}:${part}`);
    const [invoiceId, lineId, taxId, fileLinkId, allocationId, newSupplierId] = await Promise.all(['invoice', 'line', 'tax', 'file', 'allocation', 'supplier'].map(seed));

    // Proveedor: por id; si no, el que ya existe con ese NIF o ese nombre; si no hay, uno nuevo (el de esta petición, si ya se creó).
    const suppliers = await deps.allRows<{ id: string; name: string; label: string | null; tax_id: string | null; deleted_at: string | null }>(ctx, TABLES.suppliers);
    const live = suppliers.filter((s) => !s.deleted_at);
    let supplierId: string; let supplierName: string; let created = false;
    const operations: Operation[] = [];
    if ('id' in input.supplier) {
      const s = live.find((x) => x.id === (input.supplier as { id: string }).id);
      if (!s) fail(422, 'SUPPLIER_NOT_FOUND', 'Ese proveedor no existe en Finance.', { field: 'supplier.id' });
      supplierId = s!.id; supplierName = s!.label ?? s!.name;
    } else {
      const { name, tax_id } = input.supplier;
      const mine = live.find((x) => x.id === newSupplierId);
      const existing = mine ? null : live.find((x) => (tax_id && taxKey(x.tax_id) === taxKey(tax_id)) || (!tax_id && (fold(x.name) === fold(name) || fold(x.label) === fold(name))));
      if (existing) { supplierId = existing.id; supplierName = existing.label ?? existing.name; }
      else {
        // Nuevo (o creado ya por esta misma petición: la misma operación, para que el reintento dé el mismo lote)
        supplierId = newSupplierId; supplierName = name; created = true;
        operations.push({ op: 'insert', table: TABLES.suppliers, id: newSupplierId, fields: { name, ...(tax_id ? { tax_id } : {}) } } as Operation);
      }
    }

    const base = input.vat_rate === null ? input.total : round2(input.total / (1 + input.vat_rate / 100));
    const vat = input.vat_rate === null ? null : round2(input.total - base);
    const generalLabel = input.target.app === 'general' ? GENERAL_LABELS[input.target.kind] ?? input.target.kind : '';
    operations.push(
      { op: 'insert', table: TABLES.invoices, id: invoiceId, fields: { supplier_id: supplierId, invoice_date: input.date, object: input.description, source_total: input.total, ...(input.notes ? { notes: input.notes } : {}) } } as Operation,
      { op: 'insert', table: TABLES.invoiceLines, id: lineId, fields: { invoice_id: invoiceId, position: 0, description: input.description, net_amount: base, ...(input.vat_rate === null ? {} : { vat_rate: input.vat_rate, vat_amount: vat }) } } as Operation,
      ...(input.vat_rate === null ? [] : [{ op: 'insert', table: TABLES.taxLines, id: taxId, fields: { invoice_id: invoiceId, position: 0, tax_type: 'iva', rate: input.vat_rate, taxable_base: base, amount: vat } } as Operation]),
      ...(input.file_id ? [{ op: 'insert', table: TABLES.invoiceFiles, id: fileLinkId, fields: { invoice_id: invoiceId, file_id: input.file_id, original_filename: `compra-${input.date}` } } as Operation] : []),
      { op: 'insert', table: TABLES.allocations, id: allocationId, fields: input.target.app === 'general'
        ? { invoice_line_id: lineId, target_app: 'general', target_kind: input.target.kind, target_id: null, target_label: generalLabel, allocated_amount: base }
        // La etiqueta y la revisión del evento las pone `beforeCommit` con el token de la persona (aquí, provisionales)
        : { invoice_line_id: lineId, target_app: 'booking', target_kind: 'event', target_id: input.target.id, target_label: 'Evento', allocated_amount: base } } as Operation,
    );

    const result = await deps.commit(ctx, { requestId: `quick:${input.requestId}`, operations });
    // La última imagen de la fila en el lote (los disparadores pueden cambiarla después del alta)
    const after = (table: string, id: string) => [...(result.changes ?? [])].reverse().find((c) => c.table === table && c.id === id)?.after ?? undefined;
    let invoice = after(TABLES.invoices, invoiceId);
    let allocation = after(TABLES.allocations, allocationId);
    if (!invoice || !allocation) {
      // Respuesta repetida sin imágenes: se leen las filas
      invoice = (await deps.allRows<Record<string, unknown>>(ctx, TABLES.invoices)).find((r) => r.id === invoiceId);
      allocation = (await deps.allRows<Record<string, unknown>>(ctx, TABLES.allocations)).find((r) => r.id === allocationId);
    }
    if (!invoice) fail(500, 'QUICK_PURCHASE_LOST', domainMessage('QUICK_PURCHASE_LOST', 'La compra no aparece tras registrarla.'));
    const label = String(allocation?.target_label ?? generalLabel);
    const code = (invoice!.code as string | null) ?? null;
    return {
      invoice_id: invoiceId, code, status: String(invoice!.status), supplier: { id: supplierId, name: supplierName, created }, total: input.total, base, vat,
      target: { app: input.target.app, kind: input.target.kind, id: input.target.app === 'booking' ? input.target.id : null, label },
      file_id: input.file_id, replayed: !!result.replayed,
      summary: [code ?? 'Compra', supplierName, eur(input.total), label].join(' · '),
    };
  };
}
