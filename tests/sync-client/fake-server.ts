/**
 * Servidor simulado en memoria para probar @ikisai/sync-client.
 * Implementa las rutas del contrato §5 que usa el cliente, con la semántica de core.commit (§4):
 * revisiones, cursor, log de cambios y recibos por requestId.
 */
import type { Bootstrap, ChangeRecord, CommandBatch, CommandResult, RowOperation, SyncedRow, TableName } from '../../packages/sync-client/src/types.ts';

export interface FakeServerOptions {
  app?: string;
  apiBase?: string;
  tables?: TableName[];
  userId?: string;
  role?: 'reader' | 'editor' | 'owner';
  /** Segundos de vida del token que devuelve login. */
  loginExpiresIn?: number;
}

interface Upload {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  bytes: Uint8Array | null;
  verified: boolean;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fail(status: number, code: string, message: string, details: unknown = null): Response {
  return json(status, { error: { code, message, details } });
}

class CommitError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(code);
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class FakeServer {
  readonly app: string;
  readonly apiBase: string;
  readonly tables: TableName[];
  readonly userId: string;
  role: 'reader' | 'editor' | 'owner';
  loginExpiresIn: number;

  rows = new Map<string, SyncedRow>();
  cursor = 0;
  changes: ChangeRecord[] = [];
  receipts = new Map<string, { digest: string; result: CommandResult }>();
  uploads = new Map<string, Upload>();
  tokens = new Set<string>();
  refreshTokens = new Set<string>();

  /** Interruptores para simular fallos. */
  down = false;
  /** Solo la ruta commands falla por red (para observar un pull sin push). */
  commandsDown = false;
  unavailable = false;
  dropNextCommandResponse = false;
  failVerify = false;

  /** Contadores para las aserciones. */
  calls: Array<{ method: string; path: string }> = [];
  refreshCount = 0;
  logoutCount = 0;
  commandCount = 0;
  private tokenCounter = 0;
  private clock = Date.parse('2026-10-05T10:00:00Z');

  constructor(options: FakeServerOptions = {}) {
    this.app = options.app ?? 'invoices';
    this.apiBase = options.apiBase ?? '/api/v1';
    this.tables = options.tables ?? ['invoices.suppliers'];
    this.userId = options.userId ?? '00000000-0000-4000-8000-000000000001';
    this.role = options.role ?? 'editor';
    this.loginExpiresIn = options.loginExpiresIn ?? 3600;
    this.fetch = this.fetch.bind(this);
  }

  // ---- utilidades de estado --------------------------------------------

  private key(table: TableName, id: string): string {
    return `${table}|${id}`;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  row(table: TableName, id: string): SyncedRow | undefined {
    return this.rows.get(this.key(table, id));
  }

  rowsOf(table: TableName): SyncedRow[] {
    return Array.from(this.rows.entries())
      .filter(([key]) => key.startsWith(`${table}|`))
      .map(([, row]) => row);
  }

  /** Inserta una fila «ya existente» en el servidor (como si otro usuario la hubiera creado). */
  seed(table: TableName, fields: Record<string, unknown>, id = crypto.randomUUID()): SyncedRow {
    const at = this.tick();
    const row: SyncedRow = { id, revision: 1, created_at: at, updated_at: at, updated_by: 'other-user', deleted_at: null, ...fields };
    this.rows.set(this.key(table, id), row);
    this.record('insert', table, row, 'other-user', null);
    return row;
  }

  /** Edición de otro usuario: incrementa revisión y anota el cambio. */
  update(table: TableName, id: string, fields: Record<string, unknown>): SyncedRow {
    const row = this.row(table, id);
    if (!row) throw new Error(`fake-server: no existe ${table}/${id}`);
    const next: SyncedRow = { ...row, ...fields, revision: row.revision + 1, updated_at: this.tick(), updated_by: 'other-user' };
    this.rows.set(this.key(table, id), next);
    this.record('update', table, next, 'other-user', null);
    return next;
  }

  delete(table: TableName, id: string): SyncedRow {
    const row = this.row(table, id);
    if (!row) throw new Error(`fake-server: no existe ${table}/${id}`);
    const next: SyncedRow = { ...row, revision: row.revision + 1, updated_at: this.tick(), deleted_at: this.tick(), updated_by: 'other-user' };
    this.rows.set(this.key(table, id), next);
    this.record('delete', table, next, 'other-user', null);
    return next;
  }

  private record(op: ChangeRecord['op'], table: TableName, after: SyncedRow | null, actorId: string, requestId: string | null): ChangeRecord {
    this.cursor += 1;
    const change: ChangeRecord = {
      cursor: this.cursor,
      seq: 0,
      at: this.tick(),
      actorId,
      requestId,
      table,
      id: after?.id ?? '',
      op,
      revision: after?.revision ?? null,
      after,
    };
    this.changes.push(change);
    return change;
  }

  expireTokens(): void {
    this.tokens.clear();
  }

  private issueSession(): { token: string; refreshToken: string; expiresAt: number; expiresIn: number } {
    this.tokenCounter += 1;
    const token = `token-${this.tokenCounter}`;
    const refreshToken = `refresh-${this.tokenCounter}`;
    this.tokens.add(token);
    this.refreshTokens.add(refreshToken);
    const expiresIn = this.loginExpiresIn;
    return { token, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + expiresIn, expiresIn };
  }

  // ---- fetch -------------------------------------------------------------

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.down) throw new TypeError('Failed to fetch');
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const url = new URL(raw, 'http://local.test');
    const headers = new Headers(init?.headers ?? undefined);

    if (url.hostname === 'storage.test') return this.handleStoragePut(url, method, headers, init?.body ?? null);

    if (!url.pathname.startsWith(this.apiBase)) return fail(404, 'NOT_FOUND', `ruta desconocida ${url.pathname}`);
    const path = url.pathname.slice(this.apiBase.length);
    this.calls.push({ method, path });
    const body = typeof init?.body === 'string' && init.body.length > 0 ? (JSON.parse(init.body) as Record<string, unknown>) : null;

    if (path === '/auth/login' && method === 'POST') {
      if (body?.password !== 'secret') return fail(401, 'INVALID_CREDENTIALS', 'Credenciales incorrectas');
      return json(200, this.issueSession());
    }
    if (path === '/auth/refresh' && method === 'POST') {
      const rt = body?.refreshToken;
      if (typeof rt !== 'string' || !this.refreshTokens.has(rt)) return fail(401, 'UNAUTHENTICATED', 'refresh token inválido');
      this.refreshTokens.delete(rt);
      this.refreshCount += 1;
      return json(200, this.issueSession());
    }

    const auth = headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !this.tokens.has(token)) return fail(401, 'UNAUTHENTICATED', 'Sesión no válida');

