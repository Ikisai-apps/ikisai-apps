/**
 * API falsa en memoria con el contrato que espera @ikisai/sync-client (docs/core/CONTRATO_SINCRONIZACION.md §4-§5):
 * login/refresh/logout, bootstrap, snapshot, changes, commands con revisiones, recibos idempotentes y conflictos 409.
 * Solo para pruebas de extremo a extremo del frontend; no sustituye a la suite de conformidad de packages/test-kit.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { TABLES, WRITABLE, formatIssuedNumber, issueMissing, normalizedFilename, proposeImport, recalculate, slugify, validateImportDocument, vfAltaString, vfQrUrl, type ImportDocument } from '../../packages/domain-invoices/src/index.ts';

export interface FakeRow {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  deleted_at: string | null;
  [column: string]: unknown;
}

interface FakeChange {
  cursor: number;
  seq: number;
  at: string;
  actorId: string | null;
  requestId: string | null;
  table: string;
  id: string;
  op: string;
  revision: number | null;
  after: FakeRow | null;
}

interface FakeOperation {
  op: 'insert' | 'update' | 'delete' | 'restore' | 'call';
  table?: string;
  id?: string;
  expectedRevision?: number;
  fields?: Record<string, unknown>;
}

export interface FakeTarget {
  app: 'tasks' | 'food' | 'booking';
  kind: string;
  id: string;
  label: string;
  path?: string[];
  revision: number;
}

export interface FakeUpload {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  bytes: Buffer | null;
  status: 'pending' | 'verified' | 'missing';
}

export interface FakeApiOptions {
  users?: Array<{ email: string; password: string; displayName?: string; role?: 'owner' | 'editor' | 'reader' }>;
  tables?: Record<string, string[]>;
  /** Destinos conocidos de Tareas y Cocina (la Edge real los resuelve con el token del usuario). */
  targets?: FakeTarget[];
}

/** Reporte de feedback tal como lo manda el kit (`POST /feedback`), más lo que el servidor le añade. */
export interface FakeFeedbackReport {
  id: string; code: string; originApp: string; subject: string; intent: string; message: string;
  node: { id: string; path: string[] } | null; status: string; display: string; supportersCount: number; mine: boolean;
  createdAt: string; blocking: boolean; context: Record<string, unknown> | null; requestId: string;
}

export interface FakeApi {
  url: string;
  cursor(): number;
  rows(table: string): FakeRow[];
  /** Reportes de «Sugerencias y QA» recibidos en `POST /feedback`. */
  feedbackReports(): FakeFeedbackReport[];
  /** Textos recibidos en `POST documents/:id/text`, con `fill` (fase 1: el servidor rellena el borrador). */
  documentTextPosts(): Array<{ fileId: string; items: number; fill: boolean }>;
  /** Lotes de uso recibidos en `POST /usage/batch` (USO.md). */
  usageBatches(): Array<{ deviceId: string; items: Array<Record<string, unknown>> }>;
  /** Simula una edición de otra persona directamente en el servidor (para provocar conflictos). */
  serverUpdate(table: string, id: string, fields: Record<string, unknown>): FakeRow;
  requests: Array<{ method: string; path: string }>;
  /** Archivos subidos (tickets, bytes y verificación). */
  uploads(): FakeUpload[];
  /** La próxima verificación de subida falla con FILE_MISMATCH (escenario O6). */
  failNextVerify(): void;
  /** Destinos conocidos; se puede quitar uno para simular que desapareció (escenario O5). */
  targets: FakeTarget[];
  /** Siembra filas directamente en el servidor (datos sintéticos para medir rendimiento). Avanza el cursor una vez. */
  seed(table: string, rows: Array<Record<string, unknown>>): void;
  /** Extractor simulado para `POST imports/extract`; sin él la ruta responde EXTRACTION_UNAVAILABLE 503. */
  /** Entidad de Central (ronda 37) que sirve `GET entity` y se copia como emisor de las emitidas. */
  setEntity(entity: Record<string, unknown> | null): void;
  /** Lo que devuelve booking.reservation_invoice_source para una reserva (§14.8). */
  setReservationSource(id: string, source: Record<string, unknown> | null): void;
  setExtractor(fn: ((fileIds: string[]) => { document?: unknown; warnings?: string[]; usage?: unknown; fault?: { status: number; code: string; message: string; details?: unknown } }) | null): void;
  close(): Promise<void>;
}

class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) {
    super(message);
  }
}

