/** Ikisai Invoices · API. Configuración de la app sobre el núcleo: hooks de dominio y rutas propias (docs/invoices/API.md §4.1, §6). */
import { createApp, createGoogleTokenSource, createStorage, createSupabase, createSync, ensureServiceActor, fail, isFault, r2ConfigFromEnv, type AgentRiskAssessment, type AppConfig, type AppHooks, type AppRoute, type CommitResult, type McpTool, type Operation, type RequestContext, type StorageAccess, type Supabase, type WorkerRoute } from '../_kit/mod.ts';
import { sha256Hex, stable } from '../_kit/supabase.ts';
import {
  DomainError, EXPORT_CSV_FILES, buildImportArgs, detectRectification, negateDocument, issuerSnapshot, EXTRACTION_PROMPT_STRUCTURED, FILE_MIMES, IMPORT_JSON_SCHEMA, TABLES, domainMessage, findDuplicateImport, findDuplicateInvoice, fiscalSummary, importDocumentSha256, isBlobMarker,
  matchSupplier, normalizedFilename, proposeImport, purchaseItems, quarterRange, slugify, validTargetPair, validateImportDocument, validateRowFields,
  type AllocationRow, type BuildImportArgsOptions, type ImportFileArg, type ExportCsvName, type ExportManifest, type InvoiceLineRow, type InvoiceRow, type SupplierRow, type TaxLineRow,
} from '../_domain/invoices/mod.ts';
import { zipStream, type ZipEntrySource } from './zip.ts';
import { createGoogleDriveApi, readPdfItemsServer, rereadDriveDrafts, runDriveTick, type DriveApi, type DriveTickDeps, type DriveTickResult } from './drive.ts';
import type { PdfTextItem } from '../_domain/invoices/mod.ts';

// Finance (antes Invoices): finance.ikisai.com es el dominio; invoices.ikisai.com y tramita.ikisai.com redirigen a él (301, fase C).
export const INVOICES_ORIGINS = ['https://finance.ikisai.com', 'https://ikisai-invoices.pages.dev'];
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
  /**
   * Facturas por Google Drive (fase 4, API.md §15). Por defecto, el Drive real si existen `GOOGLE_SERVICE_ACCOUNT_JSON` e
   * `INVOICES_DRIVE_ID`; en las pruebas, uno simulado. `null` la apaga.
   */
  drive?: { api?: DriveApi | null; readPdf?: (bytes: Uint8Array) => Promise<PdfTextItem[]>; limit?: number; upload?: DriveUpload; notifyTasks?: DriveTickDeps['notifyTasks'] | null; today?: () => string };
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

const TASKS_KIND: Record<string, string> = { area: 'tab', project: 'project', task: 'task', purchase_request: 'purchase_request' };

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
    // Solicitud de compra de Tasks (ronda 34): se ve como «Compras › título».
    return { app: 'tasks', kind, id: t.id, code: null, label: t.title, path: kind === 'purchase_request' ? ['Compras'] : [], revision: t.revision, archived: !!t.archived };
  }

  async function listTasks(ctx: RequestContext, query: string, kind: string | null): Promise<TargetInfo[]> {
    if (kind === 'purchase_request') {
      // Modo lista de tasks.targets: solicitudes aprobadas, compradas o recibidas que esperan factura, visibles para el usuario.
      const out = await tasksRead<{ items?: Array<{ id: string; title: string; revision: number; status?: string; estimatedAmount?: number | null }> }>(ctx, { kind: 'purchase_request', q: query, limit: 50 });
      return (out.items ?? []).map((r) => ({ app: 'tasks' as const, kind: 'purchase_request', id: r.id, code: null, label: r.title, path: ['Compras'], revision: r.revision, archived: false }));
    }
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

const isReadingMeta = (v: unknown) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as { reading?: unknown }).reading === 'object' && (v as { reading?: unknown }).reading !== null;

