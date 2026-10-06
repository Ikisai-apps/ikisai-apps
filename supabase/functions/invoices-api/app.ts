/** Ikisai Invoices · API. Configuración de la app sobre el núcleo: hooks de dominio y rutas propias (docs/invoices/API.md §4.1, §6). */
import { createApp, createSupabase, fail, isFault, type AgentRiskAssessment, type AppConfig, type AppRoute, type Operation, type RequestContext, type Supabase } from '../_kit/mod.ts';
import {
  DomainError, EXPORT_CSV_FILES, EXTRACTION_PROMPT_STRUCTURED, FILE_MIMES, IMPORT_JSON_SCHEMA, TABLES, domainMessage, findDuplicateImport, findDuplicateInvoice, fiscalSummary, importDocumentSha256, isBlobMarker,
  matchSupplier, normalizedFilename, proposeImport, purchaseItems, quarterRange, slugify, validTargetPair, validateImportDocument, validateRowFields,
  type AllocationRow, type ExportCsvName, type ExportManifest, type InvoiceLineRow, type InvoiceRow, type SupplierRow, type TaxLineRow,
} from '../_domain/invoices/mod.ts';
import { zipStream, type ZipEntrySource } from './zip.ts';

export const INVOICES_ORIGINS = ['https://invoices.ikisai.com', 'https://ikisai-invoices.pages.dev'];
export const INVOICES_BUCKET = 'purchase-documents';
export const DEFAULT_TASKS_API_BASE = 'https://tasks.ikisai.com';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

export interface InvoicesAppOptions {
  /** Base de la API de Tareas (`https://tasks.ikisai.com` o la función `tasks-api` directa en QA). */
  tasksApiBase?: string;
  /** Transporte hacia la API de Tareas (inyectable en pruebas). */
  tasksFetch?: typeof fetch;
  /**
   * Extracción automática (V2): helper de `_kit` que llama al modelo de visión con los documentos ya subidos.
   * Sin helper (o sin clave en la Edge) la ruta `imports/extract` responde `EXTRACTION_UNAVAILABLE 503`.
   */
  extractInvoice?: ExtractInvoice;
}

/** Firma acordada con Core para el helper de `_kit` (API.md §6, ruta `imports/extract`). */
export type ExtractInvoice = (args: {
  files: Array<{ id: string; bucket: string; path: string; mime: string; filename: string; size: number }>;
  prompt: string;
  ctx: RequestContext;
  /** JSON Schema para forzar la forma de la salida en el proveedor (salida estructurada); el helper de `_kit` lo admite. */
  schema?: Record<string, unknown>;
}) => Promise<{ document: unknown; warnings?: string[]; usage?: unknown }>;

// ---------------------------------------------------------------------------
// Destinos tipados (API.md §7.2)
// ---------------------------------------------------------------------------
export interface TargetInfo {
  app: 'tasks' | 'booking' | 'food';
  kind: string;
  id: string;
  code: string | null;
  label: string;
  path: string[];
  revision: number | null;
  archived: boolean;
}

interface TasksTarget { kind: string; id: string; tabId: string | null; projectId: string | null; title: string; revision: number; deleted: boolean; archived: boolean; done?: boolean }
interface TasksTree { tabs: Array<{ id: string; name: string; revision: number; deleted: boolean; projects: Array<{ id: string; title: string; status: string; revision: number; deleted: boolean; tasks: Array<{ id: string; title: string; done: boolean; revision: number; deleted: boolean }> }> }> }

const TASKS_KIND: Record<string, string> = { area: 'tab', project: 'project', task: 'task' };

