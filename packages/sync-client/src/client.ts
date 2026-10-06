import type {
  ApiError,
  Bootstrap,
  ChangeRecord,
  CommandBatch,
  CommandResult,
  PendingConflict,
  RejectedBatch,
  RowId,
  RowOperation,
  Session,
  SyncClient,
  SyncClientOptions,
  SyncStatus,
  SyncedRow,
  TableName,
} from './types.ts';
import { SyncApiError, isApiError, isNetworkError, networkError, toApiError } from './errors.ts';
import { BLOBS_STORE, CONFLICTS_STORE, Database, META_STORE, OUTBOX_STORE, REJECTED_STORE, resolveIndexedDB } from './idb.ts';
import { analyseConflict, operationKey, rowKey, stripLocal, type RowKey } from './conflicts.ts';

// ---------------------------------------------------------------------------
// Registros internos de IndexedDB
// ---------------------------------------------------------------------------

/** Fila del espejo: la del servidor más la marca local de «pendiente de confirmar». */
export type MirrorRow = SyncedRow & { _pending?: boolean };

interface MetaRecord<T = unknown> {
  key: string;
  value: T;
}

export interface OutboxEntry {
  requestId: string;
  /** Orden de inserción (createdAt puede repetirse en el mismo milisegundo). */
  seq: number;
  createdAt: string;
  batch: CommandBatch;
  /** Filas tal y como estaban en el espejo al editar, por `table|id` (null = no existía). */
  baseRows: Record<string, SyncedRow | null>;
  /** Imágenes `after` recibidas por pull mientras el comando esperaba (null = purgada). */
  remoteRows: Record<string, SyncedRow | null>;
  rebases: number;
}

export interface ConflictRecord extends PendingConflict {
  code: 'VERSION_CONFLICT' | 'ROW_DELETED';
  /** Operaciones del mismo lote sobre otras filas; se reenvían con la decisión. */
  otherOperations: RowOperation[];
  blobs?: string[];
}

export interface BlobRecord {
  sha256: string;
  blob: Blob;
  filename: string;
  mime: string;
  size: number;
  status: 'staged' | 'uploaded';
  fileId?: string;
  createdAt: string;
}

interface UploadTicket {
  id: string;
  uploadUrl: string;
  method?: string;
  headers?: Record<string, string>;
  expiresAt?: string;
}

interface SnapshotResponse {
  cursor: number;
  tables: Array<{ table: TableName; rows: SyncedRow[]; total: number }>;
}

interface ChangesResponse {
  items: ChangeRecord[];
  cursor: number;
  latest: number;
  hasMore: boolean;
}

interface VersionConflictDetails {
  table: TableName;
  id: RowId;
  expectedRevision: number;
  currentRevision: number;
  current: SyncedRow;
}

const PAGE_LIMIT = 500;
const MAX_OPERATIONS = 500;
const MAX_REBASES = 3;
const REFRESH_MARGIN_SECONDS = 60;
const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;
/** Clave del marcador de adjunto: `{ "$blob": "<sha256>" }` se sustituye por el `fileId` antes de enviar. */
const BLOB_MARKER = '$blob';
const MAX_MARKER_DEPTH = 16;
/** Stores fijos que se vacían al cambiar de usuario o con `clearOnLogout: true`. */
const LOCAL_STATE_STORES = [OUTBOX_STORE, CONFLICTS_STORE, BLOBS_STORE, REJECTED_STORE];

type ApiInit = RequestInit & { json?: unknown };

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBlobMarker(value: unknown): value is { $blob: string } {
  return isPlainObject(value) && Object.keys(value).length === 1 && typeof value[BLOB_MARKER] === 'string';
}

/** Recorre un valor (objetos y arrays, hasta MAX_MARKER_DEPTH) sustituyendo cada marcador por `visit(sha)`. */
function walkBlobMarkers(value: unknown, visit: (sha: string) => unknown, depth = 0): unknown {
  if (depth > MAX_MARKER_DEPTH) return value;
  if (isBlobMarker(value)) return visit(value[BLOB_MARKER]);
  if (Array.isArray(value)) return value.map((v) => walkBlobMarkers(v, visit, depth + 1));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = walkBlobMarkers(v, visit, depth + 1);
    return out;
  }
  return value;
}

function markerContainer(op: RowOperation): Record<string, unknown> | null {
  if (op.op === 'insert' || op.op === 'update') return op.fields;
  if (op.op === 'call') return op.args;
  return null;
}

/** Hashes referenciados por marcadores `{ $blob }` en `fields` y `args`, sin repetir. */
export function collectBlobMarkers(operations: RowOperation[]): string[] {
  const found = new Set<string>();
  for (const op of operations) {
    const container = markerContainer(op);
    if (container) {
      walkBlobMarkers(container, (sha) => {
        found.add(sha);
        return null;
      });
    }
  }
  return Array.from(found);
}

/** Copia de las operaciones con cada marcador sustituido por su `fileId`. Lanza BLOB_MISSING si falta alguno. */
export function substituteBlobMarkers(operations: RowOperation[], fileIds: ReadonlyMap<string, string>): RowOperation[] {
  const resolve = (sha: string): string => {
    const fileId = fileIds.get(sha);
    if (fileId === undefined) {
      throw new SyncApiError(422, 'BLOB_MISSING', `El lote referencia un adjunto ${sha} que no está en local`, { sha256: sha });
    }
    return fileId;
  };
  return operations.map((op) => {
    if (op.op === 'insert' || op.op === 'update') return { ...op, fields: walkBlobMarkers(op.fields, resolve) as Record<string, unknown> };
    if (op.op === 'call') return { ...op, args: walkBlobMarkers(op.args, resolve) as Record<string, unknown> };
    return op;
  });
}

function touchesTables(operations: RowOperation[], tables: ReadonlySet<string>): boolean {
  return operations.some((op) => op.op !== 'call' && tables.has(op.table));
}

function hasExpectedRevision(op: RowOperation): op is Extract<RowOperation, { expectedRevision: number }> {
  return op.op === 'update' || op.op === 'delete' || op.op === 'restore';
}