    if (path === '/auth/logout' && method === 'POST') {
      this.logoutCount += 1;
      this.tokens.delete(token);
      return new Response(null, { status: 204 });
    }
    if (this.unavailable) return fail(503, 'BACKEND_UNAVAILABLE', 'Base de datos no disponible');

    if (path === '/bootstrap' && method === 'GET') return json(200, this.bootstrap());
    if (path === '/snapshot' && method === 'GET') return this.snapshot(url.searchParams);
    if (path === '/changes' && method === 'GET') return this.changesPage(url.searchParams);
    if (path === '/commands' && method === 'POST') return this.commands(body as unknown as CommandBatch);
    if (path === '/uploads' && method === 'POST') return this.createUpload(body ?? {});
    const verify = /^\/uploads\/([^/]+)\/verify$/.exec(path);
    if (verify && method === 'POST') return this.verifyUpload(decodeURIComponent(verify[1]!));
    const file = /^\/files\/([^/]+)$/.exec(path);
    if (file && method === 'GET') {
      const id = decodeURIComponent(file[1]!);
      if (!this.uploads.get(id)?.verified) return fail(404, 'NOT_FOUND', 'archivo no encontrado');
      return json(200, { url: `https://storage.test/${id}?signed=1`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    }
    return fail(404, 'NOT_FOUND', `ruta desconocida ${method} ${path}`);
  }

  bootstrap(): Bootstrap {
    return {
      app: this.app,
      cursor: this.cursor,
      serverTime: new Date(this.clock).toISOString(),
      release: 'test',
      membership: { role: this.role, scopes: null, revision: 1 },
      profile: { userId: this.userId, displayName: 'Prueba', kind: 'human' },
      tables: this.tables.map((table) => ({ table, writableColumns: ['name', 'notes', 'tax_id', 'attachment_sha'], readable: true, writable: this.role !== 'reader' })),
    };
  }

  private snapshot(params: URLSearchParams): Response {
    const tables = (params.get('tables') ?? '').split(',').filter(Boolean) as TableName[];
    const includeDeleted = params.get('includeDeleted') === '1';
    const limit = Number(params.get('limit') ?? 500);
    const offset = Number(params.get('offset') ?? 0);
    const result = tables.map((table) => {
      const all = this.rowsOf(table).filter((r) => includeDeleted || r.deleted_at === null);
      return { table, rows: all.slice(offset, offset + limit), total: all.length };
    });
    return json(200, { cursor: this.cursor, tables: result });
  }

  private changesPage(params: URLSearchParams): Response {
    const after = Number(params.get('after') ?? 0);
    const limit = Number(params.get('limit') ?? 500);
    const pending = this.changes.filter((c) => c.cursor > after);
    const items = pending.slice(0, limit);
    const last = items[items.length - 1];
    return json(200, { items, cursor: last ? last.cursor : after, latest: this.cursor, hasMore: pending.length > items.length });
  }

  private async commands(batch: CommandBatch): Promise<Response> {
    if (this.commandsDown) throw new TypeError('Failed to fetch');
    if (this.role === 'reader') return fail(403, 'FORBIDDEN', 'El rol reader no puede escribir');
    const digest = JSON.stringify(batch.operations);
    const receipt = this.receipts.get(batch.requestId);
    if (receipt) {
      if (receipt.digest !== digest) return fail(409, 'IDEMPOTENCY_REUSE', 'requestId reutilizado con otro contenido');
      return json(200, { ...receipt.result, replayed: true });
    }
    if (batch.expectedCursor !== undefined && batch.expectedCursor !== null && batch.expectedCursor !== this.cursor) {
      return fail(409, 'CURSOR_CONFLICT', 'cursor desactualizado', { expected: batch.expectedCursor, current: this.cursor });
    }
    for (const sha of batch.blobs ?? []) {
      const found = Array.from(this.uploads.values()).find((u) => u.sha256 === sha && u.verified);
      if (!found) return fail(422, 'INVALID_OPERATION', `adjunto ${sha} no verificado`);
    }

    const staging = new Map(this.rows);
    const changes: ChangeRecord[] = [];
    const results: CommandResult['results'] = [];
    const nextCursor = this.cursor + 1;
    try {
      batch.operations.forEach((op, seq) => {
        const change = this.applyOperation(staging, op, nextCursor, seq, batch.requestId);
        changes.push(change);
        results.push({ op: op.op, table: change.table, id: change.id, revision: change.revision ?? undefined });
      });
    } catch (error) {
      if (error instanceof CommitError) return fail(error.status, error.code, error.message, error.details);
      throw error;
    }
    this.rows = staging;
    this.cursor = nextCursor;
    this.changes.push(...changes);
    this.commandCount += 1;
    const result: CommandResult = { cursor: nextCursor, requestId: batch.requestId, results, changes };
    this.receipts.set(batch.requestId, { digest, result });
    if (this.dropNextCommandResponse) {
      this.dropNextCommandResponse = false;
      throw new TypeError('Failed to fetch');
    }
    return json(200, result);
  }

  private applyOperation(staging: Map<string, SyncedRow>, op: RowOperation, cursor: number, seq: number, requestId: string): ChangeRecord {
    if (op.op === 'call') throw new CommitError(422, 'INVALID_OPERATION', { procedure: op.procedure });
    const key = this.key(op.table, op.id);
    const at = this.tick();
    const current = staging.get(key);
    let next: SyncedRow;
    if (op.op === 'insert') {
      if (current) throw new CommitError(409, 'VERSION_CONFLICT', { table: op.table, id: op.id, expectedRevision: 0, currentRevision: current.revision, current });
      next = { id: op.id, revision: 1, created_at: at, updated_at: at, updated_by: this.userId, deleted_at: null, ...op.fields };
    } else {
      if (!current) throw new CommitError(404, 'NOT_FOUND', { table: op.table, id: op.id });
      if (current.revision !== op.expectedRevision) {
        throw new CommitError(409, 'VERSION_CONFLICT', {
          table: op.table,
          id: op.id,
          expectedRevision: op.expectedRevision,
          currentRevision: current.revision,
          current,
        });
      }
      if (op.op !== 'restore' && current.deleted_at !== null) {
        throw new CommitError(409, 'ROW_DELETED', { table: op.table, id: op.id, currentRevision: current.revision, current });
      }
      if (op.op === 'update') next = { ...current, ...op.fields, revision: current.revision + 1, updated_at: at, updated_by: this.userId };
      else if (op.op === 'delete') next = { ...current, revision: current.revision + 1, updated_at: at, updated_by: this.userId, deleted_at: at };
      else next = { ...current, revision: current.revision + 1, updated_at: at, updated_by: this.userId, deleted_at: null };
    }
    staging.set(key, next);
    return { cursor, seq, at, actorId: this.userId, requestId, table: op.table, id: op.id, op: op.op, revision: next.revision, after: next };
  }

  private createUpload(body: Record<string, unknown>): Response {
    const id = `upl-${this.uploads.size + 1}`;
    this.uploads.set(id, {
      id,
      filename: String(body.filename ?? ''),
      mime: String(body.mime ?? ''),
      size: Number(body.size ?? 0),
      sha256: String(body.sha256 ?? ''),
      bytes: null,
      verified: false,
    });
    return json(200, {
      id,
      uploadUrl: `https://storage.test/${id}`,
      method: 'PUT',
      headers: { 'x-upsert': 'true', 'x-ikisai-upload': id },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  private async handleStoragePut(url: URL, method: string, headers: Headers, body: BodyInit | null): Promise<Response> {
    this.calls.push({ method, path: `storage:${url.pathname}` });
    const id = url.pathname.slice(1);
    const upload = this.uploads.get(id);
    if (method !== 'PUT' || !upload) return fail(404, 'NOT_FOUND', 'ticket desconocido');
    if (headers.get('x-ikisai-upload') !== id) return fail(403, 'FORBIDDEN', 'faltan las cabeceras firmadas');
    let bytes: Uint8Array;
    if (body instanceof Blob) bytes = new Uint8Array(await body.arrayBuffer());
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    else if (typeof body === 'string') bytes = new TextEncoder().encode(body);
    else return fail(400, 'BAD_REQUEST', 'cuerpo no soportado');
    upload.bytes = bytes;
    return new Response(null, { status: 200 });
  }

  private async verifyUpload(id: string): Promise<Response> {
    const upload = this.uploads.get(id);
    if (!upload || !upload.bytes) return fail(404, 'NOT_FOUND', 'nada subido');
    if (this.failVerify) return fail(409, 'UPLOAD_MISMATCH', 'hash no coincide (simulado)');
    const sha = await sha256Hex(upload.bytes);
    if (sha !== upload.sha256 || upload.bytes.byteLength !== upload.size) return fail(409, 'UPLOAD_MISMATCH', 'hash o tamaño no coinciden');
    upload.verified = true;
    return json(200, { id, sha256: sha, size: upload.size, verified: true });
  }
}