export function createInvoicesHooks(supabase: Supabase, targets: Targets) {
  return async function beforeCommit(operations: Operation[], ctx: RequestContext): Promise<void> {
    let entityRow: { row: Record<string, unknown> | null } | null = null;
    for (const [index, op] of operations.entries()) {
      if (op.op === 'call') {
        if (op.procedure === 'invoices.import_v1') await checkImport(supabase, ctx, op.args ?? {}, index);
        // Completar el emisor (ronda 38): la copia la pone la Edge desde Central; lo que mande el cliente se descarta.
        // Emitir (§14.3): el emisor también lo pone la Edge desde Central.
        if (op.procedure === 'invoices.issue') {
          entityRow ??= { row: await readEntity(supabase, ctx) };
          const snap = issuerSnapshot(entityRow.row);
          if (!snap) fail(422, 'ENTITY_MISSING', domainMessage('ENTITY_MISSING'), { index });
          op.args = { id: op.args?.id, expectedRevision: op.args?.expectedRevision, issuer: snap };
        }
        if (op.procedure === 'invoices.take_issuer') {
          entityRow ??= { row: await readEntity(supabase, ctx) };
          const snap = issuerSnapshot(entityRow.row);
          if (!snap) fail(422, 'ENTITY_MISSING', domainMessage('ENTITY_MISSING'), { index });
          op.args = { ids: op.args?.ids, issuer: snap };
        }
        continue;
      }
      if (!op.table?.startsWith('invoices.')) continue;
      if (op.table === DOCUMENT_TEXTS) fail(422, 'DOCUMENT_TEXT_EDGE_ONLY', domainMessage('DOCUMENT_TEXT_EDGE_ONLY'), { index });
      if (op.table.startsWith('invoices.vf_')) fail(422, 'VF_SERVER_ONLY', domainMessage('VF_SERVER_ONLY'), { index });
      if (op.table === EXTRACTIONS) {
        // Solo la petición de repetir una extracción (un agente la propone; la aprueba un owner humano). El resto lo escribe la Edge.
        const keys = Object.keys(op.fields ?? {});
        if (op.op !== 'insert' || keys.some((k) => k !== 'file_id' && k !== 'invoice_id') || typeof op.fields?.file_id !== 'string' || !UUID.test(op.fields.file_id)) {
          fail(422, 'INVALID_OPERATION', 'El registro de extracciones lo escribe la Edge; solo se puede pedir repetir una extracción con {file_id}.', { index });
        }
        continue;
      }
      const fields = op.fields ?? {};
      if (op.op === 'insert' || op.op === 'update') {
        // La lectura parcial (fase 0, 9-10-2026): solo la cuenta de sistema de Drive escribe `import_meta.reading` en un
        // borrador. Las sesiones de personas tienen un uuid como id de sesión; `service:drive` no se puede suplantar.
        const reading = ctx.user.sessionId === 'service:drive' && op.table === TABLES.invoices && isReadingMeta(fields.import_meta);
        try { validateRowFields(op.table, op.op, fields, { allowImportMeta: reading }); } catch (error) { throwDomain(error, index); }
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
      // Emitidas (API.md §13): sin papelera; documentos comprobados; destino de ingreso en Booking resuelto con el token del usuario.
      // Emisor de una emitida: copia de la entidad de Central al registrarla (ronda 37). Sin datos en Central, queda vacío.
      if (op.table === TABLES.issuedInvoices && op.op === 'insert') {
        entityRow ??= { row: await readEntity(supabase, ctx) };
        const snap = issuerSnapshot(entityRow.row);
        if (snap) Object.assign(fields, { issuer_tax_id: snap.tax_id, issuer_name: snap.legal_name, issuer: snap });
      }
      // Borrar: solo borradores (y lo que cuelga de ellos); lo decide el disparador de la base (ISSUED_NOT_DELETABLE).
      if (op.table === TABLES.issuedFiles && op.op === 'insert') {
        Object.assign(fields, await verifiedFile(supabase, ctx, fields.file_id, index));
      }
      if (op.table === TABLES.issuedAllocations && (op.op === 'insert' || op.op === 'update') && fields.target_app === 'booking') {
        const info = await targets.resolve(ctx, 'booking', String(fields.target_kind), String(fields.target_id));
        fields.target_id = info.id;
        fields.target_label = info.path.length ? `${info.path.join(' › ')} › ${info.label}` : info.label;
        fields.target_code = info.code;
        fields.target_revision = info.revision;
      }
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
    const extractionRequests: string[] = [];
    const issuedChanges: string[] = [];
    for (const op of operations) {
      if (op.op === 'call') {
        if (op.procedure === 'invoices.import_v1') imports += 1;
        add((op.args as Record<string, unknown> | undefined)?.invoice_id, false);
        continue;
      }
      if (!op.table) continue;
      if (op.id) rows.add(`${op.table}|${op.id}`);
      if (op.table === EXTRACTIONS) { extractionRequests.push(String(op.fields?.file_id ?? op.id)); continue; }
      // Registro fiscal de emitidas: cualquier cambio de un agente pide aprobación (API.md §13.2).
      if (op.table.startsWith('invoices.issued_')) { issuedChanges.push(`issued:${op.op}:${op.table.slice('invoices.'.length)}`); continue; }
      const allocation = op.table === TABLES.allocations;
      if (op.op !== 'insert' && (op.table === TABLES.invoices || CHILDREN.includes(op.table))) add(op.id, allocation);
      if (op.op === 'insert' && CHILDREN.includes(op.table)) {
        add(op.fields?.invoice_id, allocation);
        add(op.fields?.invoice_line_id, allocation);
      }
    }
    const reasons: string[] = [...extractionRequests.map((id) => `extract:repeat:${id}`), ...new Set(issuedChanges)];
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

// ---------------------------------------------------------------------------
// Registro de extracciones y límite de los agentes (API.md §6, «Límite de los agentes»)
// ---------------------------------------------------------------------------
const EXTRACTIONS = 'invoices.extractions';
/** Texto de los documentos (API.md §6.9): solo lo escribe la Edge, nunca el cliente. */
const DOCUMENT_TEXTS = 'invoices.document_texts';
const MAX_TEXT_ITEMS = 20_000;

interface ExtractionStatus { file_id: string; done: number; invoice_id: string | null; code: string | null; status: string | null }
interface ApprovedExtraction { rows: Array<{ id: string; file_id: string; revision: number }> }

/** Guarda (o sustituye) el texto con posiciones de un documento ya verificado; devuelve los caracteres útiles. */
async function saveDocumentText(supabase: Supabase, ctx: RequestContext, fileId: string, items: Array<{ str: string; page: number; x: number | null; y: number | null; w: number | null; h: number | null }>): Promise<number> {
  const file = await supabase.rpc<{ sha256: string }>('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: fileId });
  const charCount = items.reduce((n, it) => n + it.str.replace(/\s/g, '').length, 0);
  const existing = await read<{ id: string; revision: number } | null>(supabase, ctx, 'invoices.document_text', { file_id: fileId });
  const fields = { source: 'pdf_text', items, char_count: charCount, sha256: file.sha256 ?? null };
  const operations = existing
    ? [{ op: 'update', table: DOCUMENT_TEXTS, id: existing.id, expectedRevision: existing.revision, fields }]
    : [{ op: 'insert', table: DOCUMENT_TEXTS, id: crypto.randomUUID(), fields: { file_id: fileId, ...fields } }];
  await edgeCommit(supabase, ctx, `doc-text-${crypto.randomUUID()}`, operations, { required: false, id: null, risk: { required: false, reasons: ['document:text'] } });
  return charCount;
}

/** Commit de la Edge con el actor de la petición (lo que hace `POST commands`, sin hooks: las filas las construye la Edge). */
async function edgeCommit(supabase: Supabase, ctx: RequestContext, requestId: string, operations: unknown[], confirmation: Record<string, unknown> | null, digest?: string): Promise<CommitResult> {
  return supabase.rpc<CommitResult>('core_commit', {
    p_app: ctx.app, p_actor: ctx.user.id, p_request_id: requestId, p_digest: digest ?? await sha256Hex(stable(operations)),
    p_expected_cursor: null, p_operations: operations, p_confirmation: ctx.user.kind === 'agent' ? confirmation : null,
  });
}

/**
 * Agente que pide una extracción: sin repetición y con la factura pendiente, sigue. Si no, necesita `confirmationId` de una
 * propuesta aprobada cuyas operaciones sean exactamente inserciones en `invoices.extractions` de estos documentos; se
 * consume aquí (core.commit comprueba requestId, digest, estado y caducidad) y sus filas reciben el resultado.
 */
async function approvedExtraction(supabase: Supabase, ctx: RequestContext, body: Record<string, unknown>, fileIds: string[], status: ExtractionStatus[]): Promise<ApprovedExtraction | null> {
  const reasons: string[] = [];
  for (const row of status) {
    const label = row.code ?? row.file_id;
    if (row.done > 0) reasons.push(`extract:repeat:${label}`);
    else if (row.status && row.status !== 'pendiente_datos') reasons.push(`extract:not_pending:${label}`);
  }
  if (!reasons.length) return null;
  const risk = { required: true, destructive: false, bulk: false, affected: fileIds.length, bulkThreshold: 10, reasons: [...new Set(reasons)] };
  const confirmationId = body.confirmationId;
  if (typeof confirmationId !== 'string' || !UUID.test(confirmationId)) {
    fail(428, 'CONFIRMATION_REQUIRED', 'Repetir la extracción necesita la aprobación de una persona: prepara una propuesta con una inserción en invoices.extractions {file_id} por documento y vuelve con confirmationId.', { risk });
  }
  const proposal = await supabase.rpc<{ id: string; requestId: string; digest: string; operations: Array<{ op: string; table?: string; id?: string; fields?: Record<string, unknown> }>; status: string }>(
    'core_proposal_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: confirmationId });
  // Reintentar un lote ya aplicado devuelve su recibo en core.commit: aquí cada aprobación vale para una sola extracción.
  if (proposal.status !== 'approved') fail(428, 'CONFIRMATION_REQUIRED', 'La propuesta no está aprobada o ya se usó.', { risk, proposalId: proposal.id, proposalStatus: proposal.status });
  const requested = proposal.operations.filter((o) => o.op === 'insert' && o.table === EXTRACTIONS).map((o) => String(o.fields?.file_id ?? '').toLowerCase());
  if (requested.length !== proposal.operations.length || requested.length !== fileIds.length || fileIds.some((id) => !requested.includes(id.toLowerCase()))) {
    fail(428, 'CONFIRMATION_REQUIRED', 'La propuesta aprobada no corresponde a estos documentos.', { risk, proposalId: proposal.id, mismatch: { files: true } });
  }
  const result = await edgeCommit(supabase, ctx, proposal.requestId, proposal.operations, { required: true, id: proposal.id, risk }, proposal.digest);
  const rows = (result.changes ?? []).filter((c: any) => c.table === EXTRACTIONS && c.after).map((c: any) => ({ id: c.after.id as string, file_id: c.after.file_id as string, revision: Number(c.after.revision) }));
  return { rows };
}

/** Una fila por documento con el resultado; el coste (`usage`) va en la primera. Nunca tumba la extracción si falla. */
async function logExtraction(supabase: Supabase, ctx: RequestContext, status: ExtractionStatus[], outcome: 'ok' | 'invalida', usage: unknown, approved: ApprovedExtraction | null): Promise<void> {
  const u = (usage ?? {}) as { model?: string; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number; latencyMs?: number };
  const cost = {
    model: typeof u.model === 'string' ? u.model : null,
    input_tokens: typeof u.inputTokens === 'number' ? u.inputTokens + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) : null,
    output_tokens: typeof u.outputTokens === 'number' ? u.outputTokens : null,
    latency_ms: typeof u.latencyMs === 'number' ? Math.round(u.latencyMs) : null,
  };
  const operations = status.map((row, index) => {
    const fields = { outcome, ...(index === 0 ? cost : {}), ...(row.invoice_id ? { invoice_id: row.invoice_id } : {}) };
    const mine = approved?.rows.find((r) => r.file_id.toLowerCase() === row.file_id.toLowerCase());
    return mine
      ? { op: 'update', table: EXTRACTIONS, id: mine.id, expectedRevision: mine.revision, fields }
      : { op: 'insert', table: EXTRACTIONS, id: crypto.randomUUID(), fields: { file_id: row.file_id, ...fields } };
  });
  try {
    await edgeCommit(supabase, ctx, `extract-log-${crypto.randomUUID()}`, operations, { required: false, id: null, risk: { required: false, reasons: ['extract:log'] } });
  } catch (error) {
    console.warn('[invoices] no se pudo registrar la extracción', error);
  }
}

/** La entidad de Central (una fila) leída con la sesión del usuario; `null` si aún no tiene datos o no está la lectura. */
async function readEntity(supabase: Supabase, ctx: RequestContext): Promise<Record<string, unknown> | null> {
  try {
    const out = await supabase.rpc<{ rows: Array<Record<string, unknown>> }>('core_read', { p_app: ctx.app, p_actor: ctx.user.id, p_name: 'central.common_entity_projection', p_args: { limit: 1 } });
    return out.rows?.[0] ?? null;
  } catch {
    return null;
  }
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
  files: Array<{ folder?: 'facturas' | 'emitidas'; invoice_code: string; file_id: string; normalized_filename: string; sha256: string; size_bytes: number; bucket: string | null; path: string | null; status: string | null; storage_provider?: string | null }>;
  stale: boolean;
}

export function invoicesRoutes(supabase: Supabase, targets: Targets, extractor?: ExtractInvoice, storage: StorageAccess = createStorage(supabase)): AppRoute[] {
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
        // Límite de los agentes (decisión del usuario): una extracción por documento de una factura pendiente; repetirla,
        // o extraer el documento de una factura que ya no está en `pendiente_datos`, exige una propuesta aprobada.
        const status = await read<{ rows: ExtractionStatus[] }>(supabase, ctx, 'invoices.extraction_status', { file_ids: files.map((f) => f.id) });
        const approved = ctx.user.kind === 'agent' ? await approvedExtraction(supabase, ctx, body, files.map((f) => f.id), status.rows) : null;
        let out: { document: unknown; warnings?: string[]; usage?: unknown };
        try {
          out = await extractor({ files, prompt: EXTRACTION_PROMPT_STRUCTURED, schema: IMPORT_JSON_SCHEMA, ctx });
        } catch (error) {
          if (isFault(error)) {
            const usage = (error.details as { usage?: unknown } | null)?.usage;
            if (error.code === 'EXTRACTION_INVALID' && usage) await logExtraction(supabase, ctx, status.rows, 'invalida', usage, approved);
            throw error;
          }
          fail(503, 'EXTRACTION_UNAVAILABLE', domainMessage('EXTRACTION_UNAVAILABLE'), { reason: (error as Error)?.message ?? null });
        }
        const validation = validateImportDocument(out.document);
        await logExtraction(supabase, ctx, status.rows, validation.ok ? 'ok' : 'invalida', out.usage ?? null, approved);
        if (!validation.ok) fail(422, 'EXTRACTION_INVALID', domainMessage('EXTRACTION_INVALID'), { errors: validation.errors, warnings: out.warnings ?? [], usage: out.usage ?? null });
        return { document: validation.document, document_sha256: await importDocumentSha256(validation.document), warnings: out.warnings ?? [], usage: out.usage ?? null };
      },
    },
    {
      /**
       * Entidad emisora (Central, ronda 37): datos para la ficha y la copia imprimible de las emitidas. El logotipo, del
       * bucket privado de Central, va como URL firmada de 10 minutos; no se guarda. Sin datos en Central: `entity: null`.
       */
      method: 'GET', pattern: 'entity', handler: async ({ ctx }) => {
        const row = await readEntity(supabase, ctx);
        const entity = issuerSnapshot(row);
        let logoUrl: string | null = null;
        if (entity && row?.logo_bucket && row?.logo_path) {
          // Contrato §3.9: el proveedor lo dice la fila del archivo (la proyección de Central lo trae en logo_provider, #232).
          const provider = row.logo_provider === 'r2' ? 'r2' : 'supabase';
          try { logoUrl = await storage.readUrl({ bucket: String(row.logo_bucket), path: String(row.logo_path), storage_provider: provider }, 600); } catch { logoUrl = null; }
        }
        return { entity, logo_url: logoUrl, logo_mime: entity && row?.logo_mime ? row.logo_mime : null };
      },
    },
    {
      /**
       * Texto con posiciones de un documento ya subido (fase 3): lo lee el dispositivo con PDF.js (o la Edge con OCR en
       * la fase 4) y aquí se guarda una fila por documento. Solo lo usan los extractores; no se copia a otros sitios.
       */
      method: 'POST', pattern: 'documents/:fileId/text', handler: async ({ ctx, params, json }) => {
        requireEditor(ctx);
        const fileId = params.fileId ?? '';
        if (!UUID.test(fileId)) fail(422, 'INVALID_OPERATION', 'Identificador de documento inválido.');
        const body = await json();
        const source = body.source ?? 'pdf_text';
        if (source !== 'pdf_text') fail(422, 'INVALID_OPERATION', 'Origen de texto no admitido.', { field: 'source' });
        const raw = Array.isArray(body.items) ? body.items : null;
        if (!raw || raw.length > MAX_TEXT_ITEMS) fail(422, 'INVALID_OPERATION', `items debe ser una lista de hasta ${MAX_TEXT_ITEMS} fragmentos.`, { field: 'items' });
        const items = (raw as unknown[]).map((it, i) => {
          const o = it as Record<string, unknown>;
          const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
          if (!o || typeof o.str !== 'string' || o.str.length > 500 || typeof o.page !== 'number' || num(o.x) === null || num(o.y) === null) fail(422, 'INVALID_OPERATION', 'Fragmento de texto inválido.', { index: i });
          return { str: o.str, page: Math.trunc(o.page as number), x: num(o.x), y: num(o.y), w: num(o.w), h: num(o.h) };
        });
        await verifiedFile(supabase, ctx, fileId, 0, 'fileId');
        const charCount = await saveDocumentText(supabase, ctx, fileId, items);
        return { file_id: fileId, char_count: charCount, items: items.length };
      },
    },
    {
      method: 'GET', pattern: 'targets/tasks', handler: async ({ ctx, url }) => {
        requireEditor(ctx);
        const kind = url.searchParams.get('kind');
        if (kind && !['area', 'project', 'task', 'purchase_request'].includes(kind)) fail(422, 'INVALID_FILTER', 'Parámetro kind inválido.');
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
          return attachment(zipStream(exportEntries(storage, b)), 'application/zip', `${b.export.folder_name}.zip`);
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
async function* exportEntries(storage: StorageAccess, b: Bundle): AsyncGenerator<ZipEntrySource> {
  const folder = b.export.folder_name;
  const encoder = new TextEncoder();
  const modified = new Date(b.manifest.export.created_at);
  yield { name: `${folder}/manifest.json`, data: encoder.encode(b.manifest_text), modified };
  for (const [name, build] of Object.entries(EXPORT_CSV_FILES)) yield { name: `${folder}/${name}`, data: encoder.encode(build(b.manifest)), modified };
  for (const file of b.files) {
    let response: Response | null = null;
    try {
      response = await storage.download({ bucket: file.bucket ?? '', path: file.path ?? '', storage_provider: file.storage_provider === 'r2' ? 'r2' : 'supabase' });
    } catch { response = null; }
    if (!response || !response.ok || !response.body) {
      yield { name: `${folder}/${file.folder ?? 'facturas'}/FALTA_${file.normalized_filename}.txt`, data: encoder.encode(`El documento ${file.normalized_filename} (${file.invoice_code}, sha256 ${file.sha256}) no estaba disponible al generar el ZIP.\n`), modified };
      continue;
    }
    yield { name: `${folder}/${file.folder ?? 'facturas'}/${file.normalized_filename}`, data: response.body, modified };
  }
}

export function createInvoicesApp(base: Omit<AppConfig, 'app' | 'slug' | 'origins' | 'hooks' | 'routes' | 'uploads'> & Partial<Pick<AppConfig, 'origins' | 'uploads'>> & InvoicesAppOptions) {
  const supabase = createSupabase(base);
  const targets = createTargets(supabase, base);
  // El mismo almacenamiento que crea el kit (contrato §3.9): proveedor por archivo, R2 si hay secretos.
  const env = (name: string) => (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } }).Deno?.env?.get?.(name);
  const storage = createStorage(supabase, {
    r2: base.storage?.r2 !== undefined ? base.storage.r2 : r2ConfigFromEnv(env),
    defaultProvider: base.storage?.defaultProvider ?? (env('IKISAI_STORAGE_PROVIDER') === 'r2' ? 'r2' : 'supabase'),
    fetch: base.fetch,
  });
  const hooks: AppHooks = { beforeCommit: createInvoicesHooks(supabase, targets), agentRisk: createAgentRisk(supabase) };
  const driveApi = base.drive?.api !== undefined ? base.drive.api : driveFromEnv(env, base.fetch);
  const { run: runDrive, reread: rereadDrive } = createDriveRunner(supabase, storage, hooks, driveApi, { readPdf: base.drive?.readPdf, limit: base.drive?.limit, fetch: base.fetch, upload: base.drive?.upload,
    notifyTasks: base.drive?.notifyTasks === null ? undefined : base.drive?.notifyTasks ?? tasksNotifierFromEnv(env, base.fetch, supabase.base), today: base.drive?.today });
  return createApp({
    ...base,
    app: 'invoices',
    slug: 'invoices-api',
    origins: base.origins ?? INVOICES_ORIGINS,
    uploads: base.uploads ?? { bucket: INVOICES_BUCKET, maxBytes: 50 * 1024 * 1024, allowedMime: [...FILE_MIMES] },
    hooks,
    mcpTools: invoicesMcpTools(supabase, storage),
    routes: [...invoicesRoutes(supabase, targets, base.extractInvoice, storage), {
      // «Buscar ahora» en Ajustes (owner): el mismo tick, sin esperar al planificador.
      method: 'POST', pattern: 'drive/run', handler: async ({ ctx }) => {
        if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo el owner puede buscar en Drive.');
        return runDrive();
      },
    }, {
      // «Volver a leer las pendientes» (owner): los borradores de Drive en «Pendiente de datos», con el lector actual.
      method: 'POST', pattern: 'drive/reread', handler: async ({ ctx }) => {
        if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', 'Solo el owner puede volver a leer.');
        return rereadDrive();
      },
    }],
    workerRoutes: [{ method: 'POST', pattern: 'drive/tick', handler: () => runDrive() } satisfies WorkerRoute],
  });
}

/** Sube los bytes de un archivo ya creado en core.files (por defecto, PUT a la URL firmada del almacenamiento). */
export type DriveUpload = (object: { bucket: string; path: string; storage_provider: 'supabase' | 'r2' }, bytes: Uint8Array) => Promise<void>;

/** Aviso en Tasks por la ruta de worker de su Edge (la directa, nunca el proxy de Pages), con la clave de sistema. */
function tasksNotifierFromEnv(env: (name: string) => string | undefined, transport: typeof fetch | undefined, supabaseBase: string | undefined): DriveTickDeps['notifyTasks'] {
  const key = env('IKISAI_WORKER_KEY');
  const explicit = env('TASKS_WORKER_BASE_URL');
  const base = explicit ? explicit.replace(/\/$/, '') : supabaseBase ? `${supabaseBase.replace(/\/$/, '')}/functions/v1/tasks-api/api/v1/worker` : undefined;
  if (!key || !base) return undefined;
  return async (request) => {
    try {
      const res = await (transport ?? fetch)(`${base}/requests/task`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ikisai-worker-key': key }, body: JSON.stringify(request) });
      await res.body?.cancel();
      return res.ok;
    } catch { return false; }
  };
}

/** Drive real con la cuenta de servicio, o null (integración apagada) si faltan los secretos. */
function driveFromEnv(env: (name: string) => string | undefined, transport?: typeof fetch): DriveApi | null {
  const tokens = createGoogleTokenSource({ serviceAccountJson: env('GOOGLE_SERVICE_ACCOUNT_JSON'), scope: 'https://www.googleapis.com/auth/drive', fetch: transport });
  const driveId = env('INVOICES_DRIVE_ID');
  return tokens && driveId ? createGoogleDriveApi({ driveId, accessToken: () => tokens.accessToken(), fetch: transport }) : null;
}

/**
 * Lo que el tick de Drive usa del núcleo: la cuenta de servicio `drive` (editor en Finance) firma el lote con los hooks
 * de Finance, crea el archivo y guarda el texto; las acciones de sistema llevan el estado y el registro.
 */
function createDriveRunner(supabase: Supabase, storage: StorageAccess, hooks: AppHooks, drive: DriveApi | null, options: { readPdf?: (bytes: Uint8Array) => Promise<PdfTextItem[]>; limit?: number; fetch?: typeof fetch; upload?: DriveUpload; notifyTasks?: DriveTickDeps['notifyTasks']; today?: () => string }) {
  const sync = createSync(supabase, 'invoices', hooks);
  let actor: Promise<RequestContext> | null = null;
  const ctx = () => (actor ??= (async () => {
    const id = await ensureServiceActor(supabase, 'drive');
    return sync.context({ id, email: null, sessionId: 'service:drive', kind: 'human', name: 'Drive (sistema)' }, '');
  })().catch((error) => { actor = null; throw error; }));
  let running: Promise<DriveTickResult> | null = null;
  const tickDeps = (): DriveTickDeps => ({
    drive,
    limit: options.limit,
    invoke: (name, args) => supabase.rpc('core_invoke', { p_app: 'invoices', p_actor: null, p_name: name, p_args: args }),
    rows: async () => {
      const c = await ctx();
      const [suppliers, templates, invoices, files] = await Promise.all([
        allRows<SupplierRow>(supabase, c, TABLES.suppliers), allRows<any>(supabase, c, TABLES.supplierTemplates),
        allRows<InvoiceRow>(supabase, c, TABLES.invoices), allRows<{ invoice_id: string; sha256: string | null; deleted_at: string | null }>(supabase, c, TABLES.invoiceFiles),
      ]);
      return { suppliers, templates: templates.filter((t) => !t.deleted_at && t.status !== 'retirada'), invoices, files };
    },
    storeFile: async (bytes, name, sha) => {
      const c = await ctx();
      const file = await supabase.rpc<any>('core_file_create', {
        p_app: 'invoices', p_actor: c.user.id, p_bucket: INVOICES_BUCKET, p_filename: name.slice(0, 255), p_mime: 'application/pdf', p_size: bytes.length, p_sha256: sha, p_provider: storage.defaultProvider,
      });
      const object = { bucket: INVOICES_BUCKET, path: String(file.path), storage_provider: (file.storageProvider === 'r2' ? 'r2' : 'supabase') as 'supabase' | 'r2' };
      if (options.upload) await options.upload(object, bytes);
      else {
        const upload = await storage.uploadUrl(object, 'application/pdf');
        const put = await (options.fetch ?? fetch)(upload.url, { method: 'PUT', headers: upload.headers, body: bytes });
        if (!put.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo guardar el documento.');
      }
      await supabase.rpc('core_file_mark', { p_id: file.id, p_status: 'verified', p_size: bytes.length, p_hash_verified: true });
      return String(file.id);
    },
    commit: async (requestId, operations) => sync.commit(await ctx(), { requestId, operations }),
    saveText: async (fileId, items) => {
      const num = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
      await saveDocumentText(supabase, await ctx(), fileId, items.slice(0, MAX_TEXT_ITEMS).map((it) => ({ str: it.str.slice(0, 500), page: Math.trunc(it.page), x: num(it.x), y: num(it.y), w: num(it.w), h: num(it.h) })));
    },
    readPdf: options.readPdf ?? readPdfItemsServer,
    uuid: stableUuid,
    notifyTasks: options.notifyTasks,
    today: options.today,
    fileBytes: (fileId: string) => fileBytes(fileId),
  });
  const tick = () => runDriveTick(tickDeps());
  // Bytes de un documento ya guardado (para volver a leerlo), con la cuenta de servicio.
  const fileBytes = async (fileId: string) => {
    const c = await ctx();
    const file = await supabase.rpc<any>('core_file_get', { p_app: 'invoices', p_actor: c.user.id, p_id: fileId });
    const response = await storage.download(file);
    if (!response.ok) fail(503, 'STORAGE_UNAVAILABLE', 'No se pudo leer el documento guardado.');
    return new Uint8Array(await response.arrayBuffer());
  };
  // Un tick a la vez por instancia: «Buscar ahora» mientras corre el del planificador espera al mismo.
  return {
    run: () => (running ??= tick().finally(() => { running = null; })),
    reread: () => { const d = tickDeps(); return rereadDriveDrafts({ rows: d.rows, commit: d.commit, readPdf: d.readPdf, saveText: d.saveText, invoke: d.invoke, fileBytes }); },
  };
}

// ---------------------------------------------------------------------------
// MCP (contrato §3.2, API.md §6.6): herramientas de dominio. Pasan por el camino de siempre (`kit.commit` con hooks,
// riesgo de agente y propuestas; `kit.read` con los permisos de lectura).
// ---------------------------------------------------------------------------
const MCP_PERIOD = {
  year: { type: 'integer', minimum: 2000, maximum: 2100 },
  quarter: { type: 'integer', minimum: 1, maximum: 4 },
  month: { type: 'integer', minimum: 1, maximum: 12 },
  from: { type: 'string', description: 'AAAA-MM-DD (con `to`, periodo libre)' },
  to: { type: 'string', description: 'AAAA-MM-DD' },
};

/** Id estable derivado de un texto (forma de uuid v4) para que reintentar la misma importación sea idempotente. */
async function stableUuid(seed: string): Promise<string> {
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function periodArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ['year', 'quarter', 'month', 'from', 'to']) if (args[key] !== undefined && args[key] !== null) out[key] = args[key];
  if (!Object.keys(out).length) fail(422, 'INVALID_OPERATION', 'Indica el periodo: year (y quarter o month) o from/to.');
  return out;
}

/** Procedencia por campo que manda una IA (0226): validada y recortada antes de guardarla en `import_meta`. */
function iaProvenance(raw: unknown): Record<string, { method: string; text: string | null; page: number | null; confidence: number }> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) fail(422, 'INVALID_OPERATION', 'provenance debe ser un objeto campo → { confidence, text, page }.', { field: 'provenance' });
  const out: Record<string, { method: string; text: string | null; page: number | null; confidence: number }> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>).slice(0, 40)) {
    const v = value as Record<string, unknown> | null;
    const confidence = typeof v?.confidence === 'number' && v.confidence >= 0 && v.confidence <= 1 ? v.confidence : null;
    if (!/^[a-z_.]{1,60}$/.test(field) || confidence === null) fail(422, 'INVALID_OPERATION', 'Cada dato de provenance necesita confidence entre 0 y 1.', { field: `provenance.${field}` });
    out[field] = { method: 'external_ai', text: typeof v?.text === 'string' ? v.text.slice(0, 300) : null, page: Number.isInteger(v?.page) ? Number(v?.page) : null, confidence };
  }
  return out;
}

export function invoicesMcpTools(supabase: Supabase, storage: StorageAccess = createStorage(supabase)): McpTool[] {
  return [
    {
      // §15.1: una sesión de Claude (o cualquier agente editor) completa lo que llegó por Drive sin leer del todo.
      name: 'invoices_pending_drafts',
      description: 'Lista las facturas recibidas en «pendiente de datos» (por defecto, las llegadas por Google Drive): su documento con una URL firmada de 10 minutos para descargarlo y leerlo, y el esquema ikisai.invoice.v1. Para completar una: lee el PDF, construye el JSON y llama a invoices_import_json con su invoice_id, el documento y provenance. Nunca valida nada.',
      minRole: 'editor',
      annotations: { title: 'Borradores por completar', readOnlyHint: true },
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Cuántas devolver (por defecto 10), las más antiguas primero.' },
          only_drive: { type: 'boolean', description: 'Solo las llegadas por Google Drive (por defecto, sí).' },
        },
      },
      handler: async (args, ctx) => {
        const limit = Number.isInteger(args.limit) ? Math.min(Math.max(Number(args.limit), 1), 20) : 10;
        const onlyDrive = args.only_drive !== false;
        const [invoices, files] = await Promise.all([
          allRows<InvoiceRow>(supabase, ctx, TABLES.invoices),
          allRows<{ id: string; invoice_id: string; file_id: string; original_filename: string; normalized_filename: string | null; mime_type: string; size_bytes: number; kind: string; page_order: number; deleted_at: string | null }>(supabase, ctx, TABLES.invoiceFiles),
        ]);
        const pending = invoices.filter((i) => !i.deleted_at && i.status === 'pendiente_datos' && (!onlyDrive || !!i.drive_file_id))
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        const items = [];
        for (const invoice of pending.slice(0, limit)) {
          const docs = files.filter((f) => !f.deleted_at && f.invoice_id === invoice.id && f.kind === 'original').sort((a, b) => a.page_order - b.page_order);
          const documents = [];
          for (const f of docs) {
            const file = await supabase.rpc<any>('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: f.file_id });
            const url = file?.status === 'verified' ? await storage.readUrl(file, 600) : null;
            documents.push({ file_id: f.file_id, filename: f.original_filename, mime: f.mime_type, size: Number(f.size_bytes), url, expires_in_seconds: url ? 600 : null });
          }
          items.push({ invoice_id: invoice.id, code: invoice.code, object: invoice.object, created_at: invoice.created_at, drive_url: invoice.drive_url ?? null, documents });
        }
        return {
          total: pending.length, items,
          how_to_complete: 'Por cada factura: descarga el PDF de documents[].url (caduca en 10 minutos; si caduca, vuelve a pedir la lista), léelo y construye un JSON ikisai.invoice.v1 según json_schema. Si es una factura rectificativa o un abono, dilo en extraction_notes. Llama a invoices_import_json con { invoice_id, document, provenance: { campo: { confidence (0-1), text (lo leído), page } } }. Si no puedes leer algún dato con seguridad, ponlo a null y explícalo en extraction_notes: la persona lo revisa antes de validar.',
          json_schema: IMPORT_JSON_SCHEMA,
        };
      },
    },
    {
      name: 'invoices_import_json',
      description: 'Importa una factura desde un JSON ikisai.invoice.v1 (el del prompt de extracción). Empareja el proveedor por NIF, alias o nombre (o lo crea), recalcula y deja la factura en «pendiente de revisión»: nunca la valida. Opcional: documentos ya subidos (file_ids), una factura existente en «pendiente de datos» (invoice_id, p. ej. una llegada por Drive: se completa sin crear otra) y la procedencia de cada dato (provenance). Reintentar con el mismo JSON no duplica.',
      minRole: 'editor',
      annotations: { title: 'Importar factura desde JSON', destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['document'],
        properties: {
          document: { type: 'object', description: 'Documento ikisai.invoice.v1 completo.' },
          invoice_id: { type: 'string', format: 'uuid', description: 'Factura existente en pendiente_datos donde volcar los datos.' },
          supplier_id: { type: 'string', format: 'uuid', description: 'Forzar un proveedor existente en lugar del emparejamiento automático.' },
          file_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: 8, description: 'Documentos ya subidos y verificados (POST uploads + verify), en orden de página.' },
          rectification: { type: 'object', additionalProperties: false, properties: { number: { type: ['string', 'null'], maxLength: 64, description: 'Número de la factura que rectifica, tal como lo imprime el proveedor.' } },
            description: 'Si es una factura rectificativa, un abono o una devolución: se importa como rectificativa (importes en negativo) y se enlaza sola con la original del mismo proveedor y número.' },
          provenance: { type: 'object', description: 'De dónde sale cada dato: { campo: { confidence (0-1), text, page } }, p. ej. { "invoice.invoice_number": { "confidence": 0.95, "text": "Factura nº A-12", "page": 1 } }. Se guarda en la factura (origen «ia»).' },
        },
      },
      handler: async (args, ctx, kit) => {
        const validation = validateImportDocument(args.document);
        if (!validation.ok) fail(422, 'IMPORT_INVALID', domainMessage('IMPORT_INVALID'), { errors: validation.errors });
        // Rectificativa (0227): la indica la IA (`rectification`) o se deduce del documento (nota o total negativo).
        const detected = detectRectification({ document: validation.document });
        const rectArg = args.rectification && typeof args.rectification === 'object' ? args.rectification as { number?: string | null } : null;
        const isRectification = !!rectArg || detected.isRectification;
        const document = isRectification && validation.document.document_totals.total > 0 ? negateDocument(validation.document) : validation.document;
        const rectifiesNumber = (typeof rectArg?.number === 'string' && rectArg.number.trim() ? rectArg.number.trim().slice(0, 64) : null) ?? detected.number;
        const sha = await importDocumentSha256(document);
        const [suppliers, invoices] = await Promise.all([allRows<SupplierRow>(supabase, ctx, TABLES.suppliers), allRows<InvoiceRow>(supabase, ctx, TABLES.invoices)]);
        const invoiceId = typeof args.invoice_id === 'string' && UUID.test(args.invoice_id) ? args.invoice_id.toLowerCase() : await stableUuid(`invoice:${ctx.user.id}:${sha}`);
        const previous = findDuplicateImport(sha, invoices);
        if (previous) {
          if (previous.id === invoiceId) return { replayed: true, invoice_id: previous.id, code: previous.code, status: previous.status };
          fail(409, 'DUPLICATE_IMPORT', domainMessage('DUPLICATE_IMPORT'), { invoice_id: previous.id, code: previous.code });
        }
        let supplier: BuildImportArgsOptions['supplier'];
        let supplierRow: SupplierRow | null = null;
        if (typeof args.supplier_id === 'string') {
          supplierRow = suppliers.find((s) => s.id === args.supplier_id && !s.deleted_at) ?? null;
          if (!supplierRow) fail(404, 'NOT_FOUND', 'Ese proveedor no existe.', { supplier_id: args.supplier_id });
          supplier = { mode: 'existing', id: supplierRow.id };
        } else {
          const best = matchSupplier(document, suppliers)[0];
          if (best && best.score >= 0.8) { supplierRow = best.supplier; supplier = { mode: 'existing', id: best.supplier.id }; }
          else supplier = { mode: 'create', id: await stableUuid(`supplier:${invoiceId}`) };
        }
        const duplicate = findDuplicateInvoice(document, supplierRow?.id ?? null, invoices);
        if (duplicate) fail(409, 'DUPLICATE_INVOICE', domainMessage('DUPLICATE_INVOICE'), { invoice_id: duplicate.id, code: duplicate.code });
        const fileIds = Array.isArray(args.file_ids) ? args.file_ids as unknown[] : [];
        const files: ImportFileArg[] = [];
        for (const [index, id] of fileIds.entries()) {
          if (typeof id !== 'string' || !UUID.test(id)) fail(422, 'INVALID_OPERATION', 'file_ids debe contener uuids.', { field: `file_ids[${index}]` });
          const file = await supabase.rpc<{ filename: string }>('core_file_get', { p_app: ctx.app, p_actor: ctx.user.id, p_id: id });
          files.push({ file_id: id, original_filename: file.filename, page_order: index + 1 });
        }
        let n = 0;
        const importArgs = buildImportArgs({ document, documentSha256: sha, invoiceId, supplier, files, uuid: () => `${invoiceId.slice(0, 24)}${(++n).toString(16).padStart(12, '0')}`, origin: 'ia', provenance: iaProvenance(args.provenance),
          overrides: isRectification ? { invoice_kind: 'rectificativa', rectifies_number: rectifiesNumber } : undefined });
        const result = await kit.commit({ requestId: `mcp-import-${invoiceId}`, operations: [{ op: 'call', procedure: 'invoices.import_v1', args: importArgs }] }) as CommitResult;
        const after = (result.changes ?? []).find((c: any) => c.table === TABLES.invoices && c.after?.id === invoiceId)?.after as Record<string, unknown> | undefined;
        const proposal = proposeImport(document, supplierRow, {});
        return {
          invoice_id: invoiceId, code: after?.code ?? null, status: after?.status ?? 'pendiente_revision', review_reason: after?.review_reason ?? proposal.review_reason,
          supplier: { mode: supplier.mode, id: supplier.id, name: supplierRow?.name ?? document.invoice.supplier_name },
          recalculation: proposal.recalculation, cursor: result.cursor,
        };
      },
    },
    {
      name: 'invoices_purchases',
      description: 'Compras (artículos de factura) de un periodo, con lo asignado y lo que falta por asignar. Filtros por destino (target_app, target_kind, target_id). Por defecto solo facturas validadas.',
      annotations: { title: 'Compras del periodo', readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: 'object', additionalProperties: false,
        properties: { ...MCP_PERIOD, validated_only: { type: 'boolean', default: true },
          target_app: { type: 'string', enum: ['general', 'tasks', 'food', 'booking'] }, target_kind: { type: 'string' }, target_id: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 2000 }, offset: { type: 'integer', minimum: 0 } },
      },
      handler: async (args, _ctx, kit) => {
        const extra: Record<string, unknown> = {};
        for (const key of ['validated_only', 'target_app', 'target_kind', 'target_id', 'limit', 'offset']) if (args[key] !== undefined) extra[key] = args[key];
        return kit.read('invoices.items', { ...periodArgs(args), ...extra });
      },
    },
    {
      name: 'invoices_fiscal_summary',
      description: 'Resumen fiscal de un periodo (trimestre por defecto): bases, IVA soportado por tipo, retenciones, inversión y facturas pendientes que no entran; en `issued`, el IVA repercutido de las emitidas.',
      annotations: { title: 'Resumen fiscal', readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: 'object', additionalProperties: false, required: ['year'], properties: MCP_PERIOD },
      handler: async (args, _ctx, kit) => {
        const period = periodArgs(args);
        const [received, issued] = await Promise.all([kit.read('invoices.fiscal_summary', period), kit.read('invoices.issued_summary', period)]);
        return { ...(received as Record<string, unknown>), issued };
      },
    },
  ];
}

/** Resumen fiscal calculado en la Edge sobre filas (misma función que el cliente); lo usan pruebas y agentes. */
export function summarize(invoices: InvoiceRow[], taxLines: TaxLineRow[], year: number, quarter: number) {
  return fiscalSummary({ invoices, taxLines }, quarterRange(year, quarter));
}
