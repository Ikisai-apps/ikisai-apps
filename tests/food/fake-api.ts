/**
 * API falsa de Food en memoria con el contrato que espera @ikisai/sync-client (docs/core/CONTRATO_SINCRONIZACION.md §4-§5):
 * login/refresh/logout, bootstrap, snapshot, changes, commands con revisiones, recibos idempotentes y conflictos 409,
 * más subidas (ticket, PUT, verify) y lectura de archivos para las fotos de receta.
 * Adaptada de tests/invoices/fake-api.ts. Solo para pruebas de extremo a extremo del frontend; las reglas reales de
 * Food se prueban contra PGlite en los *.test.ts de esta carpeta.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

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

export interface FakeApiOptions {
  users?: Array<{ email: string; password: string; displayName?: string }>;
  tables?: Record<string, string[]>;
}

export interface FakeFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  verified: boolean;
  bytes: Buffer | null;
}

export interface FakeApi {
  url: string;
  /** Archivos subidos por el cliente (fotos de receta). */
  files(): FakeFile[];
  cursor(): number;
  rows(table: string): FakeRow[];
  /** Simula una edición de otra persona directamente en el servidor (para provocar conflictos). */
  serverUpdate(table: string, id: string, fields: Record<string, unknown>): FakeRow;
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) {
    super(message);
  }
}

const DEFAULT_TABLES: Record<string, string[]> = {
  'food.recipes': ['name', 'public_name', 'public_description', 'category', 'base_servings', 'method', 'conservation', 'freezable', 'regeneration',
    'service_notes', 'prep_minutes', 'status', 'diet_tags', 'allergens', 'allergens_checked', 'photo_file_id', 'photo_thumb_file_id'],
  'food.ingredients': ['name', 'preferred_unit', 'preferred_supplier', 'active'],
  'food.recipe_ingredients': ['recipe_id', 'ingredient_id', 'quantity', 'unit', 'position', 'notes'],
  'food.equipment': ['name', 'category', 'quantity', 'capacity', 'location', 'status', 'notes'],
  'food.recipe_equipment': ['recipe_id', 'equipment_id', 'quantity_required', 'notes'],
  'food.menus': [], 'food.menu_services': [], 'food.menu_items': [], 'food.shopping_lists': [], 'food.shopping_list_items': [], 'food.preparation_items': [],
};

