/**
 * API falsa en memoria con el contrato que espera @ikisai/sync-client (docs/core/CONTRATO_SINCRONIZACION.md §4-§5):
 * login/refresh/logout, bootstrap, snapshot, changes, commands con revisiones, recibos idempotentes y conflictos 409.
 * Solo para pruebas de extremo a extremo del frontend; no sustituye a la suite de conformidad de packages/test-kit.
 */
import { FIELDS } from '../../supabase/functions/_domain/booking/mod.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

/** Valores por defecto de las columnas, los mismos que ponen las migraciones `*_booking_*` al insertar. */
const COLUMN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'booking.reservations': {
    event_type: 'retiro', status: 'en_estudio', priority: 'media', minors_count: 0, uses_accommodation: true, requires_meals: false,
    uses_interpretation_center: false, uses_outdoors: false, uses_pool: false, special_setup: false, technical_support: false, briefing_received: false,
  },
  'booking.events': {
    reinforced_cleaning: false, extra_support: false, preparation_status: 'pendiente', accommodation_status: 'pendiente', kitchen_status: 'pendiente',
    cleaning_status: 'pendiente', traveler_registration_status: 'pendiente',
  },
  'booking.guests': { is_minor: false, data_status: 'pendiente_datos', ses_status: 'pendiente_envio' },
  'booking.dietary_restrictions': { active: true },
  'booking.checklist_items': { status: 'pendiente', position: 0 },
  'booking.spaces': { accessible: false, active: true, bookable: true, position: 0 },
  'booking.beds': { capacity: 1, active: true, position: 0 },
  'booking.room_assignments': { persons: 1 },
  'booking.staff_assignments': { status: 'prevista', position: 0 },
  'booking.staff_needs': { persons: 1, priority: 'media', status: 'detectado' },
};

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

/** Respuesta de `GET /calendar/status` (docs/booking/API.md §9.3). */
export interface FakeCalendarStatus {
  configured: boolean;
  calendarId: string | null;
  health: 'ok' | 'not_configured' | 'auth_error' | 'calendar_not_found' | 'calendar_not_shared';
  items: Array<{
    reservationId: string;
    syncStatus: 'pending' | 'synced' | 'error' | 'deleted';
    lastSyncedAt: string | null;
    lastError: string | null;
    htmlLink: string | null;
    pendingJob: boolean;
    attempts: number;
    nextAttemptAt: string | null;
  }>;
}

/** Fila de `invoices.booking_cost_projection` (docs de Invoices). */
export interface FakeCostRow {
  allocation_id: string;
  target_kind: 'reservation' | 'event';
  target_id: string;
  invoice_code: string;
  invoice_date: string;
  supplier_name: string;
  expense_category: string;
  is_investment: boolean;
  allocated_amount: number | string;
  allocation_revision: number;
}