function createTargets(supabase: Supabase, options: InvoicesAppOptions) {
  const base = (options.tasksApiBase ?? DEFAULT_TASKS_API_BASE).replace(/\/$/, '');
  const transport = options.tasksFetch ?? fetch;

  /** Lectura `tasks.targets` de la API de Tareas con el token del usuario: solo ve lo que él ve. */
  async function tasksRead<T>(ctx: RequestContext, args: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
      response = await transport(`${base}/api/v1/read/tasks.targets`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + ctx.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      fail(503, 'TARGET_UNAVAILABLE', domainMessage('TARGET_UNAVAILABLE'), { app: 'tasks' });
    }
    const out = await response.json().catch(() => ({}));
    if (response.status === 404) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'tasks', ...args });
    if (response.status === 403 || response.status === 401) fail(422, 'TARGET_FORBIDDEN', domainMessage('TARGET_FORBIDDEN'), { app: 'tasks', ...args });
    if (!response.ok) fail(503, 'TARGET_UNAVAILABLE', domainMessage('TARGET_UNAVAILABLE'), { app: 'tasks', status: response.status, error: out?.error ?? null });
    return out as T;
  }

  async function resolveTasks(ctx: RequestContext, kind: string, id: string): Promise<TargetInfo> {
    const tasksKind = TASKS_KIND[kind];
    if (!tasksKind || !UUID.test(id)) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'tasks', kind, id });
    const t = await tasksRead<TasksTarget>(ctx, { kind: tasksKind, id: id.toLowerCase() });
    if (t.deleted) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'tasks', kind, id, deleted: true });
    return { app: 'tasks', kind, id: t.id, code: null, label: t.title, path: [], revision: t.revision, archived: !!t.archived };
  }

  async function listTasks(ctx: RequestContext, query: string, kind: string | null): Promise<TargetInfo[]> {
    const tree = await tasksRead<TasksTree>(ctx, {});
    const items: TargetInfo[] = [];
    for (const tab of tree.tabs ?? []) {
      if (tab.deleted) continue;
      if (!kind || kind === 'area') items.push({ app: 'tasks', kind: 'area', id: tab.id, code: null, label: tab.name, path: [], revision: tab.revision, archived: false });
      for (const project of tab.projects ?? []) {
        if (project.deleted) continue;
        const archived = project.status === 'archived';
        if (!kind || kind === 'project') items.push({ app: 'tasks', kind: 'project', id: project.id, code: null, label: project.title, path: [tab.name], revision: project.revision, archived });
        if (kind && kind !== 'task') continue;
        for (const task of project.tasks ?? []) {
          if (task.deleted) continue;
          items.push({ app: 'tasks', kind: 'task', id: task.id, code: null, label: task.title, path: [tab.name, project.title], revision: task.revision, archived });
        }
      }
    }
    return filterTargets(items, query);
  }

  /** Lectura registrada de otra app; si la otra app aún no la publica para Invoices → TARGET_APP_NOT_AVAILABLE. */
  async function projection<T>(ctx: RequestContext, name: string, where?: Record<string, string>): Promise<T[]> {
    try {
      const out = await supabase.rpc<{ rows: T[] }>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: name, p_args: { ...(where ? { where } : {}), limit: 2000 } });
      return out.rows;
    } catch (error) {
      if (isFault(error) && error.code === 'INVALID_OPERATION') fail(422, 'TARGET_APP_NOT_AVAILABLE', domainMessage('TARGET_APP_NOT_AVAILABLE'), { name });
      throw error;
    }
  }

  async function resolveFood(ctx: RequestContext, kind: string, id: string): Promise<TargetInfo> {
    if (!UUID.test(id)) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'food', kind, id });
    if (kind === 'ingredient') {
      const rows = await projection<{ ingredient_id: string; name: string; preferred_unit: string | null; active: boolean; ingredient_revision: number }>(ctx, 'food.invoices_ingredient_projection', { ingredient_id: id.toLowerCase() });
      const row = rows[0];
      if (!row) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'food', kind, id });
      return { app: 'food', kind, id: row.ingredient_id, code: null, label: row.name, path: ['Ingredientes'], revision: row.ingredient_revision, archived: !row.active };
    }
    const rows = await projection<{ equipment_id: string; name: string; category: string | null; status: string | null; equipment_revision: number }>(ctx, 'food.invoices_equipment_projection', { equipment_id: id.toLowerCase() });
    const row = rows[0];
    if (!row) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'food', kind, id });
    return { app: 'food', kind, id: row.equipment_id, code: null, label: row.name, path: ['Maquinaria'], revision: row.equipment_revision, archived: false };
  }

  async function listFood(ctx: RequestContext, query: string, kind: string | null): Promise<TargetInfo[]> {
    const items: TargetInfo[] = [];
    if (!kind || kind === 'ingredient') {
      for (const r of await projection<{ ingredient_id: string; name: string; active: boolean; ingredient_revision: number }>(ctx, 'food.invoices_ingredient_projection')) {
        items.push({ app: 'food', kind: 'ingredient', id: r.ingredient_id, code: null, label: r.name, path: ['Ingredientes'], revision: r.ingredient_revision, archived: !r.active });
      }
    }
    if (!kind || kind === 'equipment') {
      for (const r of await projection<{ equipment_id: string; name: string; equipment_revision: number }>(ctx, 'food.invoices_equipment_projection')) {
        items.push({ app: 'food', kind: 'equipment', id: r.equipment_id, code: null, label: r.name, path: ['Maquinaria'], revision: r.equipment_revision, archived: false });
      }
    }
    return filterTargets(items, query);
  }

  interface BookingEvent { event_id: string; event_code: string | null; reservation_code: string | null; title: string; start_date: string; end_date: string; event_revision: number }
  async function resolveBooking(ctx: RequestContext, kind: string, id: string): Promise<TargetInfo> {
    if (kind !== 'event') fail(422, 'TARGET_APP_NOT_AVAILABLE', domainMessage('TARGET_APP_NOT_AVAILABLE'), { app: 'booking', kind });
    if (!UUID.test(id)) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'booking', kind, id });
    const row = (await projection<BookingEvent>(ctx, 'booking.food_event_projection', { event_id: id.toLowerCase() }))[0];
    if (!row) fail(422, 'TARGET_NOT_FOUND', domainMessage('TARGET_NOT_FOUND'), { app: 'booking', kind, id });
    return { app: 'booking', kind, id: row.event_id, code: row.event_code, label: `${row.title} · ${row.start_date}`, path: ['Eventos'], revision: row.event_revision, archived: false };
  }

  async function listBooking(ctx: RequestContext, query: string): Promise<TargetInfo[]> {
    const rows = await projection<BookingEvent>(ctx, 'booking.food_event_projection');
    return filterTargets(rows.map((r) => ({ app: 'booking' as const, kind: 'event', id: r.event_id, code: r.event_code, label: `${r.title} · ${r.start_date}`, path: ['Eventos'], revision: r.event_revision, archived: false })), query);
  }

  async function resolve(ctx: RequestContext, app: string, kind: string, id: string): Promise<TargetInfo> {
    if (app === 'tasks') return resolveTasks(ctx, kind, id);
    if (app === 'food') return resolveFood(ctx, kind, id);
    if (app === 'booking') return resolveBooking(ctx, kind, id);
    fail(422, 'INVALID_FIELDS', 'Aplicación de destino desconocida.', { field: 'target_app' });
  }

  return { resolve, listTasks, listFood, listBooking };
}
type Targets = ReturnType<typeof createTargets>;