/** Valores por defecto de las columnas, como los pondría PostgreSQL. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  'food.recipes': { status: 'en_prueba', freezable: false, diet_tags: [], allergens: [], allergens_checked: false },
  'food.ingredients': { preferred_unit: 'g', active: true },
  'food.recipe_ingredients': { position: 0 },
  'food.equipment': { quantity: 1, status: 'operativo' },
  'food.recipe_equipment': { quantity_required: 1 },
};
const FILE_FIELDS = ['photo_file_id', 'photo_thumb_file_id'];

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const users = options.users ?? [{ email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' }];
  const tables = options.tables ?? DEFAULT_TABLES;
  const data = new Map<string, Map<string, FakeRow>>(Object.keys(tables).map((t) => [t, new Map()]));
  const changes: FakeChange[] = [];
  const receipts = new Map<string, { digest: string; result: unknown }>();
  const sessions = new Map<string, { userId: string; email: string; displayName: string; refreshToken: string }>();
  const requests: Array<{ method: string; path: string }> = [];
  const files = new Map<string, FakeFile>();
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

  async function readBytes(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  function issueTokens(email: string) {
    const token = `tok-${randomUUID()}`;
    const refreshToken = `ref-${randomUUID()}`;
    const user = users.find((u) => u.email === email)!;
    sessions.set(token, { userId: userIds.get(email)!, email, displayName: user.displayName ?? email, refreshToken });
    return { token, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 };
  }

  function authenticate(req: IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session) throw new Fault(401, 'UNAUTHENTICATED', 'Inicia sesión.');
    return session;
  }

  function bootstrap(session: { userId: string; displayName: string }) {
    return {
      app: 'food',
      cursor,
      serverTime: nowIso(),
      release: 'test',
      membership: { role: 'owner', scopes: null, revision: 1 },
      profile: { userId: session.userId, displayName: session.displayName, kind: 'human' },
      tables: Object.entries(tables).map(([table, writableColumns]) => ({ table, writableColumns, readable: true, writable: true })),
    };
  }

  function record(table: string, op: string, row: FakeRow, nextCursor: number, seq: number, requestId: string, actorId: string): FakeChange {
    return { cursor: nextCursor, seq, at: nowIso(), actorId, requestId, table, id: row.id, op, revision: row.revision, after: { ...row } };
  }

  function commit(body: any, actorId: string) {
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
    (body.operations as FakeOperation[]).forEach((op, index) => {
      if (op.op === 'call') throw new Fault(422, 'INVALID_OPERATION', 'Procedimiento no permitido.', { index });
      if (!op.table || !tables[op.table]) throw new Fault(422, 'INVALID_OPERATION', 'Tabla inválida.', { index });
      if (!op.id) throw new Fault(422, 'INVALID_OPERATION', 'El id debe ser un uuid.', { index });
      const store = stagedTable(op.table);
      const allowed = tables[op.table]!;
      const fields = op.fields ?? {};
      for (const key of Object.keys(fields)) if (!allowed.includes(key)) throw new Fault(422, 'INVALID_FIELDS', `Campo no permitido: ${key}`, { index, field: key });
      // Al servidor nunca llega un marcador de blob: sync-client lo sustituye por el file_id de un archivo ya verificado.
      for (const key of FILE_FIELDS) {
        const value = fields[key];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'string' || !files.get(value)?.verified) throw new Fault(422, 'INVALID_FILE', 'La foto no es un archivo verificado.', { index, field: key });
      }
      const now = nowIso();
      let row = store.get(op.id);
      if (op.op === 'insert') {
        if (row) throw new Fault(422, 'INVALID_OPERATION', 'La fila ya existe.', { index });
        if (allowed.includes('name') && (typeof fields.name !== 'string' || !fields.name.trim())) throw new Fault(422, 'INVALID_FIELDS', 'El nombre es obligatorio.', { field: 'name' });
        row = { id: op.id, revision: 1, created_at: now, updated_at: now, updated_by: actorId, deleted_at: null };
        for (const column of allowed) row[column] = fields[column] ?? DEFAULTS[op.table]?.[column] ?? null;
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
      batchChanges.push(record(op.table, op.op, row, nextCursor, index + 1, body.requestId, actorId));
    });
    for (const [table, store] of staged) data.set(table, store);
    cursor = nextCursor;
    changes.push(...batchChanges);
    const result = { cursor, requestId: body.requestId, results, changes: batchChanges };
    receipts.set(`${actorId}:${body.requestId}`, { digest, result });
    return result;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname + url.search });
    try {
      if (!url.pathname.startsWith('/api/v1/')) throw new Fault(404, 'NOT_FOUND', 'Ruta desconocida.');
      const path = url.pathname.slice('/api/v1/'.length);
      if (path === 'health') return json(res, 200, { status: 'ok', app: 'food', stage: 'test', release: 'test' });
      // «Bucket»: el PUT de subida y la lectura con URL firmada van sin cabecera de sesión, como en Storage.
      if (path.startsWith('__storage/')) {
        const file = files.get(path.slice('__storage/'.length));
        if (!file) throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        if (method === 'PUT') {
          file.bytes = await readBytes(req);
          return json(res, 200, { Key: file.id });
        }
        if (!file.bytes) throw new Fault(404, 'FILE_NOT_FOUND', 'El archivo no se ha subido todavía.');
        res.writeHead(200, { 'Content-Type': file.mime, 'Content-Length': String(file.bytes.byteLength), 'Cache-Control': 'no-store' });
        res.end(file.bytes);
        return;
      }
      if (path === 'auth/login' && method === 'POST') {
        const body = await readJson(req);
        const email = String(body.username ?? body.email ?? '').trim().toLowerCase();
        const user = users.find((u) => u.email === email && u.password === body.password);
        if (!user) throw new Fault(401, 'LOGIN_FAILED', 'Correo o contraseña incorrectos.');
        return json(res, 200, issueTokens(user.email));
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
      if (path === 'uploads' && method === 'POST') {
        const body = await readJson(req);
        if (!['image/webp', 'image/jpeg'].includes(body.mime)) throw new Fault(422, 'UNSUPPORTED_MEDIA', 'Tipo de archivo no admitido.');
        if (body.size > 2 * 1024 * 1024) throw new Fault(413, 'PAYLOAD_TOO_LARGE', 'El archivo supera el tamaño máximo.');
        const id = randomUUID();
        files.set(id, { id, filename: body.filename, mime: body.mime, size: body.size, sha256: body.sha256, verified: false, bytes: null });
        return json(res, 200, { id, path: `food/test/${id}/${body.filename}`, uploadUrl: `/api/v1/__storage/${id}`, method: 'PUT', headers: { 'Content-Type': body.mime }, expiresAt: nowIso(), duplicateOf: null });
      }
      const verify = path.match(/^uploads\/([^/]+)\/verify$/);
      if (verify && method === 'POST') {
        const file = files.get(verify[1]!);
        if (!file?.bytes) throw new Fault(404, 'FILE_NOT_FOUND', 'El archivo no se ha subido todavía.');
        if (file.bytes.byteLength !== file.size) throw new Fault(422, 'FILE_MISMATCH', 'El archivo subido no coincide con lo declarado.');
        file.verified = true;
        return json(res, 200, { id: file.id, sha256: file.sha256, size: file.size, verified: true, hashVerified: true });
      }
      if (path.startsWith('files/') && method === 'GET') {
        const file = files.get(path.slice('files/'.length));
        if (!file?.verified) throw new Fault(404, 'FILE_NOT_FOUND', 'Archivo no encontrado.');
        return json(res, 200, { id: file.id, url: `/api/v1/__storage/${file.id}`, expiresAt: nowIso(), filename: file.filename, mime: file.mime, size: file.size });
      }
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
      if (path === 'commands' && method === 'POST') return json(res, 200, commit(await readJson(req), session.userId));
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
    files: () => Array.from(files.values()),
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
