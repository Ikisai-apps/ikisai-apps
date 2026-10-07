/**
 * API falsa en memoria con el contrato que espera @ikisai/sync-client (docs/core/CONTRATO_SINCRONIZACION.md §4-§5):
 * login/refresh/logout, bootstrap, snapshot, changes, commands con revisiones, recibos idempotentes y conflictos 409.
 * Solo para pruebas de extremo a extremo del frontend; no sustituye a la suite de conformidad de packages/test-kit.
 */
import { FIELDS, guestMissing, proposalTotals, round2, signsOwnEntry } from '../../supabase/functions/_domain/booking/mod.ts';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';

/** Valores por defecto de las columnas, los mismos que ponen las migraciones `*_booking_*` al insertar. */
const COLUMN_DEFAULTS: Record<string, Record<string, unknown>> = {
  'booking.reservations': {
    event_type: 'retiro', status: 'en_estudio', priority: 'media', minors_count: 0, uses_accommodation: true, requires_meals: false,
    uses_interpretation_center: false, uses_outdoors: false, uses_pool: false, special_setup: false, technical_support: false, briefing_received: false,
    ses_enabled: true, collect_guest_data: true,
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
  'booking.rates': { active: true, position: 0 },
  'booking.ses_settings': { environment: 'pre', paused: false },
  'booking.conditions': { deposit_percent: 30, deposit_minimum: 0, deposit_days: 5, deposit_days_short: 2, short_notice_days: 15, prices_include_vat: true, vat_rate: 10, is_default: false, active: true },
  'booking.cancellation_tiers': { extra_costs: false, position: 0 },
  'booking.proposals': { status: 'borrador', nature: 'orientativa' },
  'booking.proposal_lines': { quantity: 1, discount_pct: 0, position: 0 },
};

/** Columnas que fija el servidor en las propuestas (no son escribibles desde el cliente). */
const PROPOSAL_SERVER_COLUMNS = ['version', 'subtotal', 'adjustments', 'vat_amount', 'total', 'deposit_amount', 'sent_at'];
/** Columnas que fija el servidor (trigger o portal) y los clientes no escriben: huéspedes y restricciones (migración 0433). */
const SERVER_COLUMNS: Record<string, Record<string, unknown>> = {
  'booking.guests': { field_sources: {}, allergies_visible_to_organizer: false, privacy_ack_at: null, privacy_ack_version: null },
  'booking.dietary_restrictions': { source: 'staff' },
  'booking.reservation_finance': { payment_registered_at: null },
};
/** PNG de 1x1 que sirve de firma en `GET /guest-signature/:id`. */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PROPOSAL_PROCEDURES = ['booking.new_proposal_version', 'booking.send_proposal', 'booking.accept_proposal'];

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

export interface FakePortalLink {
  linkId: string;
  app: string;
  userId: string;
  label: string | null;
  scope: { reservation_id: string };
  reservationId: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  extendedUntil: string | null;
  token: string;
  email: string | null;
}

export type FakeSesStatus = 'preparada' | 'enviando' | 'en_proceso' | 'aceptada' | 'rechazada' | 'anulada' | 'error';

/** Fila de `GET /ses/:reservationId` (docs/booking/API.md §17.2). */
export interface FakeSesCommunication {
  id: string;
  reservation_id: string;
  kind: 'RH' | 'PV' | 'anulacion';
  /** Solo en los partes de viajeros (`PV`): huéspedes incluidos. */
  guest_ids: string[] | null;
  status: FakeSesStatus;
  environment: string;
  cancels_id: string | null;
  lot_id: string | null;
  ses_code: string | null;
  error_code: string | null;
  error_text: string | null;
  legal_start_at: string | null;
  snapshot: { start_date: unknown; end_date: unknown; persons: unknown };
  attempts: number;
  sent_at: string | null;
  accepted_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

/** Reporte de feedback tal como lo manda el kit (`POST /feedback`), más lo que el servidor le añade. */
export interface FakeFeedbackReport {
  id: string; code: string; originApp: string; subject: string; intent: string; message: string;
  node: { id: string; path: string[] } | null; status: string; display: string; supportersCount: number; mine: boolean;
  createdAt: string; blocking: boolean; context: Record<string, unknown> | null; requestId: string;
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
  /** Rol con el que la API falsa atiende `portal-links` (con `reader` responde 403). */
  setPortalRole(role: 'owner' | 'editor' | 'reader'): void;
  /** Datos de la entidad (Central) que devuelve `GET /entity`; null = Central aún no los tiene. */
  setEntity(entity: Record<string, unknown> | null, logoUrl?: string | null): void;
  /** Enlaces de portal emitidos, con su token (la lista de la API no lo lleva). */
  portalLinks(): FakePortalLink[];
  /**
   * SES (API §17.4). Estado con que nace la próxima comunicación de `POST /ses/:id/rh` (por defecto `en_proceso`; se consume una vez).
   * Con `rechazada` o `error` se puede dar `errorText`; con `preparada`, `errorCode` (`PAUSED` o `NOT_CONFIGURED`).
   */
  setSesNext(status: FakeSesStatus, extra?: { errorText?: string; errorCode?: string }): void;
  /** Hace que el siguiente `POST /ses/...` falle con ese código y estado (p. ej. `SES_DATA` con su mensaje y `details.field`). */
  failNextSes(code: string, status: number, message: string, details?: unknown): void;
  /** Simula el tick del servidor: la comunicación pasa a `aceptada` con código y fecha. */
  sesAccept(id: string): void;
  /** Simula que SES la rechaza. */
  sesReject(id: string, errorText: string): void;
  /** Comunicaciones de SES guardadas (la más reciente primero). */
  sesComms(reservationId?: string): FakeSesCommunication[];
  /** Cambia campos de una comunicación (p. ej. `legal_start_at` de hace 13 h). */
  sesPatch(id: string, fields: Partial<FakeSesCommunication>): void;
  /** Simula una edición de otra persona directamente en el servidor (para provocar conflictos). */
  serverUpdate(table: string, id: string, fields: Record<string, unknown>): FakeRow;
  /** Reportes de «Sugerencias y QA» recibidos en `POST /feedback` (en memoria, tal como los guardó el cliente). */
  feedbackReports(): FakeFeedbackReport[];
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) {
    super(message);
  }
}

/** Columnas escribibles de cada tabla, tomadas del dominio (las mismas que valida la Edge). */
/** Columnas de la migración 0446 que el personal escribe (llegada y documento comprobado); el dominio aún no las valida. */
const EXTRA_WRITABLE: Record<string, string[]> = { 'booking.guests': ['arrived_at', 'document_checked_at', 'document_checked_by'] };
const DEFAULT_TABLES: Record<string, string[]> = Object.fromEntries(Object.entries(FIELDS).map(([table, specs]) => [table, [...Object.keys(specs), ...(EXTRA_WRITABLE[table] ?? [])]]));

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const users = options.users ?? [{ email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' }];
  const tables = options.tables ?? DEFAULT_TABLES;
  const data = new Map<string, Map<string, FakeRow>>(Object.keys(tables).map((t) => [t, new Map()]));
  const changes: FakeChange[] = [];
  // Ajuste global de SES: la migración deja una fila en `pre` y sin pausa.
  if (data.has('booking.ses_settings')) {
    const stamp = new Date().toISOString();
    data.get('booking.ses_settings')!.set(randomUUID(), { id: '', revision: 1, created_at: stamp, updated_at: stamp, updated_by: null, deleted_at: null, ...COLUMN_DEFAULTS['booking.ses_settings'] });
    for (const [key, row] of data.get('booking.ses_settings')!) row.id = key;
  }
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
      if (op.op === 'call' && PROPOSAL_PROCEDURES.includes((op as unknown as { procedure?: string }).procedure ?? '')) {
        const call = op as unknown as { procedure: string; args: Record<string, any> };
        const proposals = stagedTable('booking.proposals');
        const lineStore = stagedTable('booking.proposal_lines');
        const stamp = nowIso();
        const touch = (table: string, row: FakeRow, fields: Record<string, unknown>, kind = 'update') => {
          Object.assign(row, fields, { revision: row.revision + 1, updated_at: stamp, updated_by: actorId });
          batchChanges.push(record(table, kind, row, nextCursor, batchChanges.length + 1, body.requestId, actorId));
        };
        const create = (table: string, id: string, fields: Record<string, unknown>, extra: string[] = []) => {
          const row: FakeRow = { id, revision: 1, created_at: stamp, updated_at: stamp, updated_by: actorId, deleted_at: null };
          for (const column of [...tables[table]!, ...extra]) row[column] = fields[column] ?? COLUMN_DEFAULTS[table]?.[column] ?? null;
          stagedTable(table).set(id, row);
          batchChanges.push(record(table, 'insert', row, nextCursor, batchChanges.length + 1, body.requestId, actorId));
          return row;
        };
        const liveProposals = () => Array.from(proposals.values()).filter((x) => x.deleted_at === null);
        if (call.procedure === 'booking.new_proposal_version') {
          const reservation = stagedTable('booking.reservations').get(String(call.args.reservation_id));
          if (!reservation) throw new Fault(404, 'NOT_FOUND', 'La reserva no existe.');
          const from = call.args.from_proposal_id ? proposals.get(String(call.args.from_proposal_id)) : undefined;
          const defaults = Array.from(stagedTable('booking.conditions').values()).find((c) => c.is_default === true && c.active === true && c.deleted_at === null);
          const version = Math.max(0, ...Array.from(proposals.values()).filter((x) => x.reservation_id === reservation.id).map((x) => Number(x.version))) + 1;
          const created = create('booking.proposals', String(call.args.proposal_id), {
            reservation_id: reservation.id, version, nature: from?.nature ?? 'orientativa', conditions_id: from?.conditions_id ?? defaults?.id ?? null,
            start_date: from?.start_date ?? reservation.start_date, end_date: from?.end_date ?? reservation.end_date, persons: from?.persons ?? reservation.expected_guests,
            valid_until: from?.valid_until ?? null, includes: from?.includes ?? null, excludes: from?.excludes ?? null, notes: from?.notes ?? null,
          }, PROPOSAL_SERVER_COLUMNS);
          if (from) {
            for (const line of Array.from(lineStore.values()).filter((l) => l.proposal_id === from.id && l.deleted_at === null)) {
              create('booking.proposal_lines', randomUUID(), { ...line, proposal_id: created.id }, ['amount']);
            }
          }
          results.push({ op: 'call', procedure: call.procedure, result: { proposal_id: created.id, reservation_id: reservation.id, version, from_proposal_id: from?.id ?? null } });
          return;
        }
        const target = proposals.get(String(call.args.proposal_id));
        if (!target || target.deleted_at !== null) throw new Fault(404, 'NOT_FOUND', 'La propuesta no existe.');
        if (call.args.expectedRevision !== undefined && call.args.expectedRevision !== target.revision) {
          throw new Fault(409, 'VERSION_CONFLICT', 'La fila ha cambiado.', { table: 'booking.proposals', id: target.id, expectedRevision: call.args.expectedRevision, currentRevision: target.revision, current: { ...target } });
        }
        if (call.procedure === 'booking.send_proposal') {
          if (target.status !== 'borrador') throw new Fault(422, 'INVALID_TRANSITION', 'Transición no permitida.', { status: target.status });
          const lines = Array.from(lineStore.values()).filter((l) => l.proposal_id === target.id && l.deleted_at === null);
          if (!target.conditions_id) throw new Fault(422, 'PROPOSAL_INCOMPLETE', 'Faltan datos.', { missing: ['conditions_id'] });
          if (lines.length === 0) throw new Fault(422, 'PROPOSAL_INCOMPLETE', 'Faltan datos.', { missing: ['lines'] });
          const totals = proposalTotals(lines as any, stagedTable('booking.conditions').get(String(target.conditions_id)) as any);
          if (totals.total < 0) throw new Fault(422, 'PROPOSAL_NEGATIVE', 'El total sería negativo.');
          for (const other of liveProposals().filter((x) => x.reservation_id === target.reservation_id && x.id !== target.id && x.status === 'enviada')) touch('booking.proposals', other, { status: 'sustituida' });
          touch('booking.proposals', target, { ...totals, status: 'enviada', sent_at: stamp });
          results.push({ op: 'call', procedure: call.procedure, result: { proposal_id: target.id, status: 'enviada', ...totals } });
          return;
        }
        if (target.status !== 'enviada') throw new Fault(422, 'INVALID_TRANSITION', 'Transición no permitida.', { status: target.status });
        for (const other of liveProposals().filter((x) => x.reservation_id === target.reservation_id && x.id !== target.id && ['borrador', 'enviada', 'aceptada'].includes(String(x.status)))) touch('booking.proposals', other, { status: 'sustituida' });
        touch('booking.proposals', target, { status: 'aceptada', decided_at: stamp });
        // Único punto en que la propuesta toca los importes de la reserva.
        const financeStore = stagedTable('booking.reservation_finance');
        const finance = financeStore.get(String(target.reservation_id));
        const amounts = { final_amount: target.total, deposit_required: target.deposit_amount };
        if (finance) touch('booking.reservation_finance', finance, { ...amounts, ...(finance.budget_amount === null ? { budget_amount: target.total } : {}) });
        else create('booking.reservation_finance', String(target.reservation_id), { ...amounts, budget_amount: target.total });
        results.push({ op: 'call', procedure: call.procedure, result: { proposal_id: target.id, reservation_id: target.reservation_id, status: 'aceptada', final_amount: target.total, deposit_required: target.deposit_amount } });
        return;
      }
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
      // Reglas de bloqueo de las propuestas (migración 0420): lo enviado no se toca y unas condiciones usadas tampoco.
      const proposalsNow = () => Array.from(stagedTable('booking.proposals').values());
      const locked = (code: string) => new Fault(422, code, 'Bloqueado por el servidor.', { table: op.table, id: op.id });
      if (op.table === 'booking.proposal_lines') {
        const parentId = String(op.op === 'insert' ? fields.proposal_id : row?.proposal_id);
        if (stagedTable('booking.proposals').get(parentId)?.status !== 'borrador') throw locked('PROPOSAL_LOCKED');
      }
      if (op.table === 'booking.proposals' && row && op.op !== 'restore' && row.status !== 'borrador') {
        const onlyClose = Object.keys(fields).every((key) => ['status', 'decided_at', 'notes'].includes(key)) && (fields.status === undefined || (row.status === 'enviada' && ['rechazada', 'caducada'].includes(String(fields.status))));
        if (op.op === 'delete' || !onlyClose) throw locked('PROPOSAL_LOCKED');
      }
      const conditionsOf = op.table === 'booking.conditions' ? op.id : op.table === 'booking.cancellation_tiers' ? String(op.op === 'insert' ? fields.conditions_id : row?.conditions_id) : null;
      if (conditionsOf && proposalsNow().some((x) => x.conditions_id === conditionsOf && x.status !== 'borrador')
        && (op.table === 'booking.cancellation_tiers' || Object.keys(fields).some((key) => !['active', 'is_default'].includes(key)))) throw locked('CONDITIONS_IN_USE');
      if (op.op === 'insert') {
        if (row) throw new Fault(422, 'INVALID_OPERATION', 'La fila ya existe.', { index });
        if (op.table === 'booking.reservations' && (typeof fields.title !== 'string' || !fields.title.trim())) throw new Fault(422, 'INVALID_FIELDS', 'El nombre del proveedor es obligatorio.', { field: 'name' });
        row = { id: op.id, revision: 1, created_at: now, updated_at: now, updated_by: actorId, deleted_at: null };
        for (const column of allowed) row[column] = fields[column] ?? COLUMN_DEFAULTS[op.table]?.[column] ?? null;
        for (const [column, value] of Object.entries(SERVER_COLUMNS[op.table!] ?? {})) row[column] = structuredClone(value);
        if (op.table === 'booking.reservation_finance' && row.payment_date) row.payment_registered_at = now;
        if (op.table === 'booking.proposals') {
          for (const column of PROPOSAL_SERVER_COLUMNS) row[column] = null;
          row.version = Math.max(0, ...Array.from(store.values()).filter((x) => x.reservation_id === fields.reservation_id).map((x) => Number(x.version))) + 1;
        }
        if (op.table === 'booking.proposal_lines') row.amount = fields.unit === 'porcentaje' ? null : round2(Number(row.quantity) * Number(row.unit_amount) * (100 - Number(row.discount_pct ?? 0)) / 100);
        if (op.table === 'booking.rates') row.code = `TAR_TEST_${String(store.size + 1).padStart(3, '0')}`;
        store.set(op.id, row);
      } else {
        if (!row) throw new Fault(404, 'NOT_FOUND', 'La fila no existe.', { table: op.table, id: op.id });
        if (op.expectedRevision !== row.revision) {
          throw new Fault(409, 'VERSION_CONFLICT', 'La fila ha cambiado.', { table: op.table, id: op.id, expectedRevision: op.expectedRevision, currentRevision: row.revision, current: { ...row } });
        }
        const hadPaymentDate = row.payment_date;
        if (op.op === 'update') Object.assign(row, fields);
        // Como el trigger de la migración 0441: el servidor anota cuándo se registró el pago (momento legal del plazo de SES).
        if (op.op === 'update' && op.table === 'booking.reservation_finance') row.payment_registered_at = !row.payment_date ? null : hadPaymentDate ? row.payment_registered_at ?? null : now;
        if (op.op === 'update' && op.table === 'booking.proposal_lines') row.amount = row.unit === 'porcentaje' ? null : round2(Number(row.quantity) * Number(row.unit_amount) * (100 - Number(row.discount_pct ?? 0)) / 100);
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
    // Como `core.commit` real: la respuesta incluye también el registro de cada procedimiento (`op: 'call'`, sin id de fila
    // y con el resultado en `after`). El feed de `changes` no lo lleva. Es lo que el cliente no sabía guardar (incidencia V1).
    const callRecords = (results as Array<{ op?: string; procedure?: string; result?: unknown }>).filter((r) => r.op === 'call').map((r, i) => ({
      cursor: nextCursor, seq: batchChanges.length + i + 1, at: nowIso(), actorId, requestId: body.requestId,
      table: r.procedure, id: null, op: 'call', revision: null, after: r.result ?? null,
    }));
    const result = { cursor, requestId: body.requestId, results, changes: [...batchChanges, ...callRecords] };
    receipts.set(`${actorId}:${body.requestId}`, { digest, result });
    return result;
  }

  // SES: comunicaciones en memoria con estados guionizables.
  const sesStore = new Map<string, FakeSesCommunication>();
  let sesNext: { status: FakeSesStatus; errorText?: string; errorCode?: string } = { status: 'en_proceso' };
  let sesFailure: { code: string; status: number; message: string; details: unknown } | null = null;
  let sesSeq = 0;
  const sesPublic = ({ reservation_id: _reservationId, ...rest }: FakeSesCommunication) => rest;
  const sesList = (reservationId: string) => Array.from(sesStore.values()).filter((c) => c.reservation_id === reservationId).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const SES_LIVE = ['preparada', 'enviando', 'en_proceso', 'aceptada', 'error'];
  function sesCreate(reservationId: string, kind: 'RH' | 'PV' | 'anulacion', fields: Partial<FakeSesCommunication>): FakeSesCommunication {
    const reservation = data.get('booking.reservations')!.get(reservationId)!;
    const event = Array.from(data.get('booking.events')?.values() ?? []).find((e) => e.reservation_id === reservationId && e.deleted_at === null);
    const settings = Array.from(data.get('booking.ses_settings')?.values() ?? [])[0];
    const stamp = nowIso();
    sesSeq += 1;
    const comm: FakeSesCommunication = {
      id: randomUUID(), reservation_id: reservationId, kind, guest_ids: null, status: 'en_proceso', environment: String(settings?.environment ?? 'pre'), cancels_id: null, lot_id: null, ses_code: null,
      error_code: null, error_text: null, legal_start_at: String(data.get('booking.reservation_finance')?.get(reservationId)?.payment_registered_at ?? stamp),
      snapshot: { start_date: reservation.start_date, end_date: reservation.end_date, persons: event?.final_guests ?? reservation.expected_guests ?? null },
      attempts: 1, sent_at: stamp, accepted_at: null, cancelled_at: null,
      // Marca creciente: dos comunicaciones en el mismo milisegundo siguen ordenadas.
      created_at: new Date(Date.now() + sesSeq).toISOString(), ...fields,
    };
    sesStore.set(comm.id, comm);
    return comm;
  }
  /** `GET /ses/:id/pv`: huéspedes que han llegado y aún no están en un parte vivo, con lo que les falta (la regla de la migración 0446, con el dominio). */
  function pvSource(reservationId: string, only?: string[]): { reservation: Record<string, unknown>; guests: Array<Record<string, any> & { id: string; ready: boolean; missing: string[] }> } {
    const reservation = data.get('booking.reservations')?.get(reservationId);
    if (!reservation || reservation.deleted_at) throw new Fault(404, 'NOT_FOUND', 'La reserva no existe.');
    if (reservation.ses_enabled === false) throw new Fault(422, 'SES_DISABLED', 'SES está desactivado para esta reserva.');
    const event = Array.from(data.get('booking.events')?.values() ?? []).find((e) => e.reservation_id === reservationId && e.deleted_at === null);
    if (!event) throw new Fault(422, 'SES_NOT_CONFIRMED', 'La reserva no está confirmada.');
    const inReport = new Set(sesList(reservationId).filter((c) => c.kind === 'PV' && SES_LIVE.includes(c.status)).flatMap((c) => c.guest_ids ?? []));
    const guests = Array.from(data.get('booking.guests')?.values() ?? [])
      .filter((g) => g.event_id === event.id && g.deleted_at === null && g.arrived_at && !inReport.has(g.id) && (!only || only.includes(g.id)))
      .sort((a, b) => String(a.arrived_at).localeCompare(String(b.arrived_at)))
      .map((g) => {
        const missing = guestMissing(g as never, 'ses');
        if (!g.is_minor && !g.document_checked_at) missing.push('document_checked');
        if (signsOwnEntry(g as never, String(reservation.start_date)) && !g.signed_at) missing.push('signature');
        return { ...g, ready: missing.length === 0, missing };
      });
    return { reservation: { id: reservationId, start_date: reservation.start_date, end_date: reservation.end_date }, guests };
  }
  let calendarStatus: FakeCalendarStatus = { configured: false, calendarId: null, health: 'not_configured', items: [] };
  const calendarRetries: string[] = [];
  let costRows: FakeCostRow[] = [];
  let costFailure: number | null = null;
  const uploads = new Map<string, { filename: string; mime: string; sha256: string; size: number | null }>();
  const purgeRequests: string[][] = [];
  let nextCommitFailure: { code: string; status: number } | null = null;
  // Enlaces de portal (contrato §3.6): solo editor y owner; la lista nunca lleva el token.
  let portalRole: 'owner' | 'editor' | 'reader' = 'owner';
  let entityData: { entity: Record<string, unknown> | null; logoUrl: string | null } = { entity: null, logoUrl: null };
  const portalLinks = new Map<string, FakePortalLink>();
  const base64url = () => randomBytes(32).toString('base64url');
  const linkValidUntil = (link: FakePortalLink): string | null => {
    if (link.revokedAt) return null;
    const reservation = data.get('booking.reservations')?.get(link.reservationId);
    const end = typeof reservation?.end_date === 'string' ? Date.parse(`${reservation.end_date}T23:59:59Z`) + 3 * 86_400_000 : null;
    const extended = link.extendedUntil ? Date.parse(link.extendedUntil) : null;
    const best = Math.max(end ?? -Infinity, extended ?? -Infinity);
    return Number.isFinite(best) && best > Date.now() ? new Date(best).toISOString() : null;
  };

  // «Sugerencias y QA» (FEEDBACK.md §7): lo mínimo que usa el kit, en memoria y sin permisos finos.
  const feedbackStore = new Map<string, FakeFeedbackReport>();
  const feedbackByRequest = new Map<string, string>();
  let feedbackSeq = 0;

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
      if (path.startsWith('_sig/') && method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        return void res.end(TINY_PNG);
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
      // catálogo del lanzador (contrato §3.3): apps con acceso de la cuenta, internas y portales
      if (path === 'members') return json(res, 200, users.map((u) => ({ userId: userIds.get(u.email), role: 'owner', displayName: u.displayName ?? u.email })));
      const signature = /^guest-signature\/([0-9a-f-]+)$/.exec(path);
      if (signature && method === 'GET') {
        const guest = data.get('booking.guests')?.get(signature[1]!);
        if (!guest || guest.deleted_at || typeof guest.signature_file_id !== 'string' || !uploads.has(guest.signature_file_id)) throw new Fault(404, 'FILE_NOT_FOUND', 'No hay firma de ese huésped.');
        return json(res, 200, { url: `/api/v1/_sig/${guest.signature_file_id}`, mime: 'image/png', expiresAt: new Date(Date.now() + 300_000).toISOString() });
      }
      if (path === 'entity') return json(res, 200, entityData);
      if (path === 'apps') return json(res, 200, {
        current: 'booking',
        items: [
          { id: 'tasks', name: 'Tasks', domain: 'tasks.example.test', kind: 'internal', description: 'Tareas', role: 'editor' },
          { id: 'booking', name: 'Booking', domain: 'booking.example.test', kind: 'internal', description: 'Reservas y eventos', role: 'owner' },
          { id: 'organizers', name: 'Organizadores', domain: 'organizers.example.test', kind: 'portal', description: 'Portal de organizadores', role: 'reader' },
        ],
      });
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
      if (path === 'portal-links' || path.startsWith('portal-links/')) {
        if (portalRole === 'reader') throw new Fault(403, 'FORBIDDEN', 'Solo el personal con permiso de escritura gestiona enlaces.');
        if (path === 'portal-links' && method === 'POST') {
          const body = await readJson(req);
          const reservationId = body?.scope?.reservation_id;
          if (body?.app !== 'organizers' || typeof reservationId !== 'string' || typeof body?.person?.name !== 'string' || !body.person.name.trim()) throw new Fault(422, 'INVALID_OPERATION', 'Datos del enlace inválidos.');
          const link: FakePortalLink = {
            linkId: randomUUID(), app: 'organizers', userId: randomUUID(), label: typeof body.label === 'string' ? body.label : body.person.name.trim(), scope: { reservation_id: reservationId },
            reservationId, createdAt: nowIso(), lastUsedAt: null, revokedAt: null, extendedUntil: null, token: base64url(), email: typeof body.person.email === 'string' ? body.person.email : null,
          };
          portalLinks.set(link.linkId, link);
          return json(res, 200, { linkId: link.linkId, userId: link.userId, scope: link.scope, validUntil: linkValidUntil(link), url: `https://organizers.ikisai.com/i/${link.token}`, shownOnce: true });
        }
        if (path === 'portal-links' && method === 'GET') {
          const reservation = url.searchParams.get('reservation');
          const items = Array.from(portalLinks.values()).filter((l) => l.reservationId === reservation).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map(({ token: _token, email: _email, reservationId: _reservationId, ...rest }) => ({ ...rest, issuerApp: 'booking', validUntil: linkValidUntil({ ...rest, token: _token, email: _email, reservationId: _reservationId }) }));
          return json(res, 200, { items });
        }
        const manage = /^portal-links\/([0-9a-f-]+)\/(revoke|extend)$/.exec(path);
        if (manage && method === 'POST') {
          const link = portalLinks.get(manage[1]!);
          if (!link) throw new Fault(404, 'NOT_FOUND', 'No existe ese enlace.');
          if (manage[2] === 'revoke') link.revokedAt = link.revokedAt ?? nowIso();
          else {
            const body = await readJson(req);
            const until = Date.parse(String(body?.until));
            if (Number.isNaN(until) || until < Date.now()) throw new Fault(422, 'INVALID_OPERATION', 'La fecha debe ser futura.');
            link.extendedUntil = new Date(until).toISOString();
          }
          return json(res, 200, { linkId: link.linkId, revokedAt: link.revokedAt, validUntil: linkValidUntil(link) });
        }
      }
      const sesPath = /^ses\/([0-9a-f-]+)(?:\/(rh|pv)|\/cancel\/([0-9a-f-]+))?$/.exec(path);
      if (sesPath) {
        const reservationId = sesPath[1]!;
        if (sesPath[2] === undefined && sesPath[3] === undefined && method === 'GET') return json(res, 200, { items: sesList(reservationId).map(sesPublic) });
        if (sesPath[2] === 'pv' && method === 'GET') return json(res, 200, pvSource(reservationId));
        if (method === 'POST') {
          if (sesFailure) {
            const failure = sesFailure;
            sesFailure = null;
            throw new Fault(failure.status, failure.code, failure.message, failure.details);
          }
          const reservation = data.get('booking.reservations')?.get(reservationId);
          if (!reservation || reservation.deleted_at) throw new Fault(404, 'NOT_FOUND', 'La reserva no existe.');
          if (sesPath[2] === 'pv') {
            const body = await readJson(req);
            const source = pvSource(reservationId, Array.isArray(body.guest_ids) ? body.guest_ids.filter((id: unknown) => typeof id === 'string') : undefined);
            const ready = source.guests.filter((g) => g.ready);
            const pending = source.guests.filter((g) => !g.ready).map((g) => ({ id: g.id, missing: g.missing }));
            if (ready.length === 0) return json(res, 200, { id: null, status: 'sin_listos', pending });
            const scripted = sesNext;
            sesNext = { status: 'en_proceso' };
            const accepted = scripted.status === 'aceptada';
            const comm = sesCreate(reservationId, 'PV', { guest_ids: ready.map((g) => g.id), status: scripted.status, error_text: scripted.errorText ?? null, error_code: scripted.errorCode ?? null,
              legal_start_at: ready.map((g) => String(g.arrived_at)).sort()[0]!, snapshot: { start_date: reservation.start_date, end_date: reservation.end_date, persons: ready.length },
              accepted_at: accepted ? nowIso() : null, ses_code: accepted ? `SYN-${String(sesSeq).padStart(4, '0')}` : null });
            return json(res, 200, { id: comm.id, status: comm.status, pending });
          }
          if (sesPath[2] === 'rh') {
            if (reservation.ses_enabled === false) throw new Fault(422, 'SES_DISABLED', 'SES está desactivado para esta reserva.');
            if (!['confirmada', 'en_ejecucion', 'cerrada'].includes(String(reservation.status))) throw new Fault(422, 'SES_NOT_CONFIRMED', 'La reserva no está confirmada.');
            if (!data.get('booking.reservation_finance')?.get(reservationId)?.payment_registered_at) throw new Fault(422, 'SES_PAYMENT_REQUIRED', 'Falta el pago.');
            if (sesList(reservationId).some((c) => c.kind === 'RH' && SES_LIVE.includes(c.status))) throw new Fault(409, 'SES_ALREADY_COMMUNICATED', 'Ya hay una comunicación viva.');
            const scripted = sesNext;
            sesNext = { status: 'en_proceso' };
            const accepted = scripted.status === 'aceptada';
            const comm = sesCreate(reservationId, 'RH', { status: scripted.status, error_text: scripted.errorText ?? null, error_code: scripted.errorCode ?? null,
              accepted_at: accepted ? nowIso() : null, ses_code: accepted ? `SYN-${String(sesSeq).padStart(4, '0')}` : null });
            return json(res, 200, { id: comm.id, status: comm.status });
          }
          const target = sesStore.get(sesPath[3] ?? '');
          if (!target || target.reservation_id !== reservationId) throw new Fault(404, 'NOT_FOUND', 'La comunicación no existe.');
          if (target.status !== 'aceptada') throw new Fault(422, 'SES_NOT_CANCELLABLE', 'Solo se anulan comunicaciones aceptadas.');
          target.status = 'anulada';
          target.cancelled_at = nowIso();
          const cancellation = sesCreate(reservationId, 'anulacion', { cancels_id: target.id, status: 'aceptada', accepted_at: nowIso(), ses_code: target.ses_code });
          return json(res, 200, { id: cancellation.id, status: cancellation.status });
        }
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
      if (path === 'feedback' || path.startsWith('feedback/')) {
        const reports = Array.from(feedbackStore.values());
        if (path === 'feedback' && method === 'POST') {
          const body = await readJson(req);
          const known = feedbackByRequest.get(String(body.requestId));
          if (known) return json(res, 200, { report: feedbackStore.get(known) });
          feedbackSeq += 1;
          const report: FakeFeedbackReport = {
            id: String(body.id), code: `FB-${String(feedbackSeq).padStart(4, '0')}`, originApp: 'booking', subject: String(body.subject ?? 'application'), intent: String(body.intent ?? 'bug'),
            message: String(body.message ?? ''), node: body.node ?? null, status: 'open', display: 'open', supportersCount: 1, mine: true, createdAt: nowIso(),
            blocking: !!body.blocking, context: body.context ?? null, requestId: String(body.requestId),
          };
          feedbackStore.set(report.id, report);
          feedbackByRequest.set(report.requestId, report.id);
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
            const entry = byNode.get(r.node.id) ?? { id: r.node.id, path: r.node.path, open: 0, pendingVerify: 0, verified: 0, total: 0 };
            entry.total += 1;
            if (r.status === 'open') entry.open += 1;
            byNode.set(r.node.id, entry);
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
    setPortalRole(role) { portalRole = role; },
    setSesNext(status, extra = {}) { sesNext = { status, ...extra }; },
    failNextSes(code, status, message, details = {}) { sesFailure = { code, status, message, details }; },
    sesAccept(id) {
      const comm = sesStore.get(id);
      if (!comm) throw new Error(`comunicación ${id} no existe`);
      Object.assign(comm, { status: 'aceptada', accepted_at: nowIso(), ses_code: comm.ses_code ?? `SYN-${String(++sesSeq).padStart(4, '0')}`, error_code: null, error_text: null });
    },
    sesReject(id, errorText) {
      const comm = sesStore.get(id);
      if (!comm) throw new Error(`comunicación ${id} no existe`);
      Object.assign(comm, { status: 'rechazada', error_code: 'SES_REJECTED', error_text: errorText });
    },
    sesComms: (reservationId) => Array.from(sesStore.values()).filter((c) => !reservationId || c.reservation_id === reservationId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((c) => ({ ...c })),
    sesPatch(id, fields) {
      const comm = sesStore.get(id);
      if (!comm) throw new Error(`comunicación ${id} no existe`);
      Object.assign(comm, fields);
    },
    setEntity(entity, logoUrl = null) { entityData = { entity, logoUrl }; },
    portalLinks: () => Array.from(portalLinks.values()).map((l) => ({ ...l })),
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
    feedbackReports: () => Array.from(feedbackStore.values()).map((r) => ({ ...r })),
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