function fold(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function filterTargets(items: TargetInfo[], query: string, limit = 50): TargetInfo[] {
  const q = fold(query.trim());
  const words = q ? q.split(/\s+/) : [];
  const matches = items.filter((item) => {
    if (!words.length) return !item.archived;
    const hay = fold([item.label, ...item.path, item.code ?? ''].join(' '));
    return words.every((w) => hay.includes(w));
  });
  matches.sort((a, b) => Number(a.archived) - Number(b.archived) || a.label.localeCompare(b.label, 'es'));
  return matches.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Validación de dominio antes de core.commit
// ---------------------------------------------------------------------------
function throwDomain(error: unknown, index: number): never {
  if (error instanceof DomainError) fail(error.status, error.code, error.message, { ...(error.details ?? {}), index });
  throw error;
}

/** Un documento debe ser un archivo de Invoices ya verificado y de tipo admitido; devuelve los campos que fija el servidor. */
async function verifiedFile(supabase: Supabase, ctx: RequestContext, fileId: unknown, index: number, field = 'file_id'): Promise<{ mime_type: string; size_bytes: number; sha256: string }> {
  if (isBlobMarker(fileId)) fail(422, 'INVALID_FIELDS', 'El adjunto todavía no se ha subido.', { index, field });
  if (typeof fileId !== 'string' || !UUID.test(fileId)) fail(422, 'INVALID_FIELDS', 'Identificador de archivo inválido.', { index, field });
  let file: { status: string; mime: string; size: number; sha256: string };
  try {
    file = await supabase.rpc('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: fileId });
  } catch (error) {
    if (isFault(error) && error.code === 'FILE_NOT_FOUND') fail(422, 'INVALID_FILE', 'El documento no existe o no pertenece a Invoices.', { index, field });
    throw error;
  }
  if (file.status !== 'verified') fail(422, 'INVALID_FILE', 'El documento todavía no se ha subido por completo.', { index, field });
  if (!(FILE_MIMES as readonly string[]).includes(file.mime)) fail(422, 'INVALID_FILE', 'El documento debe ser PDF, WebP, JPEG o PNG.', { index, field, mime: file.mime });
  return { mime_type: file.mime, size_bytes: Number(file.size), sha256: file.sha256 };
}

export function createInvoicesHooks(supabase: Supabase, targets: Targets) {
  return async function beforeCommit(operations: Operation[], ctx: RequestContext): Promise<void> {
    for (const [index, op] of operations.entries()) {
      if (op.op === 'call') {
        if (op.procedure === 'invoices.import_v1') await checkImport(supabase, ctx, op.args ?? {}, index);
        continue;
      }
      if (!op.table?.startsWith('invoices.')) continue;
      const fields = op.fields ?? {};
      if (op.op === 'insert' || op.op === 'update') {
        try { validateRowFields(op.table, op.op, fields); } catch (error) { throwDomain(error, index); }
      }
      if (op.table === TABLES.invoices) {
        if (op.op === 'delete') fail(422, 'INVOICE_NOT_DELETABLE', domainMessage('INVOICE_NOT_DELETABLE'), { index, id: op.id });
        // validada solo por `invoices.validate`, salvo el owner al desarchivar (el trigger exige archivada → validada); anulada solo por `invoices.annul`.
        if (op.op === 'update' && (fields.status === 'anulada' || (fields.status === 'validada' && ctx.membership.role !== 'owner'))) {
          fail(422, 'INVALID_TRANSITION', domainMessage('INVALID_TRANSITION'), { index, to: fields.status });
        }
      }
      if (op.table === TABLES.invoiceFiles && op.op === 'insert') {
        Object.assign(fields, await verifiedFile(supabase, ctx, fields.file_id, index));
      }
      if (op.table === TABLES.allocations && (op.op === 'insert' || op.op === 'update') && 'target_app' in fields && fields.target_app !== 'general') {
        if (!validTargetPair(fields.target_app, fields.target_kind)) fail(422, 'INVALID_FIELDS', 'El tipo de destino no corresponde a esa aplicación.', { index, field: 'target_kind' });
        const info = await targets.resolve(ctx, String(fields.target_app), String(fields.target_kind), String(fields.target_id));
        fields.target_id = info.id;
        fields.target_label = info.path.length ? `${info.path.join(' › ')} › ${info.label}` : info.label;
        fields.target_code = info.code;
        fields.target_revision = info.revision;
      }
      if (op.table === TABLES.exportItems) fail(422, 'INVALID_OPERATION', 'Las filas de entrega las escribe el procedimiento invoices.create_export.', { index });
    }
  };
}

/**
 * Riesgo de dominio de un lote de un agente de IA (contrato §3.1, API.md §4.4). El núcleo ya exige aprobación para borrados,
 * procedimientos no seguros (todos salvo `invoices.import_v1`) y lotes de 10 o más elementos. Aquí se añade:
 * - tocar una factura que ya está en una entrega a la gestoría (o sus artículos, impuestos, documentos o asignaciones);
 * - cambiar una factura validada o archivada, o sus artículos, impuestos o documentos (la devolvería a revisión).
 *   Asignar destinos a una factura validada no cambia sus datos fiscales y no exige aprobación.
 * Cada importación cuenta como un elemento para el umbral, aunque sea una sola operación `call`.
 */
export function createAgentRisk(supabase: Supabase) {
  const CHILDREN: string[] = [TABLES.invoiceLines, TABLES.taxLines, TABLES.allocations, TABLES.invoiceFiles];
  return async function agentRisk(operations: Operation[], ctx: RequestContext): Promise<AgentRiskAssessment> {
    const refs = new Map<string, { allocation: boolean }>();
    const add = (id: unknown, allocation: boolean) => {
      if (typeof id !== 'string' || !UUID.test(id)) return;
      const prev = refs.get(id.toLowerCase());
      refs.set(id.toLowerCase(), { allocation: (prev?.allocation ?? true) && allocation });
    };
    let imports = 0;
    const rows = new Set<string>();
    for (const op of operations) {
      if (op.op === 'call') {
        if (op.procedure === 'invoices.import_v1') imports += 1;
        add((op.args as Record<string, unknown> | undefined)?.invoice_id, false);
        continue;
      }
      if (!op.table) continue;
      if (op.id) rows.add(`${op.table}|${op.id}`);
      const allocation = op.table === TABLES.allocations;
      if (op.op !== 'insert' && (op.table === TABLES.invoices || CHILDREN.includes(op.table))) add(op.id, allocation);
      if (op.op === 'insert' && CHILDREN.includes(op.table)) {
        add(op.fields?.invoice_id, allocation);
        add(op.fields?.invoice_line_id, allocation);
      }
    }
    const reasons: string[] = [];
    if (refs.size) {
      const info = await read<{ rows: Array<{ ref: string; code: string | null; status: string; exported: boolean; delivered: boolean }> }>(
        supabase, ctx, 'invoices.agent_risk', { ids: [...refs.keys()] });
      for (const row of info.rows) {
        const label = row.code ?? 'sin código';
        const reason = row.exported ? `invoice:${row.delivered ? 'delivered' : 'exported'}:${label}`
          : (row.status === 'validada' || row.status === 'archivada') && !refs.get(row.ref.toLowerCase())?.allocation ? `invoice:${row.status}:${label}` : null;
        if (reason && !reasons.includes(reason)) reasons.push(reason);
      }
    }
    return { required: reasons.length > 0, reasons, affectedEstimate: rows.size + imports };
  };
}

async function checkImport(supabase: Supabase, ctx: RequestContext, args: Record<string, unknown>, index: number): Promise<void> {
  const validation = validateImportDocument(args.document);
  if (!validation.ok) fail(422, 'IMPORT_INVALID', domainMessage('IMPORT_INVALID'), { index, errors: validation.errors });
  if (typeof args.document_sha256 !== 'string' || !SHA256.test(args.document_sha256)) fail(422, 'IMPORT_INVALID', domainMessage('IMPORT_INVALID'), { index, path: 'args.document_sha256' });
  if (typeof args.invoice_id !== 'string' || !UUID.test(args.invoice_id)) fail(422, 'IMPORT_INVALID', domainMessage('IMPORT_INVALID'), { index, path: 'args.invoice_id' });
  const supplier = args.supplier as { mode?: string; id?: string } | undefined;
  if (!supplier || (supplier.mode !== 'existing' && supplier.mode !== 'create') || typeof supplier.id !== 'string' || !UUID.test(supplier.id)) {
    fail(422, 'IMPORT_INVALID', domainMessage('IMPORT_INVALID'), { index, path: 'args.supplier' });
  }
  const files = Array.isArray(args.files) ? (args.files as Array<Record<string, unknown>>) : [];
  for (const [i, file] of files.entries()) await verifiedFile(supabase, ctx, file.file_id, index, `files[${i}].file_id`);
}

// ---------------------------------------------------------------------------
// Rutas propias
// ---------------------------------------------------------------------------
async function allRows<T>(supabase: Supabase, ctx: RequestContext, table: string, includeDeleted = false): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 2000) {
    const page = await supabase.rpc<{ rows: T[] }>('core_snapshot_table', { p_app: ctx.app, p_role: ctx.membership.role, p_table: table, p_include_deleted: includeDeleted, p_limit: 2000, p_offset: offset });
    rows.push(...page.rows);
    if (page.rows.length < 2000) return rows;
  }
}

function read<T>(supabase: Supabase, ctx: RequestContext, name: string, args: Record<string, unknown>): Promise<T> {
  return supabase.rpc<T>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: name, p_args: args });
}