/** Todas las tablas de Invoices con sus columnas escribibles (las mismas que registra la migración). */
const DEFAULT_TABLES: Record<string, string[]> = Object.fromEntries(Object.values(TABLES).map((t) => [t, [...WRITABLE[t]]]));
let invoiceSeq = 0;

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const users = options.users ?? [{ email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' }];
  const tables = options.tables ?? DEFAULT_TABLES;
  const data = new Map<string, Map<string, FakeRow>>(Object.keys(tables).map((t) => [t, new Map()]));
  const changes: FakeChange[] = [];
  const receipts = new Map<string, { digest: string; result: unknown }>();
  const sessions = new Map<string, { userId: string; email: string; displayName: string; refreshToken: string; role: 'owner' | 'editor' | 'reader' }>();
  const uploads = new Map<string, FakeUpload>();
  const targets: FakeTarget[] = [...(options.targets ?? [])];
  let failVerify = false;
  let entity: Record<string, unknown> | null = null;
  const reservationSources = new Map<string, Record<string, unknown>>();
  // «Sugerencias y QA» y uso de funcionalidades (kit 0.18): en memoria, como en el simulado de Booking.
  const feedbackStore = new Map<string, FakeFeedbackReport>();
  const textPosts: Array<{ fileId: string; items: number; fill: boolean }> = [];
  const feedbackByRequest = new Map<string, string>();
  let feedbackSeq = 0;
  const usageBatches: Array<{ deviceId: string; items: Array<Record<string, unknown>> }> = [];
  // Registro VERI*FACTU del simulado (§14.6): solo lo que la app consulta con invoices.vf_records_of.
  const vfRecords: Array<Record<string, unknown>> = [];
  let vfLastHash: string | null = null;
  const documentTexts = new Map<string, { items: unknown[]; source: string }>();
  let extractor: ((fileIds: string[]) => { document?: unknown; warnings?: string[]; usage?: unknown; fault?: { status: number; code: string; message: string; details?: unknown } }) | null = null;
  const requests: Array<{ method: string; path: string }> = [];
  let cursor = 0;

  const userIds = new Map(users.map((u) => [u.email, randomUUID()]));
  const nowIso = () => new Date().toISOString();

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  async function readJson(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) throw new Fault(400, 'INVALID_JSON', 'Se necesita un objeto JSON.');
    try {
      return JSON.parse(raw);
    } catch {
      throw new Fault(400, 'INVALID_JSON', 'JSON inválido.');
    }
  }

  function issueTokens(email: string) {
    const token = `tok-${randomUUID()}`;
    const refreshToken = `ref-${randomUUID()}`;
    const user = users.find((u) => u.email === email)!;
    sessions.set(token, { userId: userIds.get(email)!, email, displayName: user.displayName ?? email, refreshToken, role: user.role ?? 'owner' });
    return { token, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 };
  }

  function authenticate(req: IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session) throw new Fault(401, 'UNAUTHENTICATED', 'Inicia sesión.');
    return session;
  }

  function bootstrap(session: { userId: string; displayName: string; role: string }) {
    return {
      app: 'invoices',
      cursor,
      serverTime: nowIso(),
      release: 'test',
      membership: { role: session.role, scopes: null, revision: 1 },
      profile: { userId: session.userId, displayName: session.displayName, kind: 'human' },
      tables: Object.entries(tables).map(([table, writableColumns]) => ({ table, writableColumns, readable: true, writable: true })),
    };
  }

  function record(table: string, op: string, row: FakeRow, nextCursor: number, seq: number, requestId: string, actorId: string): FakeChange {
    return { cursor: nextCursor, seq, at: nowIso(), actorId, requestId, table, id: row.id, op, revision: row.revision, after: { ...row } };
  }

  function commit(body: any, actorId: string, role: string = 'owner') {
    if (role === 'reader') throw new Fault(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
    if (typeof body?.requestId !== 'string') throw new Fault(422, 'INVALID_OPERATION', 'requestId inválido.');
    if (!Array.isArray(body.operations)) throw new Fault(422, 'INVALID_OPERATION', 'operations debe ser una lista.');
    const digest = JSON.stringify(body.operations);
    const receipt = receipts.get(`${actorId}:${body.requestId}`);
    if (receipt) {
      if (receipt.digest === digest) return { ...(receipt.result as object), replayed: true };
      throw new Fault(409, 'IDEMPOTENCY_REUSE', 'requestId ya usado con otro contenido.');
    }
    if (body.expectedCursor !== undefined && body.expectedCursor !== null && body.expectedCursor !== cursor) {
      throw new Fault(409, 'CURSOR_CONFLICT', 'El cursor ha avanzado.', { expectedCursor: body.expectedCursor, currentCursor: cursor });
    }
    const nextCursor = cursor + 1;
    const staged = new Map<string, Map<string, FakeRow>>();
    const stagedTable = (t: string) => {
      if (!staged.has(t)) staged.set(t, new Map(Array.from(data.get(t)!.entries()).map(([k, v]) => [k, { ...v }])));
      return staged.get(t)!;
    };
    const results: unknown[] = [];
    const batchChanges: FakeChange[] = [];
    const touchedInvoices = new Set<string>();
    const childTouched = new Set<string>();
    const sensitiveChanged = new Set<string>();
    const validatedNow = new Set<string>();
    const SENSITIVE = ['invoice_date', 'object', 'supplier_id', 'invoice_number', 'source_total', 'expense_category', 'is_investment'];
    (body.operations as FakeOperation[]).forEach((op, index) => {
      if (op.op === 'call') {
        const result = runProcedure(op as FakeOperation & { procedure?: string; args?: Record<string, unknown> }, index, stagedTable, actorId, nextCursor, body.requestId, batchChanges, validatedNow);
        for (const id of validatedNow) touchedInvoices.add(id);
        results.push({ op: 'call', procedure: (op as { procedure?: string }).procedure, result });
        return;
      }
      if (!op.table || !tables[op.table]) throw new Fault(422, 'INVALID_OPERATION', 'Tabla inválida.', { index });
      if (!op.id) throw new Fault(422, 'INVALID_OPERATION', 'El id debe ser un uuid.', { index });
      const store = stagedTable(op.table);
      const allowed = tables[op.table]!;
      const fields = op.fields ?? {};
      for (const key of Object.keys(fields)) if (!allowed.includes(key)) throw new Fault(422, 'INVALID_FIELDS', `Campo no permitido: ${key}`, { index, field: key });
      const now = nowIso();
      let row = store.get(op.id);
      if (op.op === 'insert' || op.op === 'update') checkDomain(op.table, fields, index);
      if (op.op === 'insert') {
        if (row) throw new Fault(422, 'INVALID_OPERATION', 'La fila ya existe.', { index });
        if (op.table === 'invoices.suppliers' && (typeof fields.name !== 'string' || !fields.name.trim())) throw new Fault(422, 'INVALID_FIELDS', 'El nombre del proveedor es obligatorio.', { field: 'name' });
        row = { id: op.id, revision: 1, created_at: now, updated_at: now, updated_by: actorId, deleted_at: null };
        for (const column of allowed) row[column] = fields[column] ?? null;
        applyInsertDefaults(op.table, row, staged);
        store.set(op.id, row);
      } else {
        if (!row) throw new Fault(404, 'NOT_FOUND', 'La fila no existe.', { table: op.table, id: op.id });
        if (op.expectedRevision !== row.revision) {
          throw new Fault(409, 'VERSION_CONFLICT', 'La fila ha cambiado.', { table: op.table, id: op.id, expectedRevision: op.expectedRevision, currentRevision: row.revision, current: { ...row } });
        }
        if (op.op === 'update') Object.assign(row, fields);
        if (op.op === 'delete') row.deleted_at = now;
        if (op.op === 'restore') {
          if (!row.deleted_at) throw new Fault(409, 'ROW_NOT_DELETED', 'La fila no está borrada.');
          row.deleted_at = null;
        }
        row.revision += 1;
        row.updated_at = now;
        row.updated_by = actorId;
      }
      results.push({ op: op.op, table: op.table, id: op.id, revision: row.revision });
      batchChanges.push(record(op.table, op.op, row, nextCursor, batchChanges.length + 1, body.requestId, actorId));
      const invoiceId = op.table === 'invoices.invoices' ? op.id : typeof row.invoice_id === 'string' ? row.invoice_id : null;
      if (invoiceId) touchedInvoices.add(invoiceId);
      // «Mi nombre» (0230): lo pone el servidor y cambiarlo solo no es editar la factura.
      const labelOnly = op.table === 'invoices.invoice_lines' && op.op === 'update' && Object.keys(fields).every((k) => k === 'label');
      if (op.table === 'invoices.invoice_lines' && 'label' in fields) row.label_source = fields.label ? 'manual' : null;
      if (invoiceId && ['invoices.invoice_lines', 'invoices.tax_lines'].includes(op.table) && !labelOnly) childTouched.add(invoiceId);
      if (invoiceId && op.table === 'invoices.invoice_files' && row.kind === 'original') childTouched.add(invoiceId);
      if (op.table === 'invoices.invoices' && op.op === 'update' && Object.keys(fields).some((k) => SENSITIVE.includes(k))) sensitiveChanged.add(op.id);
    });
    // Hook de invariantes simplificado: recalcula totales y estado automático (misma regla que invoices.check_invariants).
    for (const invoiceId of touchedInvoices) {
      const inv = stagedTable('invoices.invoices').get(invoiceId);
      if (!inv || inv.status === 'anulada') continue;
      const lines = Array.from(stagedTable('invoices.invoice_lines').values()).filter((l) => l.invoice_id === invoiceId && !l.deleted_at);
      const taxes = Array.from(stagedTable('invoices.tax_lines').values()).filter((t) => t.invoice_id === invoiceId && !t.deleted_at);
      const r = recalculate(lines as never, taxes as never, null, inv.source_total as number | null);
      const fields: Record<string, unknown> = { calculated_base: r.calculated_base, calculated_vat: r.calculated_vat, calculated_other: r.calculated_other, calculated_withholding: r.calculated_withholding, calculated_total: r.calculated_total, totals_delta: r.totals_delta };
      let status = inv.status as string;
      let reason = inv.review_reason as string | null;
      if (status === 'pendiente_datos' && (lines.length || taxes.length)) { status = 'pendiente_revision'; reason = reason ?? 'DATOS_INTRODUCIDOS'; }
      if (status === 'validada' && !validatedNow.has(invoiceId) && (childTouched.has(invoiceId) || sensitiveChanged.has(invoiceId))) { status = 'pendiente_revision'; reason = 'EDITADA_TRAS_VALIDAR'; }
      if (status === 'pendiente_revision') {
        if (r.within_tolerance === false) { if (!reason || ['IMPORTADA', 'DATOS_INTRODUCIDOS', 'IMPORTES_CORREGIDOS'].includes(reason)) reason = 'REVISAR IMPORTES'; }
        else if (reason === 'REVISAR IMPORTES') reason = 'IMPORTES_CORREGIDOS';
      }
      fields.status = status;
      fields.review_reason = reason;
      const changedKeys = Object.keys(fields).filter((k) => (inv[k] ?? null) !== (fields[k] ?? null));
      if (!changedKeys.length) continue;
      for (const k of changedKeys) inv[k] = fields[k];
      inv.revision += 1;
      inv.updated_at = nowIso();
      batchChanges.push(record('invoices.invoices', 'update', inv, nextCursor, batchChanges.length + 1, body.requestId, actorId));
    }
    for (const [table, store] of staged) data.set(table, store);
    cursor = nextCursor;
    changes.push(...batchChanges);
    const result = { cursor, requestId: body.requestId, results, changes: batchChanges };
    receipts.set(`${actorId}:${body.requestId}`, { digest, result });
    return result;
  }

  /** Lo que hace la Edge en beforeCommit: documentos verificados (fija mime/tamaño/hash) y destinos resueltos (fija etiqueta y revisión). */
  function checkDomain(table: string, fields: Record<string, unknown>, index: number): void {
    if (table === 'invoices.invoice_files' && 'file_id' in fields) {
      const up = typeof fields.file_id === 'string' ? uploads.get(fields.file_id) : undefined;
      if (!up) throw new Fault(422, 'INVALID_FILE', 'El documento no existe o no pertenece a Invoices.', { index, field: 'file_id' });
      if (up.status !== 'verified') throw new Fault(422, 'INVALID_FILE', 'El documento todavía no se ha subido por completo.', { index, field: 'file_id' });
      fields.mime_type = up.mime; fields.size_bytes = up.size; fields.sha256 = up.sha256;
    }
    if (table === 'invoices.allocations' && 'target_app' in fields && fields.target_app !== 'general') {
      if (fields.target_app === 'booking') throw new Fault(422, 'TARGET_APP_NOT_AVAILABLE', 'Ese tipo de destino llegará en la fase 2.', { index });
      const t = targets.find((x) => x.app === fields.target_app && x.kind === fields.target_kind && x.id === fields.target_id);
      if (!t) throw new Fault(422, 'TARGET_NOT_FOUND', 'El destino ya no existe en Tareas.', { index, app: fields.target_app, kind: fields.target_kind, id: fields.target_id });
      fields.target_label = t.path?.length ? `${t.path.join(' › ')} › ${t.label}` : t.label;
      fields.target_revision = t.revision;
    }
  }

  function applyInsertDefaults(table: string, row: FakeRow, staged: Map<string, Map<string, FakeRow>>): void {
    const lookup = (t: string) => staged.get(t) ?? data.get(t)!;
    if (table === 'invoices.suppliers') {
      row.slug = (row.slug as string | null) || slugify(String(row.name ?? '')) || 'proveedor';
      row.aliases = row.aliases ?? [];
      row.default_is_investment = row.default_is_investment ?? false;
    }
    if (table === 'invoices.invoices') {
      const date = String(row.invoice_date ?? new Date().toISOString());
      row.code = `FVR_${date.slice(0, 4)}_${String(++invoiceSeq).padStart(3, '0')}`;
      row.currency = row.currency ?? 'EUR';
      row.status = row.status ?? 'pendiente_datos';
      row.deductibility = row.deductibility ?? 'pendiente_revision';
      row.payment_status = row.payment_status ?? 'pendiente';
      row.source = row.source ?? 'manual';
      row.is_investment = row.is_investment ?? false;
      for (const k of ['calculated_base', 'calculated_vat', 'calculated_other', 'calculated_withholding', 'calculated_total']) row[k] = row[k] ?? 0;
      const y = Number(date.slice(0, 4));
      const q = Math.ceil(Number(date.slice(5, 7)) / 3);
      row.fiscal_year = y;
      row.fiscal_quarter = q;
      row.fiscal_period = `${y}T${q}`;
    }
    if (table === 'invoices.invoice_lines') row.discount_amount = row.discount_amount ?? 0;
    // Emitidas (API.md §13): lo que en SQL ponen los valores por defecto y las columnas generadas.
    if (table === 'invoices.issued_invoices') {
      if (entity) { row.issuer_tax_id = entity.tax_id; row.issuer_name = entity.legal_name; row.issuer = { ...entity }; }
      const s = String(row.series_code ?? '').trim(); const n = String(row.number ?? '').trim();
      // Series de emisión (§14): nace como borrador sin número, como hace el disparador en SQL.
      const series = [...lookup('invoices.issued_series').values()].find((x) => !x.deleted_at && String(x.code).toUpperCase() === s.toUpperCase());
      if (series?.mode === 'emision') {
        if (row.status !== 'borrador' || row.number) throw new Fault(422, 'ISSUE_REQUIRES_PROCEDURE', 'En una serie de emisión la factura nace como borrador sin número.');
        row.origin = 'app';
      }
      row.full_number = row.status === 'borrador' ? null : n.toUpperCase().startsWith(s.toUpperCase()) ? n : `${s}-${n}`;
      row.invoice_type = row.invoice_type ?? 'F1';
      row.status = row.status ?? 'registrada';
      row.origin = row.origin ?? 'manual';
      row.payment_status = row.payment_status ?? 'pendiente';
      row.currency = row.currency ?? 'EUR';
      row.rectified = row.rectified ?? [];
      row.extra_recipients = row.extra_recipients ?? [];
      for (const k of ['base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total']) row[k] = row[k] ?? 0;
      const date = String(row.issue_date ?? '2026-01-01');
      row.fiscal_year = Number(date.slice(0, 4));
      row.fiscal_quarter = Math.ceil(Number(date.slice(5, 7)) / 3);
      row.vf_status = null;
      row.prices_include_vat = row.prices_include_vat ?? false;
      row.rectified_by = [];
      const clash = !!n && [...lookup('invoices.issued_invoices').values()].some((o) => o.id !== row.id && String(o.series_code).toUpperCase() === s.toUpperCase() && String(o.number ?? '').trim().toUpperCase() === n.toUpperCase());
      if (clash) throw new Fault(422, 'CONSTRAINT_VIOLATION', 'Ese número ya está registrado en la serie.');
    }
    if (table === 'invoices.issued_series') {
      row.kind = row.kind ?? 'ordinaria'; row.yearly = row.yearly ?? true; row.active = row.active ?? true; row.format = row.format ?? '{serie}-{año}-{n:4}';
      row.mode = row.mode ?? 'registro'; row.valid_year = row.valid_year ?? null; row.counter_year = null; row.counter_last = 0; row.counter_last_date = null; row.closed_at = null; row.closed_last_number = null;
    }
    if (table === 'invoices.issued_invoice_lines') { row.discount_amount = row.discount_amount ?? 0; row.tax = row.tax ?? 'iva'; row.position = row.position ?? 0; }
    if (table === 'invoices.issued_tax_lines') { row.regime_key = row.regime_key ?? '01'; row.position = row.position ?? 0; }
    if (table === 'invoices.issued_invoice_files') {
      const inv = lookup('invoices.issued_invoices').get(String(row.issued_invoice_id));
      row.page_order = row.page_order ?? 1;
      const slug = slugify(String(inv?.recipient_name ?? '')) || 'sin_destinatario';
      const ext = row.mime_type === 'application/pdf' ? 'pdf' : row.mime_type === 'image/webp' ? 'webp' : row.mime_type === 'image/jpeg' ? 'jpg' : 'png';
      row.normalized_filename = inv ? `${String(inv.issue_date).replace(/-/g, '_')}_(${slug})_${String(inv.full_number).replace(/[^A-Za-z0-9-]+/g, '_')}.${ext}` : null;
    }
    if (table === 'invoices.invoice_files') {
      const inv = lookup('invoices.invoices').get(String(row.invoice_id));
      const supplier = inv ? lookup('invoices.suppliers').get(String(inv.supplier_id)) : null;
      row.kind = row.kind ?? 'original';
      row.page_order = row.page_order ?? 1;
      row.normalized_filename = normalizedFilename({ invoiceDate: (inv?.invoice_date as string | null | undefined) ?? null, supplierSlug: String(supplier?.slug ?? 'proveedor'), object: String(inv?.object ?? ''), mime: String(row.mime_type ?? 'application/pdf') });
    }
    if (table === 'invoices.allocations') {
      const line = lookup('invoices.invoice_lines').get(String(row.invoice_line_id));
      row.invoice_id = line?.invoice_id ?? null;
    }
  }

  /** Procedimientos mínimos (validate, annul): la lógica real vive en SQL; aquí basta para el humo del frontend. */
  function runProcedure(op: FakeOperation & { procedure?: string; args?: Record<string, unknown> }, index: number, stagedTable: (t: string) => Map<string, FakeRow>, actorId: string, nextCursor: number, requestId: string, batchChanges: FakeChange[], touched: Set<string>): unknown {
    const args = op.args ?? {};
    const insertRow = (table: string, id: string, fields: Record<string, unknown>): FakeRow => {
      const now = nowIso();
      const allowed = tables[table]!;
      checkDomain(table, fields, index);
      const row: FakeRow = { id, revision: 1, created_at: now, updated_at: now, updated_by: actorId, deleted_at: null };
      for (const column of allowed) row[column] = fields[column] ?? null;
      applyInsertDefaults(table, row, new Map(Object.keys(tables).map((t) => [t, stagedTable(t)])));
      stagedTable(table).set(id, row);
      batchChanges.push(record(table, 'insert', row, nextCursor, batchChanges.length + 1, requestId, actorId));
      return row;
    };
    if (op.procedure === 'invoices.import_v1') {
      const validation = validateImportDocument(args.document);
      if (!validation.ok) throw new Fault(422, 'IMPORT_INVALID', 'El JSON no cumple el formato ikisai.invoice.v1.', { index, errors: validation.errors });
      const doc: ImportDocument = validation.document;
      const supplierArg = (args.supplier ?? {}) as { mode?: string; id?: string; slug?: string | null };
      const suppliers = stagedTable('invoices.suppliers');
      let supplier: FakeRow | undefined;
      if (supplierArg.mode === 'create') {
        const tax = doc.invoice.supplier_tax_id ? doc.invoice.supplier_tax_id.toUpperCase().replace(/[\s.-]/g, '') : null;
        const clash = tax ? Array.from(suppliers.values()).find((s) => !s.deleted_at && String(s.tax_id ?? '').toUpperCase().replace(/[\s.-]/g, '') === tax) : undefined;
        if (clash) throw new Fault(409, 'SUPPLIER_TAX_ID_EXISTS', 'Ya existe un proveedor con ese NIF.', { supplier_id: clash.id });
        supplier = insertRow('invoices.suppliers', String((args.ids as { supplier?: string })?.supplier ?? randomUUID()), { name: doc.invoice.supplier_name, tax_id: doc.invoice.supplier_tax_id ?? null, slug: supplierArg.slug ?? slugify(doc.invoice.supplier_name), aliases: [] });
      } else {
        supplier = suppliers.get(String(supplierArg.id));
        if (!supplier || supplier.deleted_at) throw new Fault(404, 'NOT_FOUND', 'El proveedor no existe.', { index });
      }
      const invoices = stagedTable('invoices.invoices');
      const invoiceId = String(args.invoice_id);
      const existing = invoices.get(invoiceId);
      if (existing && existing.status !== 'pendiente_datos') throw new Fault(409, 'INVOICE_NOT_IMPORTABLE', 'Esta factura ya tiene datos; importa sobre una factura vacía.', { invoice_id: invoiceId });
      const number = doc.invoice.invoice_number?.trim() || null;
      if (number) {
        const dup = Array.from(invoices.values()).find((i) => !i.deleted_at && i.status !== 'anulada' && i.supplier_id === supplier!.id && i.id !== invoiceId && String(i.invoice_number ?? '').toLowerCase() === number.toLowerCase());
        if (dup) throw new Fault(409, 'DUPLICATE_INVOICE', 'Ya existe una factura de este proveedor con ese número.', { invoice_id: dup.id, code: dup.code });
      }
      const sha = String(args.document_sha256 ?? '');
      const dupImport = Array.from(invoices.values()).find((i) => !i.deleted_at && i.status !== 'anulada' && i.id !== invoiceId && i.import_sha256 === sha);
      if (dupImport) throw new Fault(409, 'DUPLICATE_IMPORT', 'Este JSON ya se importó.', { invoice_id: dupImport.id, code: dupImport.code });
      const overrides = (args.invoice ?? {}) as Record<string, unknown>;
      const proposal = proposeImport(doc, supplier as never, overrides as never);
      const invoiceFields: Record<string, unknown> = {
        supplier_id: supplier.id, invoice_date: proposal.invoice_date, object: proposal.object, invoice_number: number, currency: 'EUR',
        expense_category: proposal.expense_category, is_investment: proposal.is_investment, deductibility: proposal.deductibility, status: 'pendiente_revision', review_reason: proposal.review_reason,
        source_total: doc.document_totals.total, source: 'import_v1', import_sha256: sha, notes: proposal.notes,
        import_meta: { overall_confidence: doc.overall_confidence ?? null, extraction_notes: doc.extraction_notes ?? null, document_totals: doc.document_totals, warnings: proposal.recalculation.warnings.map((w) => w.code) },
      };
      let inv: FakeRow;
      if (existing) {
        Object.assign(existing, invoiceFields); existing.revision += 1; existing.updated_at = nowIso();
        batchChanges.push(record('invoices.invoices', 'update', existing, nextCursor, batchChanges.length + 1, requestId, actorId));
        inv = existing;
      } else {
        inv = insertRow('invoices.invoices', invoiceId, invoiceFields);
      }
      const ids = (args.ids ?? {}) as { lines?: string[]; tax_lines?: string[]; files?: string[] };
      doc.lines.forEach((l, i) => insertRow('invoices.invoice_lines', ids.lines?.[i] ?? randomUUID(), {
        invoice_id: inv.id, position: i, description: l.description, quantity: l.quantity ?? null, unit: l.unit ?? null, unit_price: l.unit_price ?? null, discount_amount: l.discount_amount ?? 0,
        net_amount: l.net_amount, vat_rate: l.vat_rate ?? null, vat_amount: l.vat_amount ?? null, gross_amount: l.gross_amount ?? null, item_type: l.suggested_item_type ?? null, match_name: l.suggested_match_name ?? null, confidence: l.confidence ?? null, notes: l.notes ?? null,
      }));
      proposal.recalculation.taxes.forEach((t, i) => insertRow('invoices.tax_lines', ids.tax_lines?.[i] ?? randomUUID(), { invoice_id: inv.id, position: i, tax_type: t.tax_type, rate: t.rate ?? null, taxable_base: t.taxable_base ?? null, amount: t.amount }));
      ((args.files ?? []) as Array<{ file_id: string; original_filename: string; page_order: number }>).forEach((f, i) => insertRow('invoices.invoice_files', ids.files?.[i] ?? randomUUID(), { invoice_id: inv.id, file_id: f.file_id, original_filename: f.original_filename, page_order: f.page_order ?? i + 1, kind: 'original' }));
      touched.add(inv.id);
      return { invoice_id: inv.id, code: inv.code, status: inv.status, review_reason: inv.review_reason, supplier_id: supplier.id, warnings: proposal.recalculation.warnings.map((w) => w.code), recalculation: proposal.recalculation };
    }
    const inv = stagedTable('invoices.invoices').get(String(args.invoice_id));
    if (op.procedure === 'invoices.validate') {
      if (!inv) throw new Fault(404, 'NOT_FOUND', 'La factura no existe.', { index });
      // Como el SQL (0227): con `expectedRevision`, la revisión tiene que coincidir.
      const expected = (op.args as { expectedRevision?: unknown } | undefined)?.expectedRevision;
      if (expected !== undefined && expected !== null && Number(expected) !== Number(inv.revision)) {
        throw new Fault(409, 'VERSION_CONFLICT', 'La fila cambió en el servidor.', { table: 'invoices.invoices', id: inv.id, expectedRevision: Number(expected), currentRevision: inv.revision, current: { ...inv } });
      }
      if (inv.totals_delta !== null && Math.abs(Number(inv.totals_delta)) > 0.02) throw new Fault(422, 'INVOICE_TOTALS_MISMATCH', 'Los importes no cuadran con el total del documento.', { delta: inv.totals_delta });
      const missing: string[] = [];
      if (!inv.invoice_date) missing.push('invoice_date');
      if (!inv.expense_category) missing.push('expense_category');
      if (!Array.from(stagedTable('invoices.invoice_files').values()).some((f) => f.invoice_id === inv.id && !f.deleted_at && f.kind === 'original')) missing.push('original_file');
      if (missing.length) throw new Fault(422, 'INVOICE_INCOMPLETE', 'Faltan datos para validar la factura.', { missing });
      inv.status = 'validada';
      inv.review_reason = null;
      inv.revision += 1;
      inv.updated_at = nowIso();
      batchChanges.push(record('invoices.invoices', 'update', inv, nextCursor, batchChanges.length + 1, requestId, actorId));
      touched.add(inv.id);
      return { ...inv };
    }
    if (op.procedure === 'invoices.annul') {
      if (!inv) throw new Fault(404, 'NOT_FOUND', 'La factura no existe.', { index });
      if (!String(args.reason ?? '').trim()) throw new Fault(422, 'ANNUL_REASON_REQUIRED', 'Indica el motivo de la anulación.');
      inv.status = 'anulada';
      inv.annulled_reason = String(args.reason).trim();
      inv.revision += 1;
      inv.updated_at = nowIso();
      batchChanges.push(record('invoices.invoices', 'update', inv, nextCursor, batchChanges.length + 1, requestId, actorId));
      for (const a of stagedTable('invoices.allocations').values()) {
        if (a.invoice_id !== inv.id || a.deleted_at) continue;
        a.deleted_at = nowIso();
        a.revision += 1;
        batchChanges.push(record('invoices.allocations', 'delete', a, nextCursor, batchChanges.length + 1, requestId, actorId));
      }
      return { invoice: { ...inv }, exports: [] };
    }
    if (op.procedure === 'invoices.take_issuer') {
      if (!entity) throw new Fault(422, 'ENTITY_MISSING', 'Faltan los datos de la entidad en Central: complétalos allí y vuelve a intentarlo.', { index });
      const filled: string[] = [];
      for (const id of (args.ids as string[] | undefined) ?? []) {
        const issued = stagedTable('invoices.issued_invoices').get(String(id));
        if (!issued || issued.deleted_at || issued.issuer || issued.issuer_tax_id || issued.status === 'anulada') continue;
        issued.issuer_tax_id = entity.tax_id; issued.issuer_name = entity.legal_name; issued.issuer = { ...entity };
        issued.revision += 1; issued.updated_at = nowIso();
        batchChanges.push(record('invoices.issued_invoices', 'update', issued, nextCursor, batchChanges.length + 1, requestId, actorId));
        filled.push(issued.id as string);
      }
      return { filled, skipped: [] };
    }
    // Emitir (§14.3): número de la serie, congelado, emisor de Central y registro de alta encadenado (huella real).
    if (op.procedure === 'invoices.issue') {
      if (!entity) throw new Fault(422, 'ENTITY_MISSING', 'Faltan los datos de la entidad en Central.', { index });
      const inv = stagedTable('invoices.issued_invoices').get(String(args.id));
      if (!inv || inv.deleted_at) throw new Fault(404, 'NOT_FOUND', 'La factura no existe.', { index });
      if (inv.status !== 'borrador') throw new Fault(409, 'ISSUED_NOT_DRAFT', 'Esta factura ya está emitida.', { index });
      const series = [...stagedTable('invoices.issued_series').values()].find((x) => !x.deleted_at && String(x.code).toUpperCase() === String(inv.series_code).toUpperCase());
      if (!series || series.mode !== 'emision') throw new Fault(422, 'SERIES_NOT_ISSUING', 'Esa serie es de registro de otra herramienta.', { index });
      if (series.valid_year && Number(series.valid_year) !== Number(new Date().toLocaleDateString('sv-SE').slice(0, 4))) throw new Fault(422, 'SERIES_YEAR_MISMATCH', 'Esa serie es de otro año.', { index });
      const lines = [...stagedTable('invoices.issued_invoice_lines').values()].filter((l) => l.issued_invoice_id === inv.id && !l.deleted_at)
        .sort((a, b) => Number(a.position) - Number(b.position));
      const missing = issueMissing(inv as never, lines.length);
      if (missing.length) throw new Fault(422, 'ISSUE_MISSING_DATA', 'Faltan datos obligatorios para emitir la factura.', { index, id: inv.id, missing });
      const today = new Date().toLocaleDateString('sv-SE'); const year = Number(today.slice(0, 4));
      const n = series.yearly && series.counter_year !== year ? 1 : Number(series.counter_last ?? 0) + 1;
      const number = formatIssuedNumber(String(series.format), String(series.code), year, n);
      Object.assign(series, { counter_year: series.yearly ? year : null, counter_last: n, counter_last_date: today, revision: series.revision + 1, updated_at: nowIso() });
      batchChanges.push(record('invoices.issued_series', 'update', series, nextCursor, batchChanges.length + 1, requestId, actorId));
      const byRate = new Map<number | null, number>();
      for (const l of lines) { const r = l.vat_rate === null ? null : Number(l.vat_rate); byRate.set(r, Math.round(((byRate.get(r) ?? 0) + Number(l.net_amount)) * 100) / 100); }
      const breakdown = [...byRate.entries()].map(([rate, base]) => ({ tax: 'iva', regime_key: '01', qualification: 'S1', exemption: null, rate, base, quota: Math.round(base * (rate ?? 0)) / 100, surcharge_rate: null, surcharge_quota: 0 }));
      const base = Math.round(breakdown.reduce((a, b) => a + b.base, 0) * 100) / 100;
      const quota = Math.round(breakdown.reduce((a, b) => a + b.quota, 0) * 100) / 100;
      const fullNumber = number.toUpperCase().startsWith(String(inv.series_code).toUpperCase()) ? number : `${inv.series_code}-${number}`;
      const dateText = today.split('-').reverse().join('-');
      const genAt = new Date().toISOString().slice(0, 19) + '+00:00';
      const hash = createHash('sha256').update(vfAltaString({ issuerTaxId: String(entity.tax_id), numSerie: fullNumber, issueDate: dateText, invoiceType: String(inv.invoice_type),
        quotaTotal: quota, amountTotal: base + quota, previousHash: vfLastHash, generatedAt: genAt })).digest('hex').toUpperCase();
      const document = {
        full_number: fullNumber, series: inv.series_code, number, issue_date: today, operation_date: inv.operation_date ?? null, invoice_type: inv.invoice_type, issuer: { ...entity },
        recipient: { name: inv.recipient_name, tax_id: inv.recipient_tax_id, id_type: inv.recipient_id_type, country: inv.recipient_country, address: inv.recipient_address, kind: inv.recipient_kind },
        description: inv.description,
        lines: lines.map((l) => ({ position: l.position, description: l.description, quantity: l.quantity ?? null, unit: l.unit ?? null, unit_price: l.unit_price ?? null,
          discount_amount: l.discount_amount ?? 0, net_amount: Number(l.net_amount), tax: l.tax ?? 'iva', vat_rate: l.vat_rate, vat_amount: l.vat_amount ?? null })),
        breakdown, withholdings: [], prices_include_vat: !!inv.prices_include_vat,
        totals: { base, quota, surcharge: 0, withholding: 0, total: Math.round((base + quota) * 100) / 100, vf_amount: Math.round((base + quota) * 100) / 100 },
        rectification: /^R[1-5]$/.test(String(inv.invoice_type)) ? { kind: inv.rectification_kind, rectified: inv.rectified, reason: inv.rectification_reason, base: inv.rectified_base, quota: inv.rectified_quota } : null,
        currency: inv.currency ?? 'EUR', issued_at: nowIso(),
      };
      vfRecords.push({ issued_invoice_id: inv.id, record_kind: 'alta', hash, previous_hash: vfLastHash, generated_at_text: genAt, send_status: 'no_enviar', seq: vfRecords.length + 1 });
      Object.assign(inv, {
        status: 'emitida', number, full_number: fullNumber, issue_date: today, origin: 'app', issued_at: nowIso(), issued_by: actorId,
        issuer_tax_id: entity.tax_id, issuer_name: entity.legal_name, issuer: { ...entity },
        base_total: base, quota_total: quota, surcharge_total: 0, withholding_total: 0, total: document.totals.total, document,
        vf_record_kind: 'alta', vf_hash: hash, vf_previous_hash: vfLastHash, vf_first_record: vfLastHash === null, vf_generated_at: nowIso(), vf_status: 'no_enviar',
        vf_qr_url: vfQrUrl('produccion', String(entity.tax_id), fullNumber, dateText, base + quota),
        revision: inv.revision + 1, updated_at: nowIso(),
      });
      vfLastHash = hash;
      batchChanges.push(record('invoices.issued_invoices', 'update', inv, nextCursor, batchChanges.length + 1, requestId, actorId));
      // Rectificativa emitida: la original pasa a «rectificada»
      if (/^R[1-5]$/.test(String(inv.invoice_type))) {
        for (const r of (inv.rectified as Array<{ issued_invoice_id?: string }>) ?? []) {
          const o = r.issued_invoice_id ? stagedTable('invoices.issued_invoices').get(r.issued_invoice_id) : undefined;
          if (!o || !['emitida', 'rectificada'].includes(String(o.status))) continue;
          Object.assign(o, { status: 'rectificada', rectified_by: [...((o.rectified_by as unknown[]) ?? []), { issued_invoice_id: inv.id, full_number: fullNumber, issue_date: today }],
            revision: o.revision + 1, updated_at: nowIso() });
          batchChanges.push(record('invoices.issued_invoices', 'update', o, nextCursor, batchChanges.length + 1, requestId, actorId));
        }
      }
      return { id: inv.id, full_number: fullNumber, issue_date: today, vf_hash: hash, vf_status: 'no_enviar' };
    }
    if (op.procedure === 'invoices.series_start') {
      const series = [...stagedTable('invoices.issued_series').values()].find((x) => !x.deleted_at && String(x.code).toUpperCase() === String(args.code ?? '').toUpperCase());
      if (!series || series.mode !== 'emision') throw new Fault(422, 'SERIES_NOT_ISSUING', 'Esa serie no es de emisión.', { index });
      const used = [...stagedTable('invoices.issued_invoices').values()].some((i) => !i.deleted_at && i.status !== 'borrador' && String(i.series_code).toUpperCase() === String(series.code).toUpperCase());
      if (used) throw new Fault(409, 'SERIES_IN_USE', 'La serie ya tiene facturas emitidas.', { index });
      const year = Number(args.year ?? series.valid_year ?? new Date().getFullYear());
      Object.assign(series, { counter_year: series.yearly ? year : null, counter_last: Number(args.last_number), counter_last_date: null, revision: series.revision + 1, updated_at: nowIso() });
      batchChanges.push(record('invoices.issued_series', 'update', series, nextCursor, batchChanges.length + 1, requestId, actorId));
      return { code: series.code, last_number: series.counter_last };
    }
    if (op.procedure === 'invoices.rectify') {
      const o = stagedTable('invoices.issued_invoices').get(String(args.id));
      if (!o || o.deleted_at) throw new Fault(404, 'NOT_FOUND', 'La factura no existe.', { index });
      if (!['emitida', 'rectificada'].includes(String(o.status)) || o.origin !== 'app') throw new Fault(422, 'RECTIFY_NOT_ISSUED', 'Solo se rectifica una factura emitida desde Finance.', { index });
      const series = [...stagedTable('invoices.issued_series').values()].find((x) => !x.deleted_at && x.mode === 'emision' && x.kind === 'rectificativa' && x.active && !x.closed_at);
      if (!series) throw new Fault(422, 'SERIES_MISSING', 'Falta una serie de rectificativas.', { index });
      const kind = String(args.kind ?? 'I'); const sign = kind === 'I' ? -1 : 1;
      const id = randomUUID();
      const draft = insertRow('invoices.issued_invoices', id, {
        series_code: series.code, status: 'borrador', issue_date: new Date().toLocaleDateString('sv-SE'), operation_date: o.operation_date ?? null,
        invoice_type: o.invoice_type === 'F2' ? 'R5' : String(args.reason_code ?? 'R4'), rectification_kind: kind, rectification_reason: String(args.reason ?? ''),
        rectified: [{ issued_invoice_id: o.id, series: o.series_code, number: o.number, full_number: o.full_number, issue_date: o.issue_date }],
        rectified_base: kind === 'S' ? o.base_total : null, rectified_quota: kind === 'S' ? Number(o.quota_total) + Number(o.surcharge_total ?? 0) : null,
        recipient_name: o.recipient_name, recipient_tax_id: o.recipient_tax_id, recipient_id_type: o.recipient_id_type, recipient_country: o.recipient_country,
        recipient_address: o.recipient_address, recipient_kind: o.recipient_kind, description: `Rectificación de ${o.full_number}: ${args.reason ?? ''}`, income_category: o.income_category,
      });
      for (const l of [...stagedTable('invoices.issued_invoice_lines').values()].filter((x) => x.issued_invoice_id === o.id && !x.deleted_at)) {
        insertRow('invoices.issued_invoice_lines', randomUUID(), { issued_invoice_id: id, position: l.position, description: l.description, quantity: l.quantity,
          unit_price: l.unit_price === null ? null : sign * Number(l.unit_price), net_amount: sign * Number(l.net_amount), vat_rate: l.vat_rate });
      }
      return { id: draft.id, series_code: series.code };
    }
    if (op.procedure === 'invoices.annul_issued') {
      const issued = stagedTable('invoices.issued_invoices').get(String(args.issued_invoice_id));
      if (!issued) throw new Fault(404, 'NOT_FOUND', 'La factura emitida no existe.', { index });
      if (issued.status === 'anulada') throw new Fault(409, 'ISSUED_ANNULLED', 'Esta factura emitida está anulada.');
      if (!String(args.reason ?? '').trim()) throw new Fault(422, 'ANNUL_REASON_REQUIRED', 'Indica el motivo de la anulación.');
      issued.status = 'anulada';
      issued.annulled_reason = String(args.reason).trim();
      issued.revision += 1;
      issued.updated_at = nowIso();
      batchChanges.push(record('invoices.issued_invoices', 'update', issued, nextCursor, batchChanges.length + 1, requestId, actorId));
      for (const a of stagedTable('invoices.issued_allocations').values()) {
        if (a.issued_invoice_id !== issued.id || a.deleted_at) continue;
        a.deleted_at = nowIso(); a.revision += 1;
        batchChanges.push(record('invoices.issued_allocations', 'delete', a, nextCursor, batchChanges.length + 1, requestId, actorId));
      }
      return { ...issued };
    }
    throw new Fault(422, 'INVALID_OPERATION', 'Procedimiento no permitido.', { index, procedure: op.procedure });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname + url.search });
    try {
      if (!url.pathname.startsWith('/api/v1/')) throw new Fault(404, 'NOT_FOUND', 'Ruta desconocida.');
      const path = url.pathname.slice('/api/v1/'.length);
      if (path === 'health') return json(res, 200, { status: 'ok', app: 'invoices', stage: 'test', release: 'test' });
      if (path === 'auth/login' && method === 'POST') {
        const body = await readJson(req);
        const email = String(body.username ?? body.email ?? '').trim().toLowerCase();
        const user = users.find((u) => u.email === email && u.password === body.password);
        if (!user) throw new Fault(401, 'LOGIN_FAILED', 'Correo o contraseña incorrectos.');
        return json(res, 200, issueTokens(user.email));
      }
      const putUpload = path.match(/^_upload\/([^/]+)$/);
      if (path === 'apps' && method === 'GET') {
        // Catálogo del lanzador (contrato §3.3), como lo devuelve el núcleo.
        return json(res, 200, { current: 'invoices', items: [
          { id: 'tasks', name: 'Tasks', domain: 'tasks.ikisai.com', aliasDomain: 'cuida.ikisai.com', kind: 'internal', description: 'Tareas', role: 'owner' },
          { id: 'invoices', name: 'Finance', domain: 'finance.ikisai.com', aliasDomain: 'tramita.ikisai.com', kind: 'internal', description: 'Facturas y gestoría', role: 'owner' },
          { id: 'guests', name: 'Guests', domain: 'guests.ikisai.com', aliasDomain: 'ven.ikisai.com', kind: 'portal', description: 'Portal de huéspedes', role: null },
        ] });
      }
      const signed = path.match(/^_file\/([^/]+)$/);
      if (signed && method === 'GET') {
        const up = uploads.get(signed[1]!);
        if (!up || !up.bytes) throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        res.writeHead(200, { 'Content-Type': up.mime, 'Content-Length': String(up.bytes.length) });
        res.end(up.bytes);
        return;
      }
      if (putUpload && method === 'PUT') {
        const up = uploads.get(putUpload[1]!);
        if (!up) throw new Fault(404, 'FILE_NOT_FOUND', 'Ticket desconocido.');
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        up.bytes = Buffer.concat(chunks);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const getFile = path.match(/^_file\/([^/]+)$/);
      if (getFile && method === 'GET') {
        const up = uploads.get(getFile[1]!);
        if (!up?.bytes) throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        res.writeHead(200, { 'Content-Type': up.mime, 'Content-Length': String(up.bytes.length) });
        res.end(up.bytes);
        return;
      }
      if (path === 'auth/refresh' && method === 'POST') {
        const body = await readJson(req);
        const entry = Array.from(sessions.entries()).find(([, s]) => s.refreshToken === body.refreshToken);
        if (!entry) throw new Fault(401, 'UNAUTHORIZED', 'Sesión caducada.');
        sessions.delete(entry[0]);
        return json(res, 200, issueTokens(entry[1].email));
      }
      const session = authenticate(req);
      if (path === 'auth/logout' && method === 'POST') {
        sessions.delete(req.headers.authorization!.slice('Bearer '.length));
        return json(res, 200, { loggedOut: true });
      }
      if (path === 'bootstrap') return json(res, 200, bootstrap(session));
      if (path === 'me') return json(res, 200, { userId: session.userId, email: session.email, role: 'owner', scopes: null });
      if (path === 'dashboard') return json(res, 200, { app: 'invoices', cursor, pending: [], message: 'Panel pendiente de la fase 1.' });
      if (path === 'snapshot') {
        const requested = (url.searchParams.get('tables') ?? '').split(',').filter(Boolean);
        const list = requested.length ? requested : Object.keys(tables);
        const includeDeleted = ['1', 'true'].includes(url.searchParams.get('includeDeleted') ?? '');
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const out = list.map((table) => {
          if (!tables[table]) throw new Fault(403, 'FORBIDDEN', 'Tabla no registrada.', { table });
          const all = Array.from(data.get(table)!.values()).filter((r) => includeDeleted || !r.deleted_at);
          return { table, rows: all.slice(offset, offset + limit), total: all.length };
        });
        return json(res, 200, { cursor, tables: out });
      }
      if (path === 'changes') {
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const items = changes.filter((c) => c.cursor > after).slice(0, limit);
        const last = items.length ? items[items.length - 1]!.cursor : after;
        return json(res, 200, { items, cursor: last, latest: cursor, hasMore: items.length > 0 && last < cursor });
      }
      if (path === 'commands' && method === 'POST') return json(res, 200, commit(await readJson(req), session.userId, session.role));
      if (path === 'uploads' && method === 'POST') {
        const body = await readJson(req);
        const id = randomUUID();
        uploads.set(id, { id, filename: String(body.filename), mime: String(body.mime), size: Number(body.size), sha256: String(body.sha256), bytes: null, status: 'pending' });
        return json(res, 200, { id, path: `invoices/2026/${id}/${body.filename}`, uploadUrl: `/api/v1/_upload/${id}`, method: 'PUT', headers: { 'Content-Type': String(body.mime) }, expiresAt: new Date(Date.now() + 3600_000).toISOString(), duplicateOf: null });
      }
      const verify = path.match(/^uploads\/([^/]+)\/verify$/);
      if (verify && method === 'POST') {
        const up = uploads.get(verify[1]!);
        if (!up) throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        if (!up.bytes) throw new Fault(404, 'FILE_NOT_FOUND', 'El archivo no se ha subido todavía.');
        const digest = createHash('sha256').update(up.bytes).digest('hex');
        if (failVerify || digest !== up.sha256) {
          failVerify = false;
          up.status = 'missing';
          throw new Fault(422, 'FILE_MISMATCH', 'El archivo subido no coincide con lo declarado.', { expected: up.sha256, actual: digest });
        }
        up.status = 'verified';
        return json(res, 200, { id: up.id, sha256: up.sha256, size: up.size, verified: true, hashVerified: true });
      }
      const file = path.match(/^files\/([^/]+)$/);
      if (file && method === 'GET') {
        const up = uploads.get(file[1]!);
        if (!up || up.status !== 'verified') throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        return json(res, 200, { id: up.id, url: `/api/v1/_file/${up.id}`, expiresAt: new Date(Date.now() + 600_000).toISOString(), filename: up.filename, mime: up.mime, size: up.size });
      }
      if (path === 'entity' && method === 'GET') return json(res, 200, { entity, logo_url: null, logo_mime: null });
      // Uso: el aviso al equipo ya está aceptado en el simulado (no tapa las demás pruebas); los lotes se guardan.
      if (path === 'usage/consent') return json(res, 200, { consentedAt: '2026-10-01T09:00:00.000Z' });
      if (path === 'usage/batch' && method === 'POST') {
        const body = await readJson(req);
        usageBatches.push({ deviceId: String(body.deviceId ?? ''), items: Array.isArray(body.items) ? body.items : [] });
        return json(res, 200, { accepted: Array.isArray(body.items) ? body.items.length : 0 });
      }
      if (path === 'usage/review' || path.startsWith('usage/features')) throw new Fault(403, 'FORBIDDEN', 'Sin acceso al revisor.');
      if (path === 'feedback' || path.startsWith('feedback/')) {
        const reports = Array.from(feedbackStore.values());
        if (path === 'feedback' && method === 'POST') {
          const body = await readJson(req);
          const known = feedbackByRequest.get(String(body.requestId));
          if (known) return json(res, 200, { report: feedbackStore.get(known) });
          feedbackSeq += 1;
          const report: FakeFeedbackReport = {
            id: String(body.id), code: `FB-${String(feedbackSeq).padStart(4, '0')}`, originApp: 'invoices', subject: String(body.subject ?? 'application'), intent: String(body.intent ?? 'bug'),
            message: String(body.message ?? ''), node: body.node ?? null, status: 'open', display: 'open', supportersCount: 1, mine: true, createdAt: nowIso(),
            blocking: !!body.blocking, context: body.context ?? null, requestId: String(body.requestId),
          };
          // Como el servidor real: solo deduplica por `requestId`. Un segundo envío con el mismo `id` y otra petición crea
          // otro reporte (FB_2026_016 y 017 en producción), así que no se pisa el anterior.
          const key = feedbackStore.has(report.id) ? `${report.id}#${feedbackSeq}` : report.id;
          feedbackStore.set(key, report);
          feedbackByRequest.set(report.requestId, key);
          return json(res, 200, { report });
        }
        if (path === 'feedback' && method === 'GET') {
          const q = url.searchParams;
          if (q.get('review') === 'true') throw new Fault(403, 'FORBIDDEN', 'Sin acceso al revisor.');
          let items = reports;
          if (q.get('node')) items = items.filter((r) => r.node?.id === q.get('node'));
          const status = q.get('status');
          if (status === 'open') items = items.filter((r) => r.status === 'open');
          else if (status === 'pending_verify') items = items.filter((r) => r.status === 'pending_verify');
          return json(res, 200, { items });
        }
        if (path === 'feedback/tree' && method === 'GET') {
          const byNode = new Map<string, { id: string; path: string[]; open: number; pendingVerify: number; verified: number; total: number }>();
          for (const r of reports) {
            if (!r.node) continue;
            const e = byNode.get(r.node.id) ?? { id: r.node.id, path: r.node.path, open: 0, pendingVerify: 0, verified: 0, total: 0 };
            e.total += 1;
            if (r.status === 'open') e.open += 1;
            byNode.set(r.node.id, e);
          }
          return json(res, 200, { nodes: Array.from(byNode.values()) });
        }
        const one = /^feedback\/([^/]+)$/.exec(path);
        if (one && method === 'GET') {
          const report = reports.find((r) => r.id === one[1] || r.code === one[1]);
          if (!report) throw new Fault(404, 'NOT_FOUND', 'Reporte desconocido.');
          return json(res, 200, { report, attachments: [], tasks: [], agentBlock: `Reporte ${report.code}` });
        }
        throw new Fault(404, 'NOT_FOUND', 'Ruta desconocida.');
      }
      const docText = path.match(/^documents\/([^/]+)\/text$/);
      if (docText && method === 'POST') {
        if (session.role === 'reader') throw new Fault(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
        const body = await readJson(req);
        documentTexts.set(docText[1]!, { items: Array.isArray(body.items) ? body.items : [], source: body.source ?? 'pdf_text' });
        textPosts.push({ fileId: docText[1]!, items: documentTexts.get(docText[1]!)!.items.length, fill: body.fill === true });
        return json(res, 200, { file_id: docText[1], items: documentTexts.get(docText[1]!)!.items.length, ...(body.fill === true ? { fill: { filled: false, reason: 'FAKE' } } : {}) });
      }
      if (path === 'read/booking.reservation_invoice_source' && method === 'POST') {
        const body = await readJson(req);
        const found = reservationSources.get(String(body.reservation_id ?? ''));
        if (!found) throw new Fault(404, 'NOT_FOUND', 'La reserva no existe.');
        return json(res, 200, found);
      }
      if (path === 'read/invoices.vf_records_of' && method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, { records: vfRecords.filter((r) => r.issued_invoice_id === body.issued_invoice_id), settings: { sending: 'apagado', locked_until: null } });
      }
      if (path === 'read/invoices.document_text' && method === 'POST') {
        const body = await readJson(req);
        const found = documentTexts.get(String(body.file_id ?? ''));
        return json(res, 200, found ? { file_id: body.file_id, ...found } : null);
      }
      if (path === 'imports/extract' && method === 'POST') {
        if (session.role === 'reader') throw new Fault(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
        const body = await readJson(req);
        const ids: string[] = Array.isArray(body.file_ids) ? body.file_ids : [];
        if (!ids.length) throw new Fault(422, 'INVALID_OPERATION', 'Indica entre 1 y 8 identificadores de documento.');
        for (const id of ids) { const up = uploads.get(id); if (!up || up.status !== 'verified') throw new Fault(422, 'INVALID_FILE', 'El documento no existe o no está verificado.'); }
        if (!extractor) throw new Fault(503, 'EXTRACTION_UNAVAILABLE', 'La extracción automática no está disponible ahora mismo. Pega el JSON de ChatGPT.');
        const out = extractor(ids);
        if (out.fault) throw new Fault(out.fault.status, out.fault.code, out.fault.message, out.fault.details ?? null);
        return json(res, 200, { document: out.document, document_sha256: createHash('sha256').update(JSON.stringify(out.document)).digest('hex'), warnings: out.warnings ?? [], usage: out.usage ?? null });
      }
      const targetsList = path.match(/^targets\/(tasks|food|booking)$/);
      if (targetsList && method === 'GET') {
        if (session.role === 'reader') throw new Fault(403, 'FORBIDDEN', 'No tienes permiso para esta operación.');
        // Reservas: sin destinos de Booking configurados, como antes de la proyección de Booking (fase 2).
        if (targetsList[1] === 'booking' && !targets.some((t) => t.app === 'booking')) throw new Fault(422, 'TARGET_APP_NOT_AVAILABLE', 'Ese tipo de destino llegará en la fase 2.');
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        const kind = url.searchParams.get('kind');
        return json(res, 200, { items: targets.filter((t) => t.app === targetsList[1] && (!kind || t.kind === kind) && (!q || t.label.toLowerCase().includes(q))).map((t) => ({ ...t, code: null, archived: false, path: t.path ?? [] })) });
      }
      const targetOne = path.match(/^targets\/(tasks|food|booking)\/([^/]+)\/([^/]+)$/);
      if (targetOne && method === 'GET') {
        const t = targets.find((x) => x.app === targetOne[1] && x.kind === targetOne[2] && x.id === targetOne[3]);
        if (!t) throw new Fault(404, 'TARGET_NOT_FOUND', 'El destino ya no existe en Tareas.');
        return json(res, 200, { ...t, code: null, archived: false, path: t.path ?? [] });
      }
      throw new Fault(404, 'NOT_FOUND', 'Ruta desconocida.');
    } catch (error) {
      if (error instanceof Fault) return json(res, error.status, { error: { code: error.code, message: error.message, details: error.details } });
      console.error('[fake-api]', error);
      return json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'Error interno.', details: null } });
    }
  }

  const server: Server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    cursor: () => cursor,
    rows: (table) => Array.from(data.get(table)?.values() ?? []),
    serverUpdate(table, id, fields) {
      const row = data.get(table)?.get(id);
      if (!row) throw new Error(`fila ${id} no existe`);
      Object.assign(row, fields);
      row.revision += 1;
      row.updated_at = nowIso();
      cursor += 1;
      changes.push(record(table, 'update', row, cursor, 1, `server-${cursor}`, 'server'));
      return row;
    },
    requests,
    uploads: () => Array.from(uploads.values()),
    seed(table, rows) {
      const store = data.get(table);
      if (!store) throw new Error(`tabla ${table} no registrada`);
      cursor += 1;
      const staged = new Map<string, Map<string, FakeRow>>(Array.from(data.entries()));
      rows.forEach((fields, i) => {
        const now = nowIso();
        const id = String(fields.id ?? randomUUID());
        const row: FakeRow = { id, revision: 1, created_at: now, updated_at: now, updated_by: 'seed', deleted_at: null };
        for (const column of tables[table]!) row[column] = fields[column] ?? null;
        applyInsertDefaults(table, row, staged);
        for (const [k, v] of Object.entries(fields)) if (!(k in row) || row[k] === null) row[k] = v;
        store.set(id, row);
        changes.push(record(table, 'insert', row, cursor, i + 1, `seed-${cursor}`, 'seed'));
      });
    },
    setExtractor(fn) { extractor = fn; },
    setEntity(e) { entity = e; },
    setReservationSource(id, source) { if (source) reservationSources.set(id, source); else reservationSources.delete(id); },
    feedbackReports: () => Array.from(feedbackStore.values()).map((r) => ({ ...r })),
    documentTextPosts: () => textPosts.map((t) => ({ ...t })),
    usageBatches: () => usageBatches.map((b) => ({ ...b })),
    failNextVerify: () => { failVerify = true; },
    targets,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