function validateOperations(operations: RowOperation[]): void {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new SyncApiError(422, 'INVALID_OPERATION', 'El lote debe contener al menos una operación');
  }
  if (operations.length > MAX_OPERATIONS) {
    throw new SyncApiError(422, 'INVALID_OPERATION', `Máximo ${MAX_OPERATIONS} operaciones por lote`);
  }
  operations.forEach((op, index) => {
    const where = `operación ${index}`;
    if (!isPlainObject(op)) throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: no es un objeto`);
    if (op.op === 'call') {
      if (typeof op.procedure !== 'string' || op.procedure.length === 0) {
        throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: 'call' requiere procedure`);
      }
      if (!isPlainObject(op.args)) throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: 'call' requiere args`);
      return;
    }
    if (!['insert', 'update', 'delete', 'restore'].includes(op.op)) {
      throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: op desconocida '${String((op as { op: unknown }).op)}'`);
    }
    if (typeof op.table !== 'string' || !TABLE_NAME_RE.test(op.table)) {
      throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: table debe ser 'schema.tabla'`);
    }
    if (typeof op.id !== 'string' || op.id.length === 0) {
      throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: id obligatorio (uuid generado por el cliente)`);
    }
    if ((op.op === 'insert' || op.op === 'update') && !isPlainObject(op.fields)) {
      throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: fields debe ser un objeto`);
    }
    if (hasExpectedRevision(op) && (!Number.isInteger(op.expectedRevision) || op.expectedRevision < 0)) {
      throw new SyncApiError(422, 'INVALID_OPERATION', `${where}: expectedRevision debe ser un entero >= 0`);
    }
  });
}

function normalizeSession(data: Record<string, unknown>, previous: Session | null, nowSeconds: number): Session {
  const token = (data.token ?? data.access_token) as string | undefined;
  if (typeof token !== 'string' || token.length === 0) {
    throw new SyncApiError(502, 'BAD_AUTH_RESPONSE', 'La respuesta de autenticación no trae token');
  }
  const refreshToken = (data.refreshToken ?? data.refresh_token ?? previous?.refreshToken ?? '') as string;
  let expiresAt: number | null = null;
  const rawExpiresAt = data.expiresAt ?? data.expires_at;
  if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
    expiresAt = rawExpiresAt > 1e11 ? Math.floor(rawExpiresAt / 1000) : Math.floor(rawExpiresAt);
  } else if (typeof rawExpiresAt === 'string') {
    const parsed = Date.parse(rawExpiresAt);
    if (!Number.isNaN(parsed)) expiresAt = Math.floor(parsed / 1000);
  }
  if (expiresAt === null) {
    const expiresIn = (data.expiresIn ?? data.expires_in) as number | undefined;
    expiresAt = nowSeconds + (typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : 3600);
  }
  return { token, refreshToken, expiresAt };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function sameStatus(a: SyncStatus, b: SyncStatus): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function codeForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 413:
      return 'PAYLOAD_TOO_LARGE';
    case 422:
      return 'INVALID_OPERATION';
    case 503:
      return 'BACKEND_UNAVAILABLE';
    default:
      return `HTTP_${status}`;
  }
}

// ---------------------------------------------------------------------------
// Cliente
// ---------------------------------------------------------------------------

export class SyncClientImpl implements SyncClient {
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pullIntervalMs: number;
  private readonly configuredTables: TableName[] | null;
  private readonly db: Database;

  private sess: Session | null = null;
  private boot: Bootstrap | null = null;
  private cursor: number | null = null;
  private lastPullAt: string | null = null;
  private seq = 0;

  private state: SyncStatus;
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  private readonly tableListeners = new Map<TableName, Set<(rows: SyncedRow[]) => void>>();

  private ready: Promise<void> | null = null;
  private running: Promise<void> | null = null;
  private syncAgain = false;
  private needsPull = false;
  /** El aviso USER_CHANGED sobrevive al ciclo que lanza start() y se limpia en el siguiente. */
  private keepLastErrorOnce = false;
  private refreshing: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private listenersInstalled = false;
  private readonly onOnline = () => {
    this.setStatus({ network: 'online' });
    void this.sync().catch(() => undefined);
  };
  private readonly onOffline = () => this.setStatus({ network: 'offline' });
  private readonly onVisibility = () => {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    if (!doc || doc.visibilityState === 'visible') void this.sync().catch(() => undefined);
  };

  constructor(private readonly options: SyncClientOptions) {
    if (!options || typeof options.app !== 'string' || options.app.length === 0) {
      throw new Error('createSyncClient: `app` es obligatorio');
    }
    this.apiBase = (options.apiBase ?? '/api/v1').replace(/\/+$/, '');
    const injectedFetch = options.fetch ?? (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof injectedFetch !== 'function') throw new Error('createSyncClient: no hay `fetch` disponible');
    this.fetchImpl = options.fetch ? injectedFetch : injectedFetch.bind(globalThis);
    this.now = options.now ?? (() => Date.now());
    this.pullIntervalMs = options.pullIntervalMs ?? 30000;
    this.configuredTables = options.tables ? [...options.tables] : null;
    this.db = new Database(resolveIndexedDB(options.indexedDB), options.databaseName ?? `ikisai-${options.app}-v1`);
    this.state = {
      network: this.hasNetwork() ? 'online' : 'offline',
      cursor: 0,
      pendingCommands: 0,
      pendingBlobs: 0,
      conflicts: 0,
      lastPullAt: null,
      lastError: null,
      autoMerged: 0,
      rejected: 0,
    };
  }

  // ----------------------------------------------------------------------
  // Estado
  // ----------------------------------------------------------------------

  status(): SyncStatus {
    return { ...this.state, cursor: this.cursor ?? 0 };
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  onTable(table: TableName, listener: (rows: SyncedRow[]) => void): () => void {
    let set = this.tableListeners.get(table);
    if (!set) {
      set = new Set();
      this.tableListeners.set(table, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    const next: SyncStatus = { ...this.state, ...patch, cursor: this.cursor ?? 0 };
    if (sameStatus(next, this.status())) {
      this.state = next;
      return;
    }
    this.state = next;
    for (const listener of this.statusListeners) {
      try {
        listener(this.status());
      } catch {
        // los oyentes no deben romper el ciclo
      }
    }
  }

  private async refreshCounts(): Promise<void> {
    if (!this.db.isOpen) return;
    const [pendingCommands, conflicts, blobs, rejected] = await Promise.all([
      this.db.count(OUTBOX_STORE),
      this.db.count(CONFLICTS_STORE),
      this.db.getAll<BlobRecord>(BLOBS_STORE),
      this.db.count(REJECTED_STORE),
    ]);
    this.setStatus({ pendingCommands, conflicts, rejected, pendingBlobs: blobs.filter((b) => b.status === 'staged').length });
  }

  private recordError(error: unknown): ApiError {
    const apiError = toApiError(error);
    this.setStatus({ lastError: apiError });
    return apiError;
  }

  /** Clasifica un fallo de transporte o de API para el estado de red. */
  private handleFailure(error: unknown): void {
    this.recordError(error);
    if (isNetworkError(error)) this.setStatus({ network: 'offline' });
    else this.setStatus({ network: 'error' });
  }

  private hasNetwork(): boolean {
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return !nav || nav.onLine !== false;
  }

  private async emitTables(tables: Iterable<TableName>): Promise<void> {
    for (const table of new Set(tables)) {
      const listeners = this.tableListeners.get(table);
      if (!listeners || listeners.size === 0) continue;
      const rows = await this.list(table);
      for (const listener of listeners) {
        try {
          listener(rows);
        } catch {
          // ídem
        }
      }
    }
  }

  // ----------------------------------------------------------------------
  // Apertura y metadatos
  // ----------------------------------------------------------------------

  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.openAndLoad().catch((error) => {
        this.ready = null;
        throw error;
      });
    }
    return this.ready;
  }

  private async openAndLoad(): Promise<void> {
    await this.db.open(this.configuredTables ?? []);
    const meta = await this.db.getAll<MetaRecord>(META_STORE);
    const byKey = new Map(meta.map((m) => [m.key, m.value]));
    this.cursor = typeof byKey.get('cursor') === 'number' ? (byKey.get('cursor') as number) : null;
    this.lastPullAt = (byKey.get('lastPullAt') as string | undefined) ?? null;
    this.sess = (byKey.get('session') as Session | undefined) ?? null;
    this.boot = (byKey.get('bootstrap') as Bootstrap | undefined) ?? null;
    await this.db.ensureStores(this.mirrorTables());
    const outbox = await this.db.getAll<OutboxEntry>(OUTBOX_STORE);
    this.seq = outbox.reduce((max, e) => Math.max(max, e.seq), 0);
    this.setStatus({ lastPullAt: this.lastPullAt });
    await this.refreshCounts();
  }

  private async saveMeta(key: string, value: unknown): Promise<void> {
    await this.db.put<MetaRecord>(META_STORE, { key, value });
  }

  private async setSession(session: Session | null): Promise<void> {
    this.sess = session;
    await this.ensureReady();
    if (session) await this.saveMeta('session', session);
    else await this.db.delete(META_STORE, 'session');
  }

  private async setCursor(cursor: number): Promise<void> {
    this.cursor = cursor;
    await this.saveMeta('cursor', cursor);
    this.setStatus({});
  }

  private async markPulled(): Promise<void> {
    this.lastPullAt = new Date(this.now()).toISOString();
    await this.saveMeta('lastPullAt', this.lastPullAt);
    this.setStatus({ lastPullAt: this.lastPullAt });
  }

  /** Tablas legibles según el último bootstrap (null si aún no lo hay). */
  private readableTables(): Set<TableName> | null {
    return this.boot ? new Set(this.boot.tables.filter((t) => t.readable).map((t) => t.table)) : null;
  }

  /**
   * Tablas que mantiene el espejo: las configuradas (limitadas a las legibles si ya hay bootstrap),
   * si no las legibles del bootstrap, si no las ya existentes.
   */
  private mirrorTables(): TableName[] {
    const readable = this.readableTables();
    if (this.configuredTables) return readable ? this.configuredTables.filter((t) => readable.has(t)) : this.configuredTables;
    if (readable) return Array.from(readable);
    return this.db.isOpen ? (this.db.tableStores() as TableName[]) : [];
  }

  /** Vacía espejo, cola, conflictos, rechazados y blobs; el cursor vuelve a cero para que el próximo arranque haga snapshot. */
  private async clearLocalData(): Promise<void> {
    const tables = this.db.tableStores() as TableName[];
    await this.db.clearMany([...tables, ...LOCAL_STATE_STORES]);
    await this.resetCursor();
    this.setStatus({ autoMerged: 0 });
    await this.refreshCounts();
    await this.emitTables(tables);
  }

  /** Vacía solo las tablas indicadas y lo que las referencia (comandos, conflictos y rechazados que las tocan). */
  private async clearTables(tables: TableName[]): Promise<void> {
    const present = tables.filter((t) => this.db.storeNames().includes(t));
    const set = new Set<string>(tables);
    const [outbox, conflicts, rejected] = await Promise.all([
      this.db.getAll<OutboxEntry>(OUTBOX_STORE),
      this.db.getAll<ConflictRecord>(CONFLICTS_STORE),
      this.db.getAll<RejectedBatch>(REJECTED_STORE),
    ]);
    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    for (const e of outbox) if (touchesTables(e.batch.operations, set)) writes.push({ store: OUTBOX_STORE, key: e.requestId, value: null });
    for (const c of conflicts) {
      const op = c.operation as RowOperation;
      if ((op.op !== 'call' && set.has(op.table)) || touchesTables(c.otherOperations, set)) {
        writes.push({ store: CONFLICTS_STORE, key: c.requestId, value: null });
      }
    }
    for (const r of rejected) if (touchesTables(r.operations, set)) writes.push({ store: REJECTED_STORE, key: r.requestId, value: null });
    await this.db.clearMany(present);
    await this.db.writeMany(writes);
    await this.resetCursor();
    await this.refreshCounts();
    await this.emitTables(present);
  }

  private async resetCursor(): Promise<void> {
    this.cursor = null;
    this.lastPullAt = null;
    await this.db.writeMany([
      { store: META_STORE, key: 'cursor', value: null },
      { store: META_STORE, key: 'lastPullAt', value: null },
    ]);
    this.setStatus({ lastPullAt: null });
  }

  private tracksTable(table: TableName): boolean {
    return this.configuredTables === null || this.configuredTables.includes(table);
  }

  // ----------------------------------------------------------------------
  // Sesión y API
  // ----------------------------------------------------------------------

  session(): Session | null {
    return this.sess ? { ...this.sess } : null;
  }

  async login(email: string, password: string): Promise<Session> {
    await this.ensureReady();
    const res = await this.rawFetch(this.url('/auth/login'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: email, password }),
    });
    if (!res.ok) throw await this.errorFromResponse(res);
    const data = (await this.parseBody<Record<string, unknown>>(res)) ?? {};
    const session = normalizeSession(data, null, Math.floor(this.now() / 1000));
    await this.setSession(session);
    this.setStatus({ lastError: null });
    return { ...session };
  }

  async logout(): Promise<void> {
    await this.ensureReady();
    if (this.sess && this.hasNetwork()) {
      try {
        await this.api('/auth/logout', { method: 'POST' });
      } catch {
        // sin red o sesión ya inválida: basta con borrar la local
      }
    }
    await this.setSession(null);
    const clear = this.options.clearOnLogout ?? false;
    if (clear === true) await this.clearLocalData();
    else if (Array.isArray(clear) && clear.length > 0) await this.clearTables(clear);
  }

  async api<T = unknown>(path: string, init: ApiInit = {}): Promise<T> {
    const { json, headers: initHeaders, ...rest } = init;
    const url = this.url(path);
    const method = rest.method ?? (json !== undefined ? 'POST' : 'GET');

    const attempt = async (): Promise<Response> => {
      await this.refreshIfExpiring();
      const headers = new Headers(initHeaders ?? undefined);
      if (this.sess) headers.set('Authorization', `Bearer ${this.sess.token}`);
      let body = rest.body;
      if (json !== undefined) {
        body = JSON.stringify(json);
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
      }
      return this.rawFetch(url, { ...rest, method, headers, body: body ?? null });
    };

    let res = await attempt();
    if (res.status === 401 && this.sess?.refreshToken) {
      let refreshed = false;
      try {
        refreshed = await this.refreshSession();
      } catch (error) {
        if (isNetworkError(error)) throw error;
      }
      if (refreshed) res = await attempt();
    }
    if (!res.ok) throw await this.errorFromResponse(res);
    return (await this.parseBody<T>(res)) as T;
  }

  async fileUrl(fileId: string): Promise<string> {
    const data = await this.api<{ url: string; expiresAt?: string }>(`/files/${encodeURIComponent(fileId)}`);
    return data.url;
  }

  private url(path: string): string {
    if (/^https?:\/\//.test(path)) return path;
    return `${this.apiBase}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      throw networkError(error);
    }
  }

  private async parseBody<T>(res: Response): Promise<T | undefined> {
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SyncApiError(res.status, 'BAD_RESPONSE', 'La respuesta del servidor no es JSON válido', text.slice(0, 200));
    }
  }

  private async errorFromResponse(res: Response): Promise<SyncApiError> {
    let payload: unknown = null;
    try {
      const text = await res.text();
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    const err = isPlainObject(payload) && isPlainObject(payload.error) ? payload.error : null;
    const code = typeof err?.code === 'string' ? err.code : codeForStatus(res.status);
    const message = typeof err?.message === 'string' ? err.message : `HTTP ${res.status}`;
    return new SyncApiError(res.status, code, message, err?.details ?? null);
  }

  private async refreshIfExpiring(): Promise<void> {
    const sess = this.sess;
    if (!sess || !sess.refreshToken) return;
    const remaining = sess.expiresAt - Math.floor(this.now() / 1000);
    if (remaining >= REFRESH_MARGIN_SECONDS) return;
    try {
      await this.refreshSession();
    } catch (error) {
      if (isNetworkError(error)) throw error;
      // si el refresh falla por credenciales, la sesión ya se ha borrado y la petición devolverá 401
    }
  }

  private refreshSession(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const sess = this.sess;
      if (!sess?.refreshToken) return false;
      const res = await this.rawFetch(this.url('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: sess.refreshToken }),
      });
      if (!res.ok) {
        const error = await this.errorFromResponse(res);
        if (res.status === 400 || res.status === 401 || res.status === 403) await this.setSession(null);
        throw error;
      }
      const data = (await this.parseBody<Record<string, unknown>>(res)) ?? {};
      await this.setSession(normalizeSession(data, sess, Math.floor(this.now() / 1000)));
      return true;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  // ----------------------------------------------------------------------
  // Arranque y ciclo
  // ----------------------------------------------------------------------

  bootstrap(): Bootstrap | null {
    return this.boot;
  }

  async start(): Promise<Bootstrap | null> {
    await this.ensureReady();
    this.installListeners();
    if (this.sess && this.hasNetwork()) {
      try {
        const boot = await this.api<Bootstrap>('/bootstrap');
        const previous = this.boot;
        const previousUserId = (await this.db.get<MetaRecord<string>>(META_STORE, 'userId'))?.value ?? previous?.profile.userId ?? null;
        this.boot = boot;
        await this.saveMeta('bootstrap', boot);
        await this.saveMeta('userId', boot.profile.userId);
        this.setStatus({ network: 'online' });

        if (previousUserId !== null && previousUserId !== boot.profile.userId) {
          // Otra persona ha entrado en este dispositivo: nada de lo local le pertenece.
          await this.clearLocalData();
          await this.db.dropStores(this.db.tableStores());
          this.setStatus({
            lastError: {
              status: 0,
              code: 'USER_CHANGED',
              message: 'Ha entrado otra persona en este dispositivo: se vaciaron el espejo local y la cola',
              details: { previousUserId, userId: boot.profile.userId },
            },
          });
          this.keepLastErrorOnce = true;
        } else {
          // Cambio de ámbitos: filas o tablas que dejan de ser legibles desaparecen del dispositivo.
          const readable = this.readableTables() ?? new Set<TableName>();
          const dropped = (this.db.tableStores() as TableName[]).filter((t) => !readable.has(t));
          const membershipChanged = previous !== null && previous.membership.revision !== boot.membership.revision;
          if (dropped.length > 0 || membershipChanged) await this.replaceMirror(dropped);
        }

        await this.db.ensureStores(this.mirrorTables());
        if (this.cursor === null) await this.snapshot();
        void this.sync().catch(() => undefined);
      } catch (error) {
        this.handleFailure(error);
      }
    } else if (!this.hasNetwork()) {
      this.setStatus({ network: 'offline' });
    }
    return this.boot;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const target = globalThis as unknown as Partial<EventTarget>;
    if (this.listenersInstalled && typeof target.removeEventListener === 'function') {
      target.removeEventListener('online', this.onOnline);
      target.removeEventListener('offline', this.onOffline);
      const doc = (globalThis as { document?: EventTarget }).document;
      (doc ?? target).removeEventListener?.('visibilitychange', this.onVisibility);
    }
    this.listenersInstalled = false;
  }

  private installListeners(): void {
    if (this.pullIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => {
        if (this.hasNetwork() && this.sess) void this.sync().catch(() => undefined);
      }, this.pullIntervalMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
    const target = globalThis as unknown as Partial<EventTarget>;
    if (!this.listenersInstalled && typeof target.addEventListener === 'function') {
      target.addEventListener('online', this.onOnline);
      target.addEventListener('offline', this.onOffline);
      const doc = (globalThis as { document?: EventTarget }).document;
      (doc ?? target).addEventListener?.('visibilitychange', this.onVisibility);
      this.listenersInstalled = true;
    }
  }

  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      await this.ensureReady();
      do {
        this.syncAgain = false;
        await this.runCycle();
        // Solo se repite si entró un comando nuevo durante el ciclo y la red sigue bien.
      } while (this.syncAgain && this.state.network === 'online');
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Lanza un ciclo en segundo plano; si ya hay uno, pide que al terminar vuelva a mirar la cola. */
  private kick(): void {
    if (this.running) {
      this.syncAgain = true;
      return;
    }
    void this.sync().catch(() => undefined);
  }

  private async runCycle(): Promise<void> {
    if (!this.sess) {
      this.setStatus({ network: this.hasNetwork() ? 'online' : 'offline' });
      return;
    }
    this.setStatus({ network: 'syncing', lastError: this.keepLastErrorOnce ? this.state.lastError : null });
    this.keepLastErrorOnce = false;
    try {
      await this.pull();
      const pushedAll = await this.push();
      if (this.needsPull) {
        this.needsPull = false;
        await this.pull();
      }
      if (pushedAll && this.state.network === 'syncing') this.setStatus({ network: 'online' });
    } catch (error) {
      this.handleFailure(error);
    }
    await this.refreshCounts();
  }

  // ----------------------------------------------------------------------
  // Lectura del espejo
  // ----------------------------------------------------------------------

  async list(table: TableName, options: { includeDeleted?: boolean } = {}): Promise<SyncedRow[]> {
    await this.ensureReady();
    if (!this.db.storeNames().includes(table)) return [];
    const rows = await this.db.getAll<MirrorRow>(table);
    return options.includeDeleted ? rows : rows.filter((r) => r.deleted_at === null || r.deleted_at === undefined);
  }

  async get(table: TableName, id: RowId): Promise<SyncedRow | null> {
    await this.ensureReady();
    if (!this.db.storeNames().includes(table)) return null;
    return (await this.db.get<MirrorRow>(table, id)) ?? null;
  }

  private async readRow(table: TableName, id: RowId): Promise<MirrorRow | null> {
    if (!this.db.storeNames().includes(table)) return null;
    return (await this.db.get<MirrorRow>(table, id)) ?? null;
  }

  private async pendingOwners(): Promise<Map<RowKey, OutboxEntry[]>> {
    const entries = (await this.db.getAll<OutboxEntry>(OUTBOX_STORE)).sort((a, b) => a.seq - b.seq);
    return groupByKey(entries);
  }

  // ----------------------------------------------------------------------
  // Pull
  // ----------------------------------------------------------------------

  private async snapshot(): Promise<void> {
    const tables = this.mirrorTables();
    if (tables.length === 0) {
      await this.setCursor(this.boot?.cursor ?? 0);
      await this.markPulled();
      return;
    }
    await this.db.ensureStores(tables);
    const owners = await this.pendingOwners();
    let remaining: TableName[] = [...tables];
    let offset = 0;
    let snapshotCursor: number | null = null;
    while (remaining.length > 0) {
      const query = `tables=${encodeURIComponent(remaining.join(','))}&includeDeleted=1&limit=${PAGE_LIMIT}&offset=${offset}`;
      const page = await this.api<SnapshotResponse>(`/snapshot?${query}`);
      if (snapshotCursor === null) snapshotCursor = page.cursor;
      const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
      const next: TableName[] = [];
      for (const t of page.tables ?? []) {
        if (!this.tracksTable(t.table)) continue;
        for (const row of t.rows) {
          if (owners.has(rowKey(t.table, row.id))) continue;
          writes.push({ store: t.table, value: stripLocal(row) });
        }
        if (t.rows.length >= PAGE_LIMIT) next.push(t.table);
      }
      await this.db.writeMany(writes);
      remaining = next;
      offset += PAGE_LIMIT;
    }
    await this.setCursor(snapshotCursor ?? this.boot?.cursor ?? 0);
    await this.markPulled();
    await this.emitTables(tables);
  }

  /**
   * Rehace el espejo completo: elimina las tablas que ya no son legibles, borra las filas sin comando pendiente
   * y vuelve a pedir el snapshot. La outbox no se toca (sus filas provisionales siguen en el espejo).
   */
  private async replaceMirror(dropped: TableName[]): Promise<void> {
    await this.db.dropStores(dropped);
    const owners = await this.pendingOwners();
    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    for (const table of this.db.tableStores() as TableName[]) {
      for (const row of await this.db.getAll<MirrorRow>(table)) {
        if (!owners.has(rowKey(table, row.id))) writes.push({ store: table, key: row.id, value: null });
      }
    }
    await this.db.writeMany(writes);
    await this.resetCursor();
    await this.snapshot();
  }

  private async pull(): Promise<void> {
    if (this.cursor === null) {
      await this.snapshot();
    }
    let after = this.cursor ?? 0;
    const touched = new Set<TableName>();
    for (;;) {
      const page = await this.api<ChangesResponse>(`/changes?after=${after}&limit=${PAGE_LIMIT}`);
      const items = page.items ?? [];
      if (items.length > 0) {
        for (const t of await this.applyRemoteChanges(items)) touched.add(t);
      }
      const reached = Math.max(page.cursor ?? after, items.reduce((m, c) => Math.max(m, c.cursor), after));
      if (reached > after) {
        after = reached;
        await this.setCursor(after);
      }
      if (!page.hasMore || items.length === 0) break;
    }
    await this.markPulled();
    await this.emitTables(touched);
  }

  /**
   * Aplica cambios remotos al espejo. Las filas con edición pendiente en la outbox no se tocan:
   * su `after` queda como base remota del comando para el rebase.
   */
  private async applyRemoteChanges(changes: ChangeRecord[], exclude?: string): Promise<Set<TableName>> {
    const tables = Array.from(new Set(changes.map((c) => c.table).filter((t) => this.tracksTable(t))));
    await this.db.ensureStores(tables);
    const owners = await this.pendingOwners();
    if (exclude) {
      for (const [key, list] of owners) {
        const rest = list.filter((e) => e.requestId !== exclude);
        if (rest.length === 0) owners.delete(key);
        else owners.set(key, rest);
      }
    }
    const touched = new Set<TableName>();
    const updatedEntries = new Map<string, OutboxEntry>();
    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    for (const change of changes) {
      if (!this.tracksTable(change.table)) continue;
      const key = rowKey(change.table, change.id);
      const pending = owners.get(key);
      if (pending && pending.length > 0) {
        for (const entry of pending) {
          entry.remoteRows[key] = change.after ? stripLocal(change.after) : null;
          updatedEntries.set(entry.requestId, entry);
        }
        continue;
      }
      if (change.after === null) writes.push({ store: change.table, key: change.id, value: null });
      else writes.push({ store: change.table, value: stripLocal(change.after) });
      touched.add(change.table);
    }
    for (const entry of updatedEntries.values()) writes.push({ store: OUTBOX_STORE, value: entry });
    await this.db.writeMany(writes);
    return touched;
  }

  // ----------------------------------------------------------------------
  // Edición optimista
  // ----------------------------------------------------------------------

  async commit(operations: RowOperation[], options: { requestId?: string; blobs?: Blob[] } = {}): Promise<{ requestId: string }> {
    await this.ensureReady();
    validateOperations(operations);
    const hashes: string[] = [];
    for (const blob of options.blobs ?? []) {
      const filename = (blob as Blob & { name?: string }).name ?? '';
      hashes.push(await this.stageBlob(blob, { filename, mime: blob.type }));
    }
    return this.enqueue(operations, { requestId: options.requestId, blobs: hashes });
  }

  private async enqueue(
    operations: RowOperation[],
    options: { requestId?: string; blobs?: string[] },
  ): Promise<{ requestId: string }> {
    const requestId = options.requestId ?? crypto.randomUUID();
    if (await this.db.get<OutboxEntry>(OUTBOX_STORE, requestId)) {
      throw new SyncApiError(409, 'DUPLICATE_REQUEST', `Ya hay un comando en cola con requestId ${requestId}`);
    }
    const tables = Array.from(new Set(operations.flatMap((op) => (op.op === 'call' ? [] : [op.table]))));
    await this.db.ensureStores(tables);

    const nowIso = new Date(this.now()).toISOString();
    const userId = this.boot?.profile.userId ?? null;
    const baseRows: Record<string, SyncedRow | null> = {};
    const rows = new Map<RowKey, MirrorRow | null>();
    const touched = new Set<TableName>();
    for (const op of operations) {
      if (op.op === 'call') continue;
      const key = rowKey(op.table, op.id);
      if (!(key in baseRows)) {
        const existing = await this.readRow(op.table, op.id);
        baseRows[key] = existing ? stripLocal(existing) : null;
        rows.set(key, existing);
      }
      const next = applyLocally(rows.get(key) ?? null, op, nowIso, userId);
      if (next) {
        rows.set(key, next);
        touched.add(op.table);
      }
    }

    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    for (const [key, row] of rows) {
      if (row && row._pending) writes.push({ store: key.slice(0, key.indexOf('|')), value: row });
    }
    const entry: OutboxEntry = {
      requestId,
      seq: ++this.seq,
      createdAt: nowIso,
      batch: { requestId, operations, ...(options.blobs && options.blobs.length > 0 ? { blobs: options.blobs } : {}) },
      baseRows,
      remoteRows: {},
      rebases: 0,
    };
    writes.push({ store: OUTBOX_STORE, value: entry });
    await this.db.writeMany(writes);
    await this.refreshCounts();
    await this.emitTables(touched);
    if (this.hasNetwork() && this.sess) this.kick();
    return { requestId };
  }

  async stageBlob(blob: Blob, meta: { filename: string; mime: string }): Promise<string> {
    await this.ensureReady();
    const bytes = await blob.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const existing = await this.db.get<BlobRecord>(BLOBS_STORE, sha256);
    if (!existing) {
      await this.db.put<BlobRecord>(BLOBS_STORE, {
        sha256,
        blob,
        filename: meta.filename || sha256,
        mime: meta.mime || blob.type || 'application/octet-stream',
        size: blob.size,
        status: 'staged',
        createdAt: new Date(this.now()).toISOString(),
      });
      await this.refreshCounts();
    }
    return sha256;
  }

  // ----------------------------------------------------------------------
  // Push
  // ----------------------------------------------------------------------

  /** Devuelve true si la cola quedó vacía (o no había nada); false si hubo que parar. */
  private async push(): Promise<boolean> {
    let cursorRetries = 0;
    for (;;) {
      const entries = (await this.db.getAll<OutboxEntry>(OUTBOX_STORE)).sort((a, b) => a.seq - b.seq);
      const entry = entries[0];
      if (!entry) return true;

      // Adjuntos: los declarados en `blobs` y los referenciados con marcadores `{ $blob }`.
      const shas = Array.from(new Set([...(entry.batch.blobs ?? []), ...collectBlobMarkers(entry.batch.operations)]));
      let outgoing: CommandBatch;
      try {
        const fileIds = await this.uploadBlobs(entry, shas);
        outgoing = {
          ...entry.batch,
          operations: substituteBlobMarkers(entry.batch.operations, fileIds),
          ...(shas.length > 0 ? { blobs: shas } : {}),
        };
      } catch (error) {
        if (isApiError(error) && error.code === 'BLOB_MISSING') {
          await this.reject(entry, error);
          continue;
        }
        this.handleFailure(error);
        return false;
      }

      let result: CommandResult;
      try {
        result = await this.api<CommandResult>('/commands', { method: 'POST', json: outgoing });
      } catch (error) {
        if (!isApiError(error) || isNetworkError(error) || error.status === 401 || error.status >= 500) {
          // Sin red, sesión caducada sin refresco posible o fallo del servidor: la cola espera tal cual.
          this.handleFailure(error);
          return false;
        }
        if (error.code === 'VERSION_CONFLICT') {
          const details = error.details as VersionConflictDetails | null;
          if (!details || !details.current) {
            this.handleFailure(error);
            return false;
          }
          const rebased = await this.rebaseOrPark(entry, details);
          if (rebased) continue;
          await this.refreshCounts();
          continue;
        }
        if (error.code === 'ROW_DELETED') {
          await this.parkRowDeleted(entry, error);
          await this.refreshCounts();
          continue;
        }
        if (error.code === 'CURSOR_CONFLICT' && cursorRetries < 1) {
          cursorRetries += 1;
          await this.pull();
          continue;
        }
        if (error.status >= 400 && error.status < 500) {
          // Error definitivo (INVALID_FIELDS, CONSTRAINT_VIOLATION, FORBIDDEN, NOT_FOUND, IDEMPOTENCY_REUSE…):
          // el lote pasa a `rejected`, el espejo vuelve a la base y la cola sigue con el siguiente.
          await this.reject(entry, error);
          continue;
        }
        this.handleFailure(error);
        return false;
      }

      await this.applyCommandResult(entry, result);
      await this.refreshCounts();
    }
  }

  /** Sube y verifica los adjuntos que falten; devuelve `sha256 → fileId` de todos ellos. */
  private async uploadBlobs(entry: OutboxEntry, shas: string[]): Promise<Map<string, string>> {
    const fileIds = new Map<string, string>();
    for (const sha of shas) {
      const record = await this.db.get<BlobRecord>(BLOBS_STORE, sha);
      if (!record) {
        throw new SyncApiError(422, 'BLOB_MISSING', `El lote ${entry.requestId} referencia un adjunto ${sha} que no está en local`, {
          sha256: sha,
        });
      }
      if (record.status === 'uploaded' && record.fileId) {
        fileIds.set(sha, record.fileId);
        continue;
      }
      const ticket = await this.api<UploadTicket>('/uploads', {
        json: { filename: record.filename, mime: record.mime, size: record.size, sha256: record.sha256 },
      });
      const headers = new Headers(ticket.headers ?? {});
      if (!headers.has('Content-Type') && record.mime) headers.set('Content-Type', record.mime);
      const put = await this.rawFetch(ticket.uploadUrl, { method: ticket.method ?? 'PUT', headers, body: record.blob });
      if (!put.ok) {
        throw new SyncApiError(put.status, 'UPLOAD_FAILED', `La subida del adjunto ${record.filename} devolvió HTTP ${put.status}`, {
          sha256: sha,
          uploadId: ticket.id,
        });
      }
      const verified = await this.api<{ id: string; sha256: string; size: number; verified: boolean }>(
        `/uploads/${encodeURIComponent(ticket.id)}/verify`,
        { method: 'POST' },
      );
      if (!verified || verified.verified !== true) {
        throw new SyncApiError(409, 'UPLOAD_FAILED', `El servidor no pudo verificar el adjunto ${record.filename}`, {
          sha256: sha,
          uploadId: ticket.id,
        });
      }
      await this.db.put<BlobRecord>(BLOBS_STORE, { ...record, status: 'uploaded', fileId: ticket.id });
      fileIds.set(sha, ticket.id);
      await this.refreshCounts();
    }
    return fileIds;
  }

  /** Éxito del servidor: sustituye las filas provisionales por las confirmadas y saca el comando de la cola. */
  private async applyCommandResult(entry: OutboxEntry, result: CommandResult): Promise<void> {
    const changes = result.changes ?? [];
    const others = (await this.db.getAll<OutboxEntry>(OUTBOX_STORE)).filter((e) => e.requestId !== entry.requestId).sort((a, b) => a.seq - b.seq);
    const owners = groupByKey(others);
    const tables = Array.from(new Set(changes.map((c) => c.table).filter((t) => this.tracksTable(t))));
    await this.db.ensureStores(tables);

    const touched = new Set<TableName>();
    const updated = new Map<string, OutboxEntry>();
    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    const covered = new Set<RowKey>();
    for (const change of changes) {
      if (!this.tracksTable(change.table)) continue;
      const key = rowKey(change.table, change.id);
      covered.add(key);
      const later = owners.get(key);
      if (later && later.length > 0) {
        // Comandos posteriores sobre la misma fila: su expectedRevision y su base pasan a la verdad confirmada.
        for (const e of later) {
          const baseRev = e.baseRows[key]?.revision;
          for (const op of e.batch.operations) {
            if (operationKey(op) !== key || !hasExpectedRevision(op) || change.revision === null) continue;
            const delta = change.revision - (baseRev ?? op.expectedRevision);
            op.expectedRevision = Math.max(0, op.expectedRevision + delta);
          }
          e.baseRows[key] = change.after ? stripLocal(change.after) : null;
          delete e.remoteRows[key];
          updated.set(e.requestId, e);
        }
        continue;
      }
      if (change.after === null) writes.push({ store: change.table, key: change.id, value: null });
      else writes.push({ store: change.table, value: stripLocal(change.after) });
      touched.add(change.table);
    }
    for (const key of Object.keys(entry.baseRows) as RowKey[]) {
      if (!covered.has(key) && !owners.has(key)) this.needsPull = true;
    }
    for (const e of updated.values()) writes.push({ store: OUTBOX_STORE, value: e });
    writes.push({ store: OUTBOX_STORE, key: entry.requestId, value: null });
    await this.db.writeMany(writes);

    if (this.cursor !== null && result.cursor === this.cursor + 1) await this.setCursor(result.cursor);
    else if (this.cursor !== null && result.cursor > this.cursor + 1) this.needsPull = true;
    await this.emitTables(touched);
  }

  // ----------------------------------------------------------------------
  // Conflictos
  // ----------------------------------------------------------------------

  private async rebaseOrPark(entry: OutboxEntry, details: VersionConflictDetails): Promise<boolean> {
    const key = rowKey(details.table, details.id);
    const candidates = entry.batch.operations.filter((op) => operationKey(op) === key && op.op !== 'insert');
    const operation =
      candidates.find((op) => hasExpectedRevision(op) && op.expectedRevision === details.expectedRevision) ?? candidates[0];
    if (!operation) {
      // El servidor señala una fila que este lote no toca explícitamente (p. ej. un `call`): no se puede rebasar.
      await this.park(entry, {
        code: 'VERSION_CONFLICT',
        operation: { op: 'update', table: details.table, id: details.id, expectedRevision: details.expectedRevision, fields: {} },
        key,
        current: stripLocal(details.current),
        overlapping: [],
      });
      return false;
    }
    const base = entry.baseRows[key] ?? null;
    const current = stripLocal(details.current);
    const analysis = analyseConflict(operation, base, current);
    const canRebase =
      operation.op === 'update' && analysis.overlapping.length === 0 && !analysis.deletionChanged && entry.rebases < MAX_REBASES;

    if (canRebase) {
      const delta = details.currentRevision - details.expectedRevision;
      for (const op of entry.batch.operations) {
        if (operationKey(op) === key && hasExpectedRevision(op)) op.expectedRevision = Math.max(0, op.expectedRevision + delta);
      }
      entry.rebases += 1;
      entry.baseRows[key] = current;
      delete entry.remoteRows[key];
      const nowIso = new Date(this.now()).toISOString();
      let row: MirrorRow | null = { ...current };
      for (const op of entry.batch.operations) {
        if (operationKey(op) === key) row = applyLocally(row, op, nowIso, this.boot?.profile.userId ?? null) ?? row;
      }
      await this.db.writeMany([
        { store: OUTBOX_STORE, value: entry },
        { store: details.table, value: row },
      ]);
      this.setStatus({ autoMerged: this.state.autoMerged + 1 });
      await this.emitTables([details.table]);
      return true;
    }

    const overlapping = [...analysis.overlapping];
    if (analysis.deletionChanged && !overlapping.includes('deleted_at')) overlapping.push('deleted_at');
    await this.park(entry, { code: 'VERSION_CONFLICT', operation, key, current, overlapping });
    return false;
  }

  private async parkRowDeleted(entry: OutboxEntry, error: SyncApiError): Promise<void> {
    const details = (isPlainObject(error.details) ? error.details : {}) as Partial<VersionConflictDetails>;
    const first = entry.batch.operations.find((op) => op.op !== 'call' && op.op !== 'insert') as
      | Extract<RowOperation, { op: 'update' | 'delete' | 'restore' }>
      | undefined;
    const table = details.table ?? first?.table;
    const id = details.id ?? first?.id;
    if (!table || !id) {
      await this.reject(entry, error);
      return;
    }
    const key = rowKey(table, id);
    const operation =
      entry.batch.operations.find((op) => operationKey(op) === key && op.op !== 'insert') ??
      ({ op: 'update', table, id, expectedRevision: details.expectedRevision ?? 0, fields: {} } as RowOperation);
    let current: SyncedRow | null = details.current ? stripLocal(details.current) : null;
    if (!current) {
      const local = entry.remoteRows[key] ?? entry.baseRows[key] ?? (await this.readRow(table, id));
      current = local
        ? { ...stripLocal(local), deleted_at: local.deleted_at ?? new Date(this.now()).toISOString() }
        : { id, revision: details.currentRevision ?? 0, created_at: '', updated_at: '', updated_by: null, deleted_at: new Date(this.now()).toISOString() };
    }
    await this.park(entry, { code: 'ROW_DELETED', operation, key, current, overlapping: ['deleted_at'] });
  }

  /** Mueve el comando a `conflicts`, lo saca de la outbox y devuelve el espejo a lo que dice el servidor. */
  private async park(
    entry: OutboxEntry,
    info: { code: ConflictRecord['code']; operation: RowOperation; key: RowKey; current: SyncedRow; overlapping: string[] },
  ): Promise<void> {
    const record: ConflictRecord = {
      requestId: entry.requestId,
      operation: info.operation as PendingConflict['operation'],
      base: entry.baseRows[info.key] ?? null,
      current: info.current,
      overlapping: info.overlapping,
      detectedAt: new Date(this.now()).toISOString(),
      code: info.code,
      otherOperations: entry.batch.operations.filter((op) => operationKey(op) !== info.key),
      ...(entry.batch.blobs ? { blobs: entry.batch.blobs } : {}),
    };
    await this.withdraw(entry, { [info.key]: info.current }, { conflict: record });
  }

  /** Error definitivo del servidor: el lote pasa a `rejected`, el espejo vuelve a la base y se anota en lastError. */
  private async reject(entry: OutboxEntry, error: SyncApiError): Promise<void> {
    const record: RejectedBatch = {
      requestId: entry.requestId,
      operations: entry.batch.operations,
      ...(entry.batch.blobs ? { blobs: entry.batch.blobs } : {}),
      error: error.toJSON(),
      baseRows: entry.baseRows,
      rejectedAt: new Date(this.now()).toISOString(),
      seq: entry.seq,
    };
    this.recordError(error);
    await this.withdraw(entry, {}, { rejected: record });
    this.needsPull = true;
    await this.refreshCounts();
  }

  /** Retira un comando de la outbox restaurando el espejo (fila conflictiva → `current`; resto → base remota o local). */
  private async withdraw(
    entry: OutboxEntry,
    overrides: Record<string, SyncedRow>,
    park: { conflict?: ConflictRecord; rejected?: RejectedBatch } = {},
  ): Promise<void> {
    const others = (await this.db.getAll<OutboxEntry>(OUTBOX_STORE)).filter((e) => e.requestId !== entry.requestId);
    const stillPending = groupByKey(others);
    const writes: Array<{ store: string; key?: IDBValidKey; value: unknown | null }> = [];
    const touched = new Set<TableName>();
    const keys = new Set<RowKey>([...Object.keys(entry.baseRows), ...Object.keys(overrides)] as RowKey[]);
    for (const key of keys) {
      const table = key.slice(0, key.indexOf('|')) as TableName;
      const id = key.slice(key.indexOf('|') + 1);
      if (!this.db.storeNames().includes(table)) continue;
      const override = overrides[key];
      if (override) {
        writes.push({ store: table, value: stripLocal(override) });
        touched.add(table);
        continue;
      }
      if (stillPending.has(key)) continue;
      const restored = key in entry.remoteRows ? entry.remoteRows[key] : entry.baseRows[key];
      if (restored) writes.push({ store: table, value: stripLocal(restored) });
      else writes.push({ store: table, key: id, value: null });
      touched.add(table);
    }
    writes.push({ store: OUTBOX_STORE, key: entry.requestId, value: null });
    if (park.conflict) writes.push({ store: CONFLICTS_STORE, value: park.conflict });
    if (park.rejected) writes.push({ store: REJECTED_STORE, value: park.rejected });
    await this.db.writeMany(writes);
    await this.emitTables(touched);
  }

  // ----------------------------------------------------------------------
  // Lotes rechazados
  // ----------------------------------------------------------------------

  async rejected(): Promise<RejectedBatch[]> {
    await this.ensureReady();
    const records = await this.db.getAll<RejectedBatch>(REJECTED_STORE);
    // Orden estable: el de la cola (seq); la fecha solo desempata registros antiguos sin seq.
    return records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.rejectedAt.localeCompare(b.rejectedAt));
  }

  async retryRejected(requestId: string, operations?: RowOperation[]): Promise<{ requestId: string }> {
    await this.ensureReady();
    const record = await this.db.get<RejectedBatch>(REJECTED_STORE, requestId);
    if (!record) throw new SyncApiError(404, 'NOT_FOUND', `No hay lote rechazado con requestId ${requestId}`);
    const next = operations ?? record.operations;
    validateOperations(next);
    await this.db.delete(REJECTED_STORE, requestId);
    const result = await this.enqueue(next, { ...(record.blobs ? { blobs: record.blobs } : {}) });
    await this.refreshCounts();
    return result;
  }

  async discardRejected(requestId: string): Promise<void> {
    await this.ensureReady();
    const record = await this.db.get<RejectedBatch>(REJECTED_STORE, requestId);
    if (!record) throw new SyncApiError(404, 'NOT_FOUND', `No hay lote rechazado con requestId ${requestId}`);
    await this.db.delete(REJECTED_STORE, requestId);
    await this.refreshCounts();
  }

  async conflicts(): Promise<PendingConflict[]> {
    await this.ensureReady();
    const records = await this.db.getAll<ConflictRecord>(CONFLICTS_STORE);
    return records
      .sort((a, b) => a.detectedAt.localeCompare(b.detectedAt))
      .map(({ code: _code, otherOperations: _others, blobs: _blobs, ...conflict }) => conflict);
  }

  async resolveConflict(
    requestId: string,
    decision: { choice: 'mine' } | { choice: 'theirs' } | { choice: 'merge'; fields: Record<string, unknown> },
  ): Promise<void> {
    await this.ensureReady();
    const record = await this.db.get<ConflictRecord>(CONFLICTS_STORE, requestId);
    if (!record) throw new SyncApiError(404, 'NOT_FOUND', `No hay conflicto pendiente con requestId ${requestId}`);
    await this.db.delete(CONFLICTS_STORE, requestId);

    const operations: RowOperation[] = [...record.otherOperations];
    if (decision.choice !== 'theirs') {
      const op = record.operation as RowOperation;
      const table = record.current.id && op.op !== 'call' ? op.table : null;
      if (table) {
        const id = record.current.id;
        const revision = record.current.revision;
        const fields: Record<string, unknown> =
          decision.choice === 'merge' ? { ...decision.fields } : op.op === 'update' ? { ...op.fields } : {};
        const rowDeletedOnServer = record.code === 'ROW_DELETED' || record.current.deleted_at !== null;
        if (decision.choice === 'mine' && op.op === 'delete') {
          operations.push({ op: 'delete', table, id, expectedRevision: revision });
        } else if (decision.choice === 'mine' && (op as RowOperation).op === 'restore') {
          operations.push({ op: 'restore', table, id, expectedRevision: revision });
        } else if (rowDeletedOnServer) {
          operations.push({ op: 'restore', table, id, expectedRevision: revision });
          if (Object.keys(fields).length > 0) operations.push({ op: 'update', table, id, expectedRevision: revision + 1, fields });
        } else if (Object.keys(fields).length > 0) {
          operations.push({ op: 'update', table, id, expectedRevision: revision, fields });
        }
      }
    }
    if (operations.length > 0) {
      await this.enqueue(operations, { ...(record.blobs ? { blobs: record.blobs } : {}) });
    }
    await this.refreshCounts();
  }
}

// ---------------------------------------------------------------------------
// Funciones puras auxiliares
// ---------------------------------------------------------------------------

function groupByKey(entries: OutboxEntry[]): Map<RowKey, OutboxEntry[]> {
  const map = new Map<RowKey, OutboxEntry[]>();
  for (const entry of entries) {
    for (const op of entry.batch.operations) {
      const key = operationKey(op);
      if (!key) continue;
      const list = map.get(key);
      if (list) {
        if (!list.includes(entry)) list.push(entry);
      } else map.set(key, [entry]);
    }
  }
  return map;
}

/** Aplica una operación al espejo local; devuelve null si no hay nada que escribir (fila desconocida o `call`). */
export function applyLocally(row: MirrorRow | null, op: RowOperation, nowIso: string, userId: string | null): MirrorRow | null {
  switch (op.op) {
    case 'insert':
      return {
        ...(row ?? {}),
        ...op.fields,
        id: op.id,
        revision: row?.revision ?? 0,
        created_at: row?.created_at ?? nowIso,
        updated_at: nowIso,
        updated_by: userId,
        deleted_at: null,
        _pending: true,
      };
    case 'update':
      return row ? { ...row, ...op.fields, id: row.id, updated_at: nowIso, _pending: true } : null;
    case 'delete':
      return row ? { ...row, deleted_at: nowIso, updated_at: nowIso, _pending: true } : null;
    case 'restore':
      return row ? { ...row, deleted_at: null, updated_at: nowIso, _pending: true } : null;
    case 'call':
      return null;
  }
}