function requireEditor(ctx: RequestContext): void {
  if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
}

function attachment(body: BodyInit, contentType: string, filename: string): Response {
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

interface Bundle {
  export: { id: string; code: string; folder_name: string; manifest_sha256: string; status: string };
  manifest_text: string;
  manifest: ExportManifest;
  files: Array<{ invoice_code: string; file_id: string; normalized_filename: string; sha256: string; size_bytes: number; bucket: string | null; path: string | null; status: string | null }>;
  stale: boolean;
}

export function invoicesRoutes(supabase: Supabase, targets: Targets, extractor?: ExtractInvoice): AppRoute[] {
  async function bundle(ctx: RequestContext, id: string): Promise<Bundle> {
    if (!UUID.test(id)) fail(404, 'NOT_FOUND', 'Entrega no encontrada.');
    return read<Bundle>(supabase, ctx, 'invoices.export_bundle', { export_id: id.toLowerCase() });
  }

  return [
    {
      method: 'GET', pattern: 'dashboard', handler: async ({ ctx }) => {
        const [invoices, lines, allocations, suppliers] = await Promise.all([
          allRows<InvoiceRow>(supabase, ctx, TABLES.invoices), allRows<InvoiceLineRow>(supabase, ctx, TABLES.invoiceLines),
          allRows<AllocationRow>(supabase, ctx, TABLES.allocations), allRows<SupplierRow>(supabase, ctx, TABLES.suppliers),
        ]);
        const now = new Date();
        const range = quarterRange(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) + 1);
        const unassigned = purchaseItems({ invoices, lines, suppliers, allocations }, { unassignedOnly: true });
        const totals = await read<Record<string, unknown>>(supabase, ctx, 'invoices.fiscal_summary', { year: range.year, quarter: range.quarter });
        const today = now.toISOString().slice(0, 10);
        return {
          cursor: ctx.bootstrap.cursor,
          counts: {
            pendiente_datos: invoices.filter((i) => i.status === 'pendiente_datos').length,
            pendiente_revision: invoices.filter((i) => i.status === 'pendiente_revision').length,
            revisar_importes: invoices.filter((i) => i.status === 'pendiente_revision' && i.review_reason === 'REVISAR IMPORTES').length,
            sin_asignar: unassigned.items.length,
            sin_pagar: invoices.filter((i) => i.status !== 'anulada' && i.payment_status === 'pendiente').length,
            vencidas: invoices.filter((i) => i.status !== 'anulada' && i.payment_status === 'pendiente' && i.due_date !== null && i.due_date < today).length,
          },
          current_period: totals,
        };
      },
    },
    {
      method: 'POST', pattern: 'imports/preview', handler: async ({ ctx, json }) => {
        requireEditor(ctx);
        const body = await json();
        const validation = validateImportDocument(body.document);
        if (!validation.ok) return { valid: false, errors: validation.errors };
        const document = validation.document;
        const [suppliers, invoices] = await Promise.all([allRows<SupplierRow>(supabase, ctx, TABLES.suppliers), allRows<InvoiceRow>(supabase, ctx, TABLES.invoices)]);
        const matches = matchSupplier(document, suppliers);
        const chosen = body.supplier?.mode === 'existing' && typeof body.supplier.id === 'string' ? suppliers.find((s) => s.id === body.supplier.id) ?? null : matches[0]?.supplier ?? null;
        const sha = await importDocumentSha256(document);
        const proposal = proposeImport(document, chosen, body.invoice ?? {});
        const duplicate = findDuplicateInvoice(document, chosen?.id ?? null, invoices) ?? findDuplicateImport(sha, invoices);
        const supplierSlug = chosen?.slug ?? slugify(document.invoice.supplier_name);
        return {
          valid: true,
          errors: [],
          document_sha256: sha,
          supplier_matches: matches.map((m) => ({ id: m.supplier.id, name: m.supplier.name, tax_id: m.supplier.tax_id, slug: m.supplier.slug, score: m.score, by: m.by })),
          duplicate: duplicate ? { invoice_id: duplicate.id, code: duplicate.code, kind: duplicate.import_sha256 === sha ? 'import' : 'invoice' } : null,
          recalculation: proposal.recalculation,
          proposed: { object: proposal.object, invoice_date: proposal.invoice_date, expense_category: proposal.expense_category, is_investment: proposal.is_investment, deductibility: proposal.deductibility, status: proposal.status, review_reason: proposal.review_reason },
          normalized_filename_preview: normalizedFilename({ invoiceDate: proposal.invoice_date, supplierSlug, object: proposal.object, mime: 'application/pdf' }),
          warnings: proposal.recalculation.warnings,
        };
      },
    },
    {
      /**
       * Extracción automática del documento ya subido (API.md §6). `{file_ids: [uuid]}` → `{document, document_sha256, warnings, usage}`.
       * El documento devuelto se valida contra el schema igual que el JSON pegado; nunca se escribe nada aquí: el cliente lo lleva
       * a la misma vista previa de importación y decide.
       */
      method: 'POST', pattern: 'imports/extract', handler: async ({ ctx, json }) => {
        requireEditor(ctx);
        const body = await json();
        const ids: unknown[] = Array.isArray(body.file_ids) ? body.file_ids : typeof body.file_id === 'string' ? [body.file_id] : [];
        if (!ids.length || ids.length > 8 || ids.some((id) => typeof id !== 'string' || !UUID.test(id))) fail(422, 'INVALID_OPERATION', 'Indica entre 1 y 8 identificadores de documento.', { field: 'file_ids' });
        if (!extractor) fail(503, 'EXTRACTION_UNAVAILABLE', domainMessage('EXTRACTION_UNAVAILABLE'));
        const files: Array<{ id: string; bucket: string; path: string; mime: string; filename: string; size: number }> = [];
        for (const [index, id] of (ids as string[]).entries()) {
          await verifiedFile(supabase, ctx, id, index, `file_ids[${index}]`);
          const file = await supabase.rpc<{ id: string; bucket: string; path: string; mime: string; filename: string; size: number }>('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
          files.push({ id: file.id, bucket: file.bucket, path: file.path, mime: file.mime, filename: file.filename, size: Number(file.size) });
        }
        let out: { document: unknown; warnings?: string[]; usage?: unknown };
        try {
          out = await extractor({ files, prompt: EXTRACTION_PROMPT_STRUCTURED, schema: IMPORT_JSON_SCHEMA, ctx });
        } catch (error) {
          if (isFault(error)) throw error;
          fail(503, 'EXTRACTION_UNAVAILABLE', domainMessage('EXTRACTION_UNAVAILABLE'), { reason: (error as Error)?.message ?? null });
        }
        const validation = validateImportDocument(out.document);
        if (!validation.ok) fail(422, 'EXTRACTION_INVALID', domainMessage('EXTRACTION_INVALID'), { errors: validation.errors, warnings: out.warnings ?? [], usage: out.usage ?? null });
        return { document: validation.document, document_sha256: await importDocumentSha256(validation.document), warnings: out.warnings ?? [], usage: out.usage ?? null };
      },
    },
    {
      method: 'GET', pattern: 'targets/tasks', handler: async ({ ctx, url }) => {
        requireEditor(ctx);
        const kind = url.searchParams.get('kind');
        if (kind && !['area', 'project', 'task'].includes(kind)) fail(422, 'INVALID_FILTER', 'Parámetro kind inválido.');
        return { items: await targets.listTasks(ctx, url.searchParams.get('q') ?? '', kind) };
      },
    },
    { method: 'GET', pattern: 'targets/tasks/:kind/:id', handler: ({ ctx, params }) => targets.resolve(ctx, 'tasks', params.kind ?? '', params.id ?? '') },
    {
      method: 'GET', pattern: 'targets/food', handler: async ({ ctx, url }) => {
        requireEditor(ctx);
        const kind = url.searchParams.get('kind');
        if (kind && !['ingredient', 'equipment'].includes(kind)) fail(422, 'INVALID_FILTER', 'Parámetro kind inválido.');
        return { items: await targets.listFood(ctx, url.searchParams.get('q') ?? '', kind) };
      },
    },
    { method: 'GET', pattern: 'targets/food/:kind/:id', handler: ({ ctx, params }) => targets.resolve(ctx, 'food', params.kind ?? '', params.id ?? '') },
    { method: 'GET', pattern: 'targets/booking', handler: async ({ ctx, url }) => { requireEditor(ctx); return { items: await targets.listBooking(ctx, url.searchParams.get('q') ?? '') }; } },
    { method: 'GET', pattern: 'targets/booking/:kind/:id', handler: ({ ctx, params }) => targets.resolve(ctx, 'booking', params.kind ?? '', params.id ?? '') },
    {
      method: 'POST', pattern: 'exports/accountant', handler: async ({ ctx, json }) => {
        requireEditor(ctx);
        return read(supabase, ctx, 'invoices.export_preview', await json());
      },
    },
    {
      method: 'GET', pattern: 'exports/:id/manifest.json', handler: async ({ ctx, params }) => {
        const b = await bundle(ctx, params.id ?? '');
        return attachment(b.manifest_text, 'application/json; charset=utf-8', `${b.export.folder_name}_manifest.json`);
      },
    },
    {
      method: 'GET', pattern: 'exports/:id/:name', handler: async ({ ctx, params }) => {
        const name = params.name ?? '';
        if (name === 'download') {
          const b = await bundle(ctx, params.id ?? '');
          const missing = b.files.filter((f) => !f.path || f.status !== 'verified');
          if (missing.length) fail(409, 'EXPORT_FILE_MISSING', domainMessage('EXPORT_FILE_MISSING'), { files: missing.map((f) => ({ invoice_code: f.invoice_code, file_id: f.file_id, normalized_filename: f.normalized_filename })) });
          return attachment(zipStream(exportEntries(supabase, b)), 'application/zip', `${b.export.folder_name}.zip`);
        }
        if (!(name in EXPORT_CSV_FILES)) fail(404, 'NOT_FOUND', 'Ruta desconocida.');
        const b = await bundle(ctx, params.id ?? '');
        const csv = EXPORT_CSV_FILES[name as ExportCsvName](b.manifest);
        return attachment(csv, 'text/csv; charset=utf-8', `${b.export.folder_name}_${name}`);
      },
    },
  ];
}

/** Entradas del ZIP: manifest, CSV y los documentos leídos de Storage en streaming. */
async function* exportEntries(supabase: Supabase, b: Bundle): AsyncGenerator<ZipEntrySource> {
  const folder = b.export.folder_name;
  const encoder = new TextEncoder();
  const modified = new Date(b.manifest.export.created_at);
  yield { name: `${folder}/manifest.json`, data: encoder.encode(b.manifest_text), modified };
  for (const [name, build] of Object.entries(EXPORT_CSV_FILES)) yield { name: `${folder}/${name}`, data: encoder.encode(build(b.manifest)), modified };
  for (const file of b.files) {
    const path = (file.path ?? '').split('/').map(encodeURIComponent).join('/');
    const response: Response = await supabase.remote(`/storage/v1/object/${file.bucket}/${path}`, { service: true, raw: true });
    if (!response.ok || !response.body) {
      yield { name: `${folder}/facturas/FALTA_${file.normalized_filename}.txt`, data: encoder.encode(`El documento ${file.normalized_filename} (${file.invoice_code}, sha256 ${file.sha256}) no estaba disponible al generar el ZIP.\n`), modified };
      continue;
    }
    yield { name: `${folder}/facturas/${file.normalized_filename}`, data: response.body, modified };
  }
}

export function createInvoicesApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>> & InvoicesAppOptions) {
  const supabase = createSupabase(base);
  const targets = createTargets(supabase, base);
  return createApp({
    ...base,
    app: 'invoices',
    slug: 'invoices-api',
    origins: base.origins ?? INVOICES_ORIGINS,
    uploads: base.uploads ?? { bucket: INVOICES_BUCKET, maxBytes: 50 * 1024 * 1024, allowedMime: [...FILE_MIMES] },
    hooks: { beforeCommit: createInvoicesHooks(supabase, targets), agentRisk: createAgentRisk(supabase) },
    routes: invoicesRoutes(supabase, targets, base.extractInvoice),
  });
}

/** Resumen fiscal calculado en la Edge sobre filas (misma función que el cliente); lo usan pruebas y agentes. */
export function summarize(invoices: InvoiceRow[], taxLines: TaxLineRow[], year: number, quarter: number) {
  return fiscalSummary({ invoices, taxLines }, quarterRange(year, quarter));
}