export interface FakeApi {
  url: string;
  /** Fija las filas de `GET /read/invoices.booking_cost_projection` (se filtran por `where[target_id]`). */
  setCostRows(rows: FakeCostRow[]): void;
  /** Hace que esa lectura responda con el estado HTTP indicado (`null` la restablece). */
  failCosts(status: number | null): void;
  /** Fija lo que devolverá `GET /calendar/status`. */
  setCalendarStatus(status: FakeCalendarStatus): void;
  /** Identificadores de reserva para los que llegó `POST /calendar/:id/retry`. */
  calendarRetries(): string[];
  cursor(): number;
  rows(table: string): FakeRow[];
  /** Adjuntos recibidos (tickets y si llegó el contenido). */
  uploads(): Array<{ id: string; filename: string; mime: string; sha256: string; size: number | null }>;
  /** Listas de tablas recibidas en cada `trash/purge`, en orden. */
  purgeRequests(): string[][];
  /** Cambios aplicados con su lote (`requestId`): sirve para comprobar qué filas llegaron en el mismo `commit`. */
  changeLog(): Array<{ requestId: string | null; table: string; id: string; op: string }>;
  /** Hace que el siguiente `POST /commands` falle con ese código y estado (la API falsa no aplica los invariantes del servidor). */
  failNextCommit(code: string, status: number): void;
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

/** Columnas escribibles de cada tabla, tomadas del dominio (las mismas que valida la Edge). */
const DEFAULT_TABLES: Record<string, string[]> = Object.fromEntries(Object.entries(FIELDS).map(([table, specs]) => [table, Object.keys(specs)]));

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const users = options.users ?? [{ email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' }];
  const tables = options.tables ?? DEFAULT_TABLES;
  const data = new Map<string, Map<string, FakeRow>>(Object.keys(tables).map((t) => [t, new Map()]));
  const changes: FakeChange[] = [];
  const receipts = new Map<string, { digest: string; result: unknown }>();
  const sessions = new Map<string, { userId: string; email: string; displayName: string; refreshToken: string }>();
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
      app: 'booking',
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
      if (op.op === 'call') {
        // Versión mínima de booking.confirm_reservation: estado confirmado y evento operativo, una sola vez.
        const call = op as unknown as { procedure?: string; args?: Record<string, string> };
        if (call.procedure !== 'booking.confirm_reservation') throw new Fault(422, 'INVALID_OPERATION', 'Procedimiento no permitido.', { index });
        const reservations = stagedTable('booking.reservations');
        const events = stagedTable('booking.events');
        const reservation = reservations.get(call.args?.reservation_id ?? '');
        if (!reservation) throw new Fault(404, 'NOT_FOUND', 'La reserva no existe.');
        if (reservation.status !== call.args?.from_status && reservation.status !== 'confirmada') throw new Fault(409, 'STATUS_CHANGED', 'El estado ha cambiado.', { currentStatus: reservation.status });
        const stamp = nowIso();
        let event = Array.from(events.values()).find((e) => e.reservation_id === reservation.id);
        const created = !event;
        if (!event) {
          event = { id: call.args!.event_id!, revision: 1, created_at: stamp, updated_at: stamp, updated_by: actorId, deleted_at: null };
          for (const column of tables['booking.events']!) event[column] = null;
          Object.assign(event, { reservation_id: reservation.id, code: `EVT_TEST_${String(events.size + 1).padStart(3, '0')}`, preparation_status: 'pendiente', accommodation_status: 'pendiente', kitchen_status: 'pendiente', cleaning_status: 'pendiente', traveler_registration_status: 'pendiente' });
          events.set(event.id, event);
          batchChanges.push(record('booking.events', 'insert', event, nextCursor, batchChanges.length + 1, body.requestId, actorId));
        }
        if (reservation.status !== 'confirmada') {
          Object.assign(reservation, { status: 'confirmada', revision: reservation.revision + 1, updated_at: stamp, updated_by: actorId });
          batchChanges.push(record('booking.reservations', 'update', reservation, nextCursor, batchChanges.length + 1, body.requestId, actorId));
        }
        results.push({ op: 'call', procedure: call.procedure, result: { reservation_id: reservation.id, event_id: event.id, event_code: event.code, created, status: 'confirmada' } });
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
      if (op.op === 'insert') {
        if (row) throw new Fault(422, 'INVALID_OPERATION', 'La fila ya existe.', { index });
        if (op.table === 'booking.reservations' && (typeof fields.title !== 'string' || !fields.title.trim())) throw new Fault(422, 'INVALID_FIELDS', 'El nombre del proveedor es obligatorio.', { field: 'name' });
        row = { id: op.id, revision: 1, created_at: now, updated_at: now, updated_by: actorId, deleted_at: null };
        for (const column of allowed) row[column] = fields[column] ?? COLUMN_DEFAULTS[op.table]?.[column] ?? null;
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
    });
    for (const [table, store] of staged) data.set(table, store);
    cursor = nextCursor;
    changes.push(...batchChanges);
    const result = { cursor, requestId: body.requestId, results, changes: batchChanges };
    receipts.set(`${actorId}:${body.requestId}`, { digest, result });
    return result;
  }

  let calendarStatus: FakeCalendarStatus = { configured: false, calendarId: null, health: 'not_configured', items: [] };
  const calendarRetries: string[] = [];
  let costRows: FakeCostRow[] = [];
  let costFailure: number | null = null;
  const uploads = new Map<string, { filename: string; mime: string; sha256: string; size: number | null }>();
  const purgeRequests: string[][] = [];
  let nextCommitFailure: { code: string; status: number } | null = null;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://fake.local');
    const method = req.method ?? 'GET';
    requests.push({ method, path: url.pathname + url.search });
    try {
      if (!url.pathname.startsWith('/api/v1/')) throw new Fault(404, 'NOT_FOUND', 'Ruta desconocida.');
      const path = url.pathname.slice('/api/v1/'.length);
      if (path === 'health') return json(res, 200, { status: 'ok', app: 'booking', stage: 'test', release: 'test' });
      const stored = /^_storage\/([0-9a-f-]+)$/.exec(path);
      if (stored && method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const upload = uploads.get(stored[1]!);
        if (!upload) throw new Fault(404, 'NOT_FOUND', 'Ticket desconocido.');
        upload.size = Buffer.concat(chunks).byteLength;
        return json(res, 200, { Key: stored[1] });
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
      if (path === 'dashboard') return json(res, 200, { app: 'booking', cursor, pending: [], message: 'Panel pendiente de la fase 1.' });
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
      if (path === 'read/invoices.booking_cost_projection' && method === 'GET') {
        if (costFailure !== null) throw new Fault(costFailure, costFailure === 403 ? 'FORBIDDEN' : 'VALIDATION', 'Lectura no permitida.', {});
        const target = url.searchParams.get('where[target_id]');
        const rows = costRows.filter((row) => target === null || row.target_id === target);
        return json(res, 200, { rows, total: rows.length });
      }
      if (path === 'calendar/status' && method === 'GET') return json(res, 200, calendarStatus);
      const retry = /^calendar\/([0-9a-f-]+)\/retry$/.exec(path);
      if (retry && method === 'POST') {
        calendarRetries.push(retry[1]!);
        return json(res, 200, { ok: true });
      }
      if (path === 'commands' && method === 'POST') {
        const body = await readJson(req);
        if (nextCommitFailure) {
          const { code, status } = nextCommitFailure;
          nextCommitFailure = null;
          throw new Fault(status, code, 'Rechazado por la API falsa.', {});
        }
        return json(res, 200, commit(body, session.userId));
      }
      if (path === 'trash/purge' && method === 'POST') {
        // Borrado definitivo de lo que está en la papelera, tabla a tabla y en el orden pedido (el usuario de la API falsa es propietario).
        const body = await readJson(req);
        const requested: string[] = Array.isArray(body.tables) ? body.tables : Object.keys(tables);
        purgeRequests.push(requested);
        let purged = 0;
        const next = cursor + 1;
        for (const table of requested) {
          const store = data.get(table);
          if (!store) throw new Fault(422, 'INVALID_OPERATION', 'Tabla inválida.');
          for (const row of Array.from(store.values())) {
            if (!row.deleted_at) continue;
            store.delete(row.id);
            changes.push({ ...record(table, 'purge', row, next, ++purged, String(body.requestId), session.userId), after: null } as unknown as FakeChange);
          }
        }
        if (purged > 0) cursor = next;
        return json(res, 200, { purged, cursor });
      }
      if (path === 'uploads' && method === 'POST') {
        const body = await readJson(req);
        const id = randomUUID();
        uploads.set(id, { filename: String(body.filename), mime: String(body.mime), sha256: String(body.sha256), size: null });
        return json(res, 200, { id, path: `booking/test/${id}`, uploadUrl: `/api/v1/_storage/${id}`, method: 'PUT', headers: {}, expiresAt: new Date(Date.now() + 600_000).toISOString(), duplicateOf: null });
      }
      const verify = /^uploads\/([0-9a-f-]+)\/verify$/.exec(path);
      if (verify && method === 'POST') {
        const upload = uploads.get(verify[1]!);
        if (!upload || upload.size === null) throw new Fault(404, 'FILE_NOT_FOUND', 'El archivo no se ha subido.');
        return json(res, 200, { id: verify[1], sha256: upload.sha256, size: upload.size, verified: true, hashVerified: true });
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
    setCalendarStatus: (status) => { calendarStatus = status; },
    setCostRows: (rows) => { costRows = rows; },
    failCosts: (status) => { costFailure = status; },
    calendarRetries: () => [...calendarRetries],
    rows: (table) => Array.from(data.get(table)?.values() ?? []),
    uploads: () => Array.from(uploads.entries()).map(([id, upload]) => ({ id, ...upload })),
    purgeRequests: () => purgeRequests,
    changeLog: () => changes.map((c) => ({ requestId: c.requestId, table: c.table, id: c.id, op: c.op })),
    failNextCommit(code, status) { nextCommitFailure = { code, status }; },
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
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
