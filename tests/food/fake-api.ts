/**
 * API falsa de Food en memoria con el contrato que espera @ikisai/sync-client (docs/core/CONTRATO_SINCRONIZACION.md §4-§5):
 * login/refresh/logout, bootstrap, snapshot, changes, commands con revisiones, recibos idempotentes y conflictos 409,
 * más subidas (ticket, PUT, verify) y lectura de archivos para las fotos de receta, los eventos de la proyección de
 * Booking y una versión mínima de los procedimientos de estado del menú.
 * Adaptada de tests/invoices/fake-api.ts. Solo para pruebas de extremo a extremo del frontend; las reglas reales de
 * Food se prueban contra PGlite en los *.test.ts de esta carpeta.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { HOUSE_MENU_ID, computeShopping, defaultPurchase, usualPackSize, fromItemBase, foodUnitFromBase, kitchenSpaceIds, kitchenStock, preparationSources, shoppingSources, unitFamily, type MenuGraph, type Unit } from '../../supabase/functions/_domain/food/mod.ts';

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
  /** `role` (por defecto `owner`) es el de la cuenta en Food: el lector solo lee (tanda 27, vista del lector). */
  users?: Array<{ email: string; password: string; displayName?: string; role?: 'owner' | 'editor' | 'reader' }>;
  tables?: Record<string, string[]>;
  /** Filas de `booking.food_event_projection` que sirve `GET events`. */
  events?: FakeEvent[];
  /** Filas de `invoices.food_stock_projection` que sirve `GET read/invoices.food_stock_projection`. */
  purchases?: Array<Record<string, unknown>>;
  /** Si la cuenta ya aceptó el aviso de medición de uso (por defecto sí, para que el aviso no tape las demás pruebas). */
  usageConsent?: boolean;
}

/** Reporte de «Sugerencias y QA» tal como lo manda el kit (`POST /feedback`), más lo que el servidor le añade. */
export interface FakeFeedbackReport {
  id: string; code: string; originApp: string; subject: string; intent: string; message: string;
  node: { id: string; path: string[] } | null; status: string; display: string; supportersCount: number; mine: boolean;
  createdAt: string; context: Record<string, unknown> | null; requestId: string;
}

/** Totales de uso recibidos en `POST /usage/batch` (el último total por día, función y contexto). */
export interface FakeUsageItem { day: string; featureId: string; context: string; exposures: number; activations: number; successes: number; errors: number }

export interface FakeEvent {
  event_id: string;
  title: string;
  start_date: string;
  end_date: string;
  event_revision: number;
  [column: string]: unknown;
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
  /** Inserta una fila directamente en el servidor, como si ya existiera antes de la prueba. */
  seed(table: string, fields: Record<string, unknown>): FakeRow;
  /** Booking cambia un evento: se aplican los campos y avanza `event_revision`. */
  updateEvent(eventId: string, fields: Record<string, unknown>): FakeEvent;
  cursor(): number;
  rows(table: string): FakeRow[];
  /** Simula una edición de otra persona directamente en el servidor (para provocar conflictos). */
  serverUpdate(table: string, id: string, fields: Record<string, unknown>): FakeRow;
  requests: Array<{ method: string; path: string }>;
  /** Reportes recibidos en `POST /feedback`. */
  feedbackReports(): FakeFeedbackReport[];
  /** Avisos de avería recibidos en `POST /equipment/:id/fault` (lo que Food reenviaría a Tasks). */
  faults(): Array<{ id: string; body: Record<string, unknown> }>;
  /** Totales de uso recibidos en `POST /usage/batch`. */
  usageItems(): FakeUsageItem[];
  /** Da por aceptado (o no) el aviso de medición de uso. */
  setUsageConsent(consented: boolean): void;
  /** Una sugerencia `plato_casa` pendiente, como la mandaría un outsider desde Guests (O3c). */
  seedSuggestion(input: { name: string; date: string; service: string; author?: string }): string;
  suggestions(): FakeSuggestion[];
  close(): Promise<void>;
}

export interface FakeSuggestion {
  id: string; app: 'food'; kind: string; label: string; summary: string; detail: Record<string, unknown> | null; operations: unknown[];
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn'; comment: string | null; author: { id: string; name: string };
  decidedBy: { id: string; name: string } | null; decidedAt: string | null; appliedCursor: number | null; result: unknown; createdAt: string; updatedAt: string;
}

class Fault extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details: unknown = null) {
    super(message);
  }
}

const DEFAULT_TABLES: Record<string, string[]> = {
  'food.recipes': ['name', 'public_name', 'public_description', 'category', 'base_servings', 'method', 'conservation', 'freezable', 'regeneration',
    'service_notes', 'prep_minutes', 'status', 'diet_tags', 'allergens', 'allergens_checked', 'photo_file_id', 'photo_thumb_file_id', 'method_steps', 'quick'],
  'food.ingredients': ['name', 'preferred_unit', 'preferred_supplier', 'active', 'item_id'],
  'food.recipe_ingredients': ['recipe_id', 'ingredient_id', 'quantity', 'unit', 'position', 'notes'],
  'food.equipment': ['name', 'category', 'quantity', 'capacity', 'location', 'status', 'notes', 'item_id', 'status_since'],
  'food.recipe_equipment': ['recipe_id', 'equipment_id', 'quantity_required', 'notes'],
  'food.menus': ['kind', 'event_id', 'source_event_revision', 'source_event_snapshot', 'status', 'validated_at', 'validated_by', 'validated_warnings',
    'preparation_generated_at', 'preparation_source_revisions', 'notes', 'closing_notes', 'organizer_shared', 'house_servings', 'name'],
  'food.menu_comments': ['menu_id', 'service_id', 'menu_item_id', 'kind', 'message', 'author_id', 'status', 'reply'],
  'food.menu_services': ['menu_id', 'service_date', 'service_type', 'service_time', 'position', 'notes'],
  'food.menu_items': ['service_id', 'recipe_id', 'servings', 'position', 'notes'],
  'food.shopping_lists': ['menu_id', 'status', 'generated_at', 'source_revisions', 'notes', 'period_start', 'period_end'],
  'food.shopping_list_items': ['shopping_list_id', 'ingredient_id', 'required_quantity', 'unit', 'stock_quantity', 'purchase_quantity', 'supplier', 'status',
    'manual_override', 'manual', 'notes', 'min_quantity', 'restock'],
  'food.preparation_items': ['menu_id', 'menu_item_id', 'recipe_id', 'scheduled_date', 'scheduled_time', 'text', 'responsible', 'done', 'position', 'manual'],
  'food.consumptions': ['menu_item_id', 'status', 'automatic', 'notes'],
  // Tanda 27: votos de los platos sugeridos (quién vota lo pone la ruta, como el trigger real) y avisos a Tasks.
  'food.suggestion_votes': ['suggestion_id', 'voter_id', 'vote'],
  'food.equipment_notices': ['equipment_id', 'notified_on', 'equipment_status', 'task_id', 'request_status'],
  // La carta (1109): líneas y ventas (estas, en la app real, solo por food.record_carta_sales).
  'food.carta_lines': ['menu_id', 'recipe_id', 'item_id', 'scope', 'code', 'name', 'description', 'sale_price_cents', 'active', 'position', 'image_key'],
  'food.carta_sales': ['menu_id', 'line_id', 'day', 'quantity'],
  // Módulo Recursos (R5), servido en /api/v1/resources/… como en las Edge reales (docs/resources/API.md §1).
  'resources.items': ['name', 'kind', 'category', 'base_unit', 'min_quantity', 'reorder_quantity', 'default_space_id', 'default_supplier_id',
    'tracks_lots', 'tracks_expiry', 'attributes', 'active', 'notes', 'source_refs'],
  'resources.item_units': ['item_id', 'unit', 'factor', 'supplier_id', 'usual', 'price'],
  'resources.lots': ['item_id', 'code', 'expires_on'],
  'resources.movements': ['item_id', 'space_id', 'lot_id', 'quantity', 'kind', 'reason', 'unit_cost', 'transfer_id', 'count_id', 'source_app', 'source_ref', 'note', 'at'],
  'resources.spaces': ['parent_id', 'kind', 'name', 'public_name', 'code', 'position', 'active', 'notes', 'attributes', 'source_refs'],
  'resources.item_kinds': ['kind', 'label', 'consumable', 'position', 'active'],
  'resources.movement_costs': ['movement_id', 'unit_cost', 'source_app', 'source_ref'],
  'resources.space_kinds': ['kind', 'label', 'level', 'parents', 'attribute_keys', 'position', 'active'],
  'resources.counts': ['space_id', 'note', 'status', 'closed_at', 'closed_by'],
  'resources.count_lines': ['count_id', 'item_id', 'space_id', 'lot_id', 'quantity', 'note'],
};

/** Valores por defecto de las columnas, como los pondría PostgreSQL. */
const DEFAULTS: Record<string, Record<string, unknown>> = {
  'food.recipes': { status: 'en_prueba', freezable: false, diet_tags: [], allergens: [], allergens_checked: false, quick: false },
  'food.ingredients': { preferred_unit: 'g', active: true },
  'food.recipe_ingredients': { position: 0 },
  'food.equipment': { quantity: 1, status: 'operativo' },
  'food.recipe_equipment': { quantity_required: 1 },
  'food.menus': { kind: 'retiro', status: 'borrador', organizer_shared: false },
  'food.menu_comments': { status: 'nuevo' },
  'food.menu_services': { position: 0 },
  'food.menu_items': { position: 0 },
  'food.shopping_lists': { status: 'borrador', source_revisions: {} },
  'food.shopping_list_items': { required_quantity: 0, status: 'pendiente', manual_override: false, manual: false, restock: false },
  'food.preparation_items': { done: false, position: 0, manual: false },
  'food.consumptions': { automatic: false },
  'food.carta_lines': { active: true, position: 0 },
  'resources.items': { tracks_lots: false, tracks_expiry: false, attributes: {}, active: true, source_refs: [] },
  'resources.spaces': { position: 0, active: true, attributes: {}, source_refs: [] },
  'resources.counts': { status: 'abierto' },
};
const MENU_TRANSITIONS = ['borrador>revisar', 'revisar>borrador', 'validado>revisar', 'validado>cerrado', 'cerrado>validado'];
const FILE_FIELDS = ['photo_file_id', 'photo_thumb_file_id'];

export async function startFakeApi(options: FakeApiOptions = {}): Promise<FakeApi> {
  const users = options.users ?? [{ email: 'owner@example.invalid', password: 'secreta-123', displayName: 'Prueba' }];
  const tables = options.tables ?? DEFAULT_TABLES;
  const data = new Map<string, Map<string, FakeRow>>(Object.keys(tables).map((t) => [t, new Map()]));
  const changes: FakeChange[] = [];
  const receipts = new Map<string, { digest: string; result: unknown }>();
  const sessions = new Map<string, { userId: string; email: string; displayName: string; refreshToken: string; role?: string }>();
  const requests: Array<{ method: string; path: string }> = [];
  const files = new Map<string, FakeFile>();
  const events: FakeEvent[] = (options.events ?? []).map((e) => ({ ...e }));
  const feedbackStore = new Map<string, FakeFeedbackReport>();
  const feedbackByRequest = new Map<string, string>();
  const usage = new Map<string, FakeUsageItem>();
  const faults: Array<{ id: string; body: Record<string, unknown> }> = [];
  const suggestionStore: FakeSuggestion[] = [];
  let consentedAt: string | null = options.usageConsent === false ? null : new Date().toISOString();
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
    sessions.set(token, { userId: userIds.get(email)!, email, displayName: user.displayName ?? email, refreshToken, role: user.role });
    return { token, refreshToken, expiresAt: Math.floor(Date.now() / 1000) + 3600, expiresIn: 3600 };
  }

  function authenticate(req: IncomingMessage) {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session) throw new Fault(401, 'UNAUTHENTICATED', 'Inicia sesión.');
    return session;
  }

  function bootstrap(session: { userId: string; displayName: string; role?: string }, scope: string) {
    return {
      app: scope,
      cursor,
      serverTime: nowIso(),
      release: 'test',
      membership: { role: session.role ?? 'owner', scopes: null, revision: 1 },
      profile: { userId: session.userId, displayName: session.displayName, kind: 'human' },
      tables: Object.entries(tables).filter(([table]) => table.startsWith(`${scope}.`)).map(([table, writableColumns]) => ({ table, writableColumns, readable: true, writable: true })),
    };
  }

  function record(table: string, op: string, row: FakeRow, nextCursor: number, seq: number, requestId: string, actorId: string): FakeChange {
    return { cursor: nextCursor, seq, at: nowIso(), actorId, requestId, table, id: row.id, op, revision: row.revision, after: { ...row } };
  }

  function commit(body: any, actorId: string, scope = 'food') {
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
        // Versión mínima de los procedimientos de estado; las reglas completas se prueban contra PGlite.
        const { procedure, args = {} } = op as unknown as { procedure: string; args?: Record<string, any> };
        if (procedure === 'resources.close_count' && scope === 'resources') {
          // Como resources.close_count (0802): un ajuste por línea con la diferencia frente a lo calculado, y cerrado.
          let seq = 0;
          const count = stagedTable('resources.counts').get(args.count_id);
          if (!count || count.status === 'cerrado') throw new Fault(422, 'COUNT_CLOSED', 'El recuento ya está cerrado.', { index });
          const moves = Array.from(stagedTable('resources.movements').values()).filter((m) => !m.deleted_at);
          for (const line of Array.from(stagedTable('resources.count_lines').values()).filter((l) => l.count_id === count.id && !l.deleted_at)) {
            const current = moves.filter((m) => m.item_id === line.item_id && m.space_id === line.space_id && (m.lot_id ?? null) === (line.lot_id ?? null)).reduce((sum, m) => sum + Number(m.quantity), 0);
            const diff = Math.round((Number(line.quantity) - current) * 1e6) / 1e6;
            if (!diff) continue;
            const row: FakeRow = { id: randomUUID(), revision: 1, created_at: nowIso(), updated_at: nowIso(), updated_by: actorId, deleted_at: null };
            for (const column of tables['resources.movements']!) row[column] = null;
            Object.assign(row, { item_id: line.item_id, space_id: line.space_id, lot_id: line.lot_id ?? null, quantity: diff, kind: 'ajuste_recuento', count_id: count.id });
            stagedTable('resources.movements').set(row.id, row);
            batchChanges.push(record('resources.movements', 'insert', row, nextCursor, index * 1000 + ++seq, body.requestId, actorId));
          }
          Object.assign(count, { status: 'cerrado', closed_at: nowIso(), closed_by: actorId });
          count.revision += 1; count.updated_at = nowIso();
          batchChanges.push(record('resources.counts', 'update', count, nextCursor, index * 1000 + ++seq, body.requestId, actorId));
          results.push({ op: 'call', procedure, result: { countId: count.id } });
          return;
        }
        if (procedure === 'resources.consume' && scope === 'resources') {
          // Como resources.consume (0803): primero lo que caduca antes; lo que falte, sin lote en el sitio por defecto.
          let seq = 0;
          const movements = Array.from(stagedTable('resources.movements').values()).filter((m) => !m.deleted_at && m.item_id === args.item_id);
          const lots = new Map(Array.from(stagedTable('resources.lots').values()).map((l) => [l.id, l]));
          const levels = new Map<string, { space_id: string; lot_id: string | null; quantity: number }>();
          for (const m of movements) {
            const key = `${m.space_id}|${m.lot_id ?? ''}`;
            const level = levels.get(key) ?? { space_id: m.space_id as string, lot_id: (m.lot_id as string | null) ?? null, quantity: 0 };
            level.quantity += Number(m.quantity);
            levels.set(key, level);
          }
          const spaces: string[] | null = Array.isArray(args.space_ids) ? args.space_ids : null;
          const order = [...levels.values()].filter((l) => l.quantity > 0 && (!spaces || spaces.includes(l.space_id)))
            .sort((a, b) => String(lots.get(a.lot_id ?? '')?.expires_on ?? '9999').localeCompare(String(lots.get(b.lot_id ?? '')?.expires_on ?? '9999')));
          if (args.once && movements.some((m) => m.source_app === args.source_app && m.source_ref === args.source_ref && String(m.kind).startsWith('consumo_'))) {
            results.push({ op: 'call', procedure, result: { itemId: args.item_id, skipped: 'already_consumed' } });
            return;
          }
          let left = Number(args.quantity);
          const take = (space: string, lot: string | null, quantity: number) => {
            const row: FakeRow = { id: randomUUID(), revision: 1, created_at: nowIso(), updated_at: nowIso(), updated_by: actorId, deleted_at: null };
            for (const column of tables['resources.movements']!) row[column] = null;
            Object.assign(row, { item_id: args.item_id, space_id: space, lot_id: lot, quantity: -quantity, kind: args.kind, source_app: args.source_app, source_ref: args.source_ref, note: args.note ?? null });
            stagedTable('resources.movements').set(row.id, row);
            batchChanges.push(record('resources.movements', 'insert', row, nextCursor, index * 1000 + ++seq, body.requestId, actorId));
          };
          for (const level of order) { if (left <= 0) break; const q = Math.min(left, level.quantity); take(level.space_id, level.lot_id, q); left = Math.round((left - q) * 1000) / 1000; }
          if (left > 0) take(args.default_space_id ?? spaces?.[0], null, left);
          results.push({ op: 'call', procedure, result: { itemId: args.item_id } });
          return;
        }
        if (procedure === 'food.house_dish_from_suggestion') {
          // Como el procedimiento SQL de O3c (probado contra PGlite): receta del mismo nombre o rápida, servicio y plato.
          let seq = 0;
          const all = (table: string) => Array.from(stagedTable(table).values()).filter((r) => !r.deleted_at);
          const insert = (table: string, fields: Record<string, unknown>, id: string = randomUUID()): FakeRow => {
            const row: FakeRow = { id, revision: 1, created_at: nowIso(), updated_at: nowIso(), updated_by: actorId, deleted_at: null };
            for (const column of tables[table]!) row[column] = fields[column] ?? DEFAULTS[table]?.[column] ?? null;
            stagedTable(table).set(row.id, row);
            batchChanges.push(record(table, 'insert', row, nextCursor, index * 1000 + ++seq, body.requestId, actorId));
            return row;
          };
          const name = String(args.name ?? '').trim();
          // Tanda 27 (1102): los días que ya pasaron en Madrid se rechazan y `recipe_id` («receta parecida») tiene que estar viva.
          const madridToday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
          if (String(args.date ?? '') < madridToday) throw new Fault(422, 'INVALID_OPERATION', 'Ese día ya pasó.', { index, procedure, argument: 'date', reason: 'past' });
          const chosen = args.recipe_id ? all('food.recipes').find((r) => r.id === args.recipe_id && r.status !== 'archivada') : undefined;
          if (args.recipe_id && !chosen) throw new Fault(422, 'INVALID_OPERATION', 'La receta no existe.', { index, procedure, argument: 'recipe_id', reason: 'not_found' });
          const menu = all('food.menus').find((m) => m.kind === 'casa') ?? insert('food.menus', { kind: 'casa' }, HOUSE_MENU_ID);
          const servings = Number(menu.house_servings ?? 0) || 1;
          const service = all('food.menu_services').filter((r) => r.menu_id === menu.id && r.service_date === args.date && r.service_type === args.service)
            .sort((a, b) => Number(a.position) - Number(b.position))[0]
            ?? insert('food.menu_services', { menu_id: menu.id, service_date: args.date, service_type: args.service, service_time: args.service === 'comida' ? '14:00' : args.service === 'cena' ? '20:30' : null,
              position: Math.max(0, ...all('food.menu_services').filter((r) => r.menu_id === menu.id && r.service_date === args.date).map((r) => Number(r.position))) + 1 });
          const recipe = chosen ?? all('food.recipes').find((r) => String(r.name).trim().toLowerCase() === name.toLowerCase() && r.status !== 'archivada')
            ?? insert('food.recipes', { name, category: 'principal', base_servings: servings, quick: true });
          const existing = all('food.menu_items').find((i) => i.service_id === service.id && i.recipe_id === recipe.id);
          const item = existing ?? insert('food.menu_items', { service_id: service.id, recipe_id: recipe.id, servings,
            position: Math.max(0, ...all('food.menu_items').filter((i) => i.service_id === service.id).map((i) => Number(i.position))) + 1 });
          results.push({ op: 'call', procedure, result: { menu_id: menu.id, service_id: service.id, recipe_id: recipe.id, item_id: item.id, created_item: !existing } });
          return;
        }
        const menu = stagedTable('food.menus').get(args.menu_id);
        if (!menu || menu.deleted_at) throw new Fault(422, 'MENU_NOT_FOUND', 'El menú no existe.', { index });
        if (procedure === 'food.regenerate_shopping' || procedure === 'food.regenerate_preparation') {
          // Mismas reglas que los procedimientos SQL (probados contra PGlite), con el cálculo del dominio.
          const all = (table: string) => Array.from(stagedTable(table).values());
          let seq = 0;
          const write = (table: string, kind: 'insert' | 'update' | 'delete', row: FakeRow, fields: Record<string, unknown> = {}) => {
            const now = nowIso();
            if (kind === 'insert') { for (const column of tables[table]!) row[column] = fields[column] ?? DEFAULTS[table]?.[column] ?? null; stagedTable(table).set(row.id, row); }
            else { Object.assign(row, fields); if (kind === 'delete') row.deleted_at = now; row.revision += 1; row.updated_at = now; row.updated_by = actorId; }
            batchChanges.push(record(table, kind, row, nextCursor, index * 1000 + ++seq, body.requestId, actorId));
          };
          const fresh = (): FakeRow => ({ id: randomUUID(), revision: 1, created_at: nowIso(), updated_at: nowIso(), updated_by: actorId, deleted_at: null });
          const graph = {
            services: all('food.menu_services').filter((r) => r.menu_id === menu.id), items: all('food.menu_items'), recipes: all('food.recipes'),
            recipe_ingredients: all('food.recipe_ingredients'), ingredients: all('food.ingredients'),
          } as unknown as MenuGraph;
          graph.items = graph.items.filter((i) => graph.services.some((sv) => sv.id === i.service_id));
          // Rango del menú de casa (O3b): obligatorio en casa y prohibido en un retiro, como food.call_period.
          const period = args.period_start ? { start: args.period_start as string, end: args.period_end as string } : null;
          if ((menu.kind === 'casa') !== !!period) throw new Fault(422, 'INVALID_PERIOD', 'Rango de días inválido.', { index, reason: menu.kind === 'casa' ? 'required' : 'not_allowed' });
          const inPeriod = (date: string | null | undefined) => !period || (!!date && date >= period.start && date <= period.end);
          const counts = { inserted: 0, updated: 0, deleted: 0, kept: 0 };

          if (procedure === 'food.regenerate_shopping') {
            let list = all('food.shopping_lists').find((l) => l.menu_id === menu.id && !l.deleted_at && (l.period_start ?? null) === (period?.start ?? null) && (l.period_end ?? null) === (period?.end ?? null));
            const overlap = period && all('food.shopping_lists').find((l) => l.menu_id === menu.id && !l.deleted_at && l.period_start && l.id !== list?.id && (l.period_start as string) <= period.end && period.start <= (l.period_end as string));
            if (overlap) throw new Fault(422, 'PERIOD_OVERLAP', 'Se solapa con otra lista.', { index, list_id: overlap.id, period_start: overlap.period_start, period_end: overlap.period_end });
            const created = !list;
            if (list?.status === 'cerrada') throw new Fault(422, 'LIST_CLOSED', 'La lista está cerrada.', { index });
            if (!list) { list = { ...fresh(), id: args.list_id }; write('food.shopping_lists', 'insert', list, { menu_id: menu.id, generated_at: nowIso(), source_revisions: shoppingSources(graph, period), period_start: period?.start ?? null, period_end: period?.end ?? null }); }
            const lines = all('food.shopping_list_items').filter((i) => i.shopping_list_id === list!.id && !i.deleted_at && !i.manual);
            const seen = new Set<string>();
            // Stock de cocina, mínimos y «Reponer» (R5b), como food.regenerate_shopping en 0198.
            const committed = (t: string) => Array.from(data.get(t)?.values() ?? []).filter((r) => !r.deleted_at);
            const kitchen = kitchenSpaceIds(committed('resources.spaces') as never);
            const on = [new Date().toISOString().slice(0, 10), period?.start ?? ''].sort().at(-1)!;
            const articleOf = (ingredientId: string) => {
              const g = graph.ingredients.find((i) => i.id === ingredientId) as unknown as FakeRow | undefined;
              return g?.item_id ? committed('resources.items').find((i) => i.id === g.item_id) : undefined;
            };
            const stockOf = (ingredientId: string, unit: Unit) => {
              const it = articleOf(ingredientId);
              const base = it ? kitchenStock(it.id, committed('resources.movements') as never, committed('resources.lots') as never, kitchen, on) : null;
              return it && base !== null ? fromItemBase(base, String(it.base_unit), unit) : null;
            };
            const minOf = (ingredientId: string, unit: Unit) => {
              const it = articleOf(ingredientId);
              return it && it.min_quantity !== null && it.min_quantity !== undefined ? fromItemBase(Number(it.min_quantity), String(it.base_unit), unit) : null;
            };
            // S5 (1108): el envase habitual redondea «Comprar» en las líneas pendientes.
            const packOf = (ingredientId: string, unit: Unit) => {
              const it = articleOf(ingredientId);
              return it ? usualPackSize(String(it.id), String(it.base_unit), unit, committed('resources.item_units') as never) : null;
            };
            const wanted = new Set<string>();
            for (const need of computeShopping(graph, period)) {
              wanted.add(need.ingredient_id);
              const stockNow = stockOf(need.ingredient_id, need.unit);
              const minNow = minOf(need.ingredient_id, need.unit);
              const line = lines.find((i) => i.ingredient_id === need.ingredient_id && unitFamily(i.unit as Unit) === need.family);
              if (!line) {
                const supplier = graph.ingredients.find((g) => g.id === need.ingredient_id)?.preferred_supplier ?? null;
                write('food.shopping_list_items', 'insert', fresh(), { shopping_list_id: list.id, ingredient_id: need.ingredient_id, required_quantity: need.required_quantity, unit: need.unit,
                  purchase_quantity: defaultPurchase(need.required_quantity, stockNow, minNow, packOf(need.ingredient_id, need.unit)), supplier, stock_quantity: stockNow, min_quantity: minNow });
                counts.inserted += 1;
                continue;
              }
              seen.add(line.id);
              const fields: Record<string, unknown> = {};
              if (line.unit !== need.unit) fields.unit = need.unit;
              if (Number(line.required_quantity) !== need.required_quantity) fields.required_quantity = need.required_quantity;
              const pending = line.status === 'pendiente';
              if (pending && stockNow !== null && Number(line.stock_quantity) !== stockNow) { fields.stock_quantity = stockNow; line.stock_quantity = stockNow; }
              if ((line.min_quantity ?? null) !== minNow) fields.min_quantity = minNow;
              if (line.restock) fields.restock = false;
              const purchase = defaultPurchase(need.required_quantity, line.stock_quantity === null ? null : Number(line.stock_quantity), minNow, packOf(need.ingredient_id, need.unit));
              if (pending && !line.manual_override && Number(line.purchase_quantity) !== purchase) fields.purchase_quantity = purchase;
              if (Object.keys(fields).length) { write('food.shopping_list_items', 'update', line, fields); counts.updated += 1; } else counts.kept += 1;
            }
            for (const g of graph.ingredients as unknown as FakeRow[]) {
              const it = articleOf(g.id);
              const unit = it ? foodUnitFromBase(String(it.base_unit)) : null;
              if (g.deleted_at || g.active === false || !it || !unit || !(Number(it.min_quantity) > 0) || wanted.has(g.id)) continue;
              const stockNow = stockOf(g.id, unit);
              const min = Number(it.min_quantity);
              if ((stockNow ?? 0) >= min) continue;
              const elsewhere = all('food.shopping_list_items').some((o) => o.ingredient_id === g.id && o.restock && !o.deleted_at && o.shopping_list_id !== list!.id
                && all('food.shopping_lists').some((l) => l.id === o.shopping_list_id && !l.deleted_at && l.status !== 'cerrada'));
              if (elsewhere) continue;
              const purchase = defaultPurchase(0, stockNow, min, packOf(g.id, unit));
              const line = lines.find((i) => i.ingredient_id === g.id && i.restock);
              if (!line) { write('food.shopping_list_items', 'insert', fresh(), { shopping_list_id: list.id, ingredient_id: g.id, required_quantity: 0, unit, purchase_quantity: purchase, supplier: g.preferred_supplier ?? null, stock_quantity: stockNow, min_quantity: min, restock: true }); counts.inserted += 1; continue; }
              seen.add(line.id);
              if (line.status === 'pendiente' && !line.manual_override && Number(line.purchase_quantity) !== purchase) { write('food.shopping_list_items', 'update', line, { purchase_quantity: purchase, stock_quantity: stockNow }); counts.updated += 1; } else counts.kept += 1;
            }
            for (const line of lines.filter((i) => !seen.has(i.id))) {
              if (line.status === 'pendiente' && !line.manual_override) { write('food.shopping_list_items', 'delete', line); counts.deleted += 1; }
              else if (Number(line.required_quantity) !== 0) { write('food.shopping_list_items', 'update', line, { required_quantity: 0 }); counts.updated += 1; }
              else counts.kept += 1;
            }
            const status = list.status === 'revisada' ? 'borrador' : list.status;
            if (!created) write('food.shopping_lists', 'update', list, { generated_at: nowIso(), source_revisions: shoppingSources(graph, period), status });
            results.push({ op: 'call', procedure, result: { list_id: list.id, created, ...counts, status } });
            return;
          }

          const steps = all('food.preparation_items').filter((p) => p.menu_id === menu.id && !p.deleted_at);
          const live = graph.items.filter((i) => !i.deleted_at && graph.services.some((sv) => sv.id === i.service_id && !sv.deleted_at && inPeriod(sv.service_date)));
          for (const item of live) {
            const service = graph.services.find((sv) => sv.id === item.service_id)!;
            const recipe = graph.recipes.find((r) => r.id === item.recipe_id)!;
            let date: string = service.service_date; let time: string | null = null;
            if (service.service_time) {
              const at = new Date(`${service.service_date}T${service.service_time.slice(0, 5)}:00Z`).getTime() - (recipe.prep_minutes ?? 120) * 60000;
              date = new Date(at).toISOString().slice(0, 10); time = new Date(at).toISOString().slice(11, 19);
            }
            const text = `Preparar ${recipe.name}`;
            const step = steps.find((p) => p.menu_item_id === item.id);
            if (!step) {
              const last = Math.max(0, ...all('food.preparation_items').filter((p) => p.menu_id === menu.id && !p.deleted_at && p.scheduled_date === date).map((p) => Number(p.position)));
              write('food.preparation_items', 'insert', fresh(), { menu_id: menu.id, menu_item_id: item.id, recipe_id: recipe.id, scheduled_date: date, scheduled_time: time, text, position: last > 0 ? last + 1 : 0 });
              counts.inserted += 1;
            }
            else if (!step.manual && !step.done && (step.text !== text || step.scheduled_date !== date || step.scheduled_time !== time)) { write('food.preparation_items', 'update', step, { scheduled_date: date, scheduled_time: time, text }); counts.updated += 1; }
            else counts.kept += 1;
          }
          const gone = (p: FakeRow) => !graph.items.some((i) => i.id === p.menu_item_id && !i.deleted_at && graph.services.some((sv) => sv.id === i.service_id && !sv.deleted_at));
          for (const step of steps.filter((p) => !p.manual && !p.done && p.menu_item_id && (period ? gone(p) && inPeriod(p.scheduled_date as string) : !live.some((i) => i.id === p.menu_item_id)))) { write('food.preparation_items', 'delete', step); counts.deleted += 1; }
          if (!period) write('food.menus', 'update', menu, { preparation_generated_at: nowIso(), preparation_source_revisions: preparationSources(graph) });
          results.push({ op: 'call', procedure, result: counts });
          return;
        }
        if (args.expectedRevision !== menu.revision) {
          throw new Fault(409, 'VERSION_CONFLICT', 'La fila ha cambiado.', { table: 'food.menus', id: menu.id, expectedRevision: args.expectedRevision, currentRevision: menu.revision, current: { ...menu } });
        }
        const touch = (fields: Record<string, unknown>) => {
          Object.assign(menu, fields);
          menu.revision += 1; menu.updated_at = nowIso(); menu.updated_by = actorId;
          batchChanges.push(record('food.menus', 'update', menu, nextCursor, index + 1, body.requestId, actorId));
        };
        if (procedure === 'food.set_menu_status') {
          if (!MENU_TRANSITIONS.includes(`${menu.status}>${args.status}`)) throw new Fault(422, 'INVALID_TRANSITION', 'Transición no permitida.', { from: menu.status, to: args.status });
          touch({ status: args.status });
        } else if (procedure === 'food.acknowledge_event' || procedure === 'food.validate_menu') {
          const event = events.find((e) => e.event_id === menu.event_id);
          if (!event || args.event_revision !== event.event_revision) throw new Fault(422, 'EVENT_CHANGED', 'El evento ha cambiado.', { index, currentRevision: event?.event_revision ?? null });
          if (procedure === 'food.acknowledge_event') {
            if (menu.status === 'validado' || menu.status === 'cerrado') throw new Fault(422, 'MENU_LOCKED', 'El menú está validado.', { index });
            touch({ source_event_revision: args.event_revision, source_event_snapshot: args.event_snapshot });
          } else {
            const services = Array.from(stagedTable('food.menu_services').values()).filter((s) => s.menu_id === menu.id && !s.deleted_at).map((s) => s.id);
            if (!Array.from(stagedTable('food.menu_items').values()).some((i) => !i.deleted_at && services.includes(i.service_id as string))) {
              throw new Fault(422, 'MENU_EMPTY', 'El menú no tiene platos.', { index });
            }
            touch({ status: 'validado', validated_at: nowIso(), validated_by: actorId, validated_warnings: args.acknowledged ?? [],
              source_event_revision: args.event_revision, source_event_snapshot: args.event_snapshot });
          }
        } else {
          throw new Fault(422, 'INVALID_OPERATION', 'Procedimiento no permitido.', { index });
        }
        results.push({ op: 'call', procedure, result: { menu_id: menu.id, status: menu.status } });
        return;
      }
      if (!op.table || !tables[op.table] || !op.table.startsWith(`${scope}.`)) throw new Fault(422, 'INVALID_OPERATION', 'Tabla inválida.', { index });
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
      if (op.table === 'food.menu_services' || op.table === 'food.menu_items') {
        const current = store.get(op.id);
        const serviceId = op.table === 'food.menu_items' ? (fields.service_id ?? current?.service_id) : null;
        const menuId = op.table === 'food.menu_services' ? (fields.menu_id ?? current?.menu_id) : stagedTable('food.menu_services').get(serviceId as string)?.menu_id;
        const parent = stagedTable('food.menus').get(menuId as string);
        if (parent && (parent.status === 'validado' || parent.status === 'cerrado')) throw new Fault(422, 'MENU_LOCKED', 'El menú está validado.', { index, menu_id: parent.id, status: parent.status });
        // Salvaguarda de O3a, como food.guard_menu_item: un plato rápido por completar no entra en un retiro.
        const recipe = op.table === 'food.menu_items' && fields.recipe_id ? stagedTable('food.recipes').get(fields.recipe_id as string) : undefined;
        const lines = Array.from(stagedTable('food.recipe_ingredients').values());
        if (parent && parent.kind !== 'casa' && recipe?.quick && !(recipe.allergens_checked && lines.some((l) => l.recipe_id === recipe.id && !l.deleted_at))) {
          throw new Fault(422, 'QUICK_RECIPE_IN_RETREAT', 'Plato rápido por completar.', { index, recipe_id: recipe.id });
        }
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
      let path = url.pathname.slice('/api/v1/'.length);
      // El módulo Recursos va en /api/v1/resources/… con la misma sesión; cada uno ve solo sus tablas.
      const scope = path.startsWith('resources/') ? 'resources' : 'food';
      if (scope === 'resources') path = path.slice('resources/'.length);
      const inScope = (table: string) => table.startsWith(`${scope}.`);
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
      // Catálogo del lanzador (contrato §3.3): las apps a las que tiene acceso la cuenta.
      // Medición de uso (USO.md): aviso la primera vez y totales acumulados del día por dispositivo.
      if (path === 'usage/consent') {
        if (method === 'POST') consentedAt = nowIso();
        return json(res, 200, { consentedAt });
      }
      if (path === 'usage/batch' && method === 'POST') {
        const body = await readJson(req);
        for (const item of (body.items ?? []) as FakeUsageItem[]) usage.set(`${item.day}|${item.featureId}|${item.context}`, { ...item });
        return json(res, 200, { accepted: (body.items ?? []).length });
      }
      // «Sugerencias y QA» (FEEDBACK.md §5): lo justo para enviar un reporte y verlo en el centro.
      if (path === 'feedback' && method === 'POST') {
        const body = await readJson(req);
        const known = feedbackByRequest.get(String(body.requestId));
        if (known) return json(res, 200, { report: feedbackStore.get(known) });
        const report: FakeFeedbackReport = {
          id: String(body.id), code: `FB_${new Date().getFullYear()}_${String(feedbackStore.size + 1).padStart(4, '0')}`, originApp: 'food', subject: String(body.subject ?? 'application'),
          intent: String(body.intent ?? 'bug'), message: String(body.message ?? ''), node: body.node ?? null, status: 'open', display: 'open',
          supportersCount: 1, mine: true, createdAt: nowIso(), context: body.context ?? null, requestId: String(body.requestId),
        };
        feedbackStore.set(report.id, report);
        feedbackByRequest.set(report.requestId, report.id);
        return json(res, 200, { report });
      }
      if (path === 'feedback' && method === 'GET') {
        if (url.searchParams.get('review') === 'true') throw new Fault(403, 'FORBIDDEN', 'Sin acceso al revisor.');
        let items = Array.from(feedbackStore.values());
        if (url.searchParams.get('node')) items = items.filter((r) => r.node?.id === url.searchParams.get('node'));
        if (url.searchParams.get('status') === 'open') items = items.filter((r) => r.status === 'open');
        return json(res, 200, { items });
      }
      if (path === 'feedback/tree' && method === 'GET') {
        const byNode = new Map<string, { id: string; path: string[]; open: number; pendingVerify: number; verified: number; total: number }>();
        for (const r of feedbackStore.values()) {
          if (!r.node) continue;
          const entry = byNode.get(r.node.id) ?? { id: r.node.id, path: r.node.path, open: 0, pendingVerify: 0, verified: 0, total: 0 };
          entry.total += 1;
          if (r.status === 'open') entry.open += 1;
          byNode.set(r.node.id, entry);
        }
        return json(res, 200, { nodes: Array.from(byNode.values()) });
      }
      const oneReport = /^feedback\/([^/]+)$/.exec(path);
      if (oneReport && method === 'GET') {
        const report = Array.from(feedbackStore.values()).find((r) => r.id === oneReport[1] || r.code === oneReport[1]);
        if (!report) throw new Fault(404, 'NOT_FOUND', 'Reporte desconocido.');
        return json(res, 200, { report, attachments: [], tasks: [], agentBlock: `Reporte ${report.code}` });
      }
      // Aviso de avería a Tasks (API.md §6.1): una petición por máquina y día; sin regla en Tasks, «Por clasificar».
      const fault = /^equipment\/([0-9a-f-]{36})\/fault$/.exec(path);
      if (fault && method === 'POST') {
        const body = await readJson(req);
        const created = !faults.some((f) => f.id === fault[1]);
        faults.push({ id: fault[1]!, body });
        const taskId = randomUUID();
        // Tanda 27 (1104): la Edge anota el aviso, uno por máquina y día, para el recorrido («Avisado»).
        const notified_on = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid' }).format(new Date());
        const noticed = Array.from(data.get('food.equipment_notices')?.values() ?? []).some((n) => !n.deleted_at && n.equipment_id === fault[1] && n.notified_on === notified_on);
        if (created && !noticed) commit({ requestId: randomUUID(), operations: [{ op: 'insert', table: 'food.equipment_notices', id: randomUUID(), fields: { equipment_id: fault[1], notified_on, equipment_status: body.status, task_id: taskId } }] }, session.userId);
        return json(res, 200, { created, routed: 'pending', taskId, recorded: created });
      }
      if (path === 'apps' && method === 'GET') {
        return json(res, 200, {
          current: 'food',
          items: [
            { id: 'tasks', name: 'Tasks', domain: 'tasks.ikisai.com', aliasDomain: 'cuida.ikisai.com', kind: 'internal', description: 'Tareas y mantenimiento', role: 'editor' },
            { id: 'booking', name: 'Booking', domain: 'booking.ikisai.com', aliasDomain: 'acoge.ikisai.com', kind: 'internal', description: 'Reservas y eventos', role: 'reader' },
            { id: 'food', name: 'Food', domain: 'food.ikisai.com', aliasDomain: 'papeaki.ikisai.com', kind: 'internal', description: 'Cocina', role: 'owner' },
          ],
        });
      }
      if (path === 'auth/logout' && method === 'POST') {
        sessions.delete(req.headers.authorization!.slice('Bearer '.length));
        return json(res, 200, { loggedOut: true });
      }
      if (path === 'bootstrap') return json(res, 200, bootstrap(session, scope));
      if (path === 'me') return json(res, 200, { userId: session.userId, email: session.email, role: 'owner', scopes: null });
      if (path === 'read/invoices.food_stock_projection' && method === 'GET') {
        const kind = url.searchParams.get('where[target_kind]');
        const rows = (options.purchases ?? []).filter((r) => !kind || r.target_kind === kind);
        return json(res, 200, { name: 'invoices.food_stock_projection', rows, total: rows.length, limit: 2000, offset: 0 });
      }
      if (path === 'events' && method === 'GET') {
        return json(res, 200, { events: [...events].sort((a, b) => a.start_date.localeCompare(b.start_date)), serverTime: nowIso() });
      }
      if (path.startsWith('events/') && method === 'GET') {
        const event = events.find((e) => e.event_id === path.slice('events/'.length));
        if (!event) throw new Fault(404, 'NOT_FOUND', 'No se encontró el evento.');
        return json(res, 200, { event });
      }
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
        const list = requested.length ? requested : Object.keys(tables).filter(inScope);
        const includeDeleted = ['1', 'true'].includes(url.searchParams.get('includeDeleted') ?? '');
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const out = list.map((table) => {
          if (!tables[table] || !inScope(table)) throw new Fault(403, 'FORBIDDEN', 'Tabla no registrada.', { table });
          const all = Array.from(data.get(table)!.values()).filter((r) => includeDeleted || !r.deleted_at);
          return { table, rows: all.slice(offset, offset + limit), total: all.length };
        });
        return json(res, 200, { cursor, tables: out });
      }
      if (path === 'changes') {
        const after = Number(url.searchParams.get('after') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 500);
        const pending = changes.filter((c) => c.cursor > after && inScope(c.table));
        const items = pending.slice(0, limit);
        const hasMore = pending.length > limit;
        // Sin más cambios de este ámbito, el cursor salta al último (los del otro ámbito no le tocan).
        const last = hasMore ? items[items.length - 1]!.cursor : Math.max(after, cursor);
        return json(res, 200, { items, cursor: last, latest: cursor, hasMore });
      }
      if (path === 'commands' && method === 'POST') return json(res, 200, commit(await readJson(req), session.userId, scope));
      // Sugerencias del núcleo (contrato §3.10), lo justo para la cola de Food: listar, ver, aprobar y descartar.
      if (path === 'suggestions' && method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'mine';
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const reviewer = (session.role ?? 'owner') !== 'reader';
        if (scope === 'all' && !reviewer) throw new Fault(403, 'FORBIDDEN', 'Solo editor u owner.');
        const items = suggestionStore.filter((x) => (scope === 'pending' || scope === 'vote' ? x.status === 'pending' : scope === 'all' ? x.status !== 'withdrawn' : false))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
          // `scope=vote` (contrato §3.11, #608): quien no es editor ni owner no ve quién propone.
          .map((x) => (scope === 'vote' && !reviewer ? { ...x, author: null, anonymous: true } : x));
        return json(res, 200, { items, pendingCount: scope === 'mine' ? null : suggestionStore.filter((x) => x.status === 'pending').length });
      }
      // Votos de los platos sugeridos (tanda 27, `food.vote_suggestion`): el propio, crear, cambiar o quitar.
      if (path === 'suggestion-votes' && method === 'POST') {
        const body = await readJson(req);
        const vote = body.vote === null || body.vote === undefined ? null : String(body.vote);
        if (vote !== null && vote !== 'keep' && vote !== 'drop') throw new Fault(422, 'INVALID_OPERATION', 'Voto inválido.', { argument: 'vote' });
        const table = 'food.suggestion_votes';
        const mine = Array.from(data.get(table)?.values() ?? []).find((r) => !r.deleted_at && r.suggestion_id === body.suggestionId && r.voter_id === session.userId);
        const operations = !mine
          ? (vote ? [{ op: 'insert', table, id: randomUUID(), fields: { suggestion_id: body.suggestionId, voter_id: session.userId, vote } }] : [])
          : vote === null ? [{ op: 'delete', table, id: mine.id, expectedRevision: mine.revision }]
          : mine.vote !== vote ? [{ op: 'update', table, id: mine.id, expectedRevision: mine.revision, fields: { vote } }] : [];
        const applied = operations.length ? commit({ requestId: body.requestId ?? randomUUID(), operations }, session.userId) as { cursor: number } : { cursor };
        return json(res, 200, { cursor: applied.cursor, suggestionId: body.suggestionId, vote });
      }
      const decide = /^suggestions\/([0-9a-f-]{36})\/(approve|reject|preview)$/.exec(path);
      if (decide && method === 'POST') {
        const item = suggestionStore.find((x) => x.id === decide[1]);
        if (!item) throw new Fault(404, 'NOT_FOUND', 'Sugerencia no encontrada.');
        const body = await readJson(req);
        if (decide[2] === 'preview') return json(res, 200, { changes: [] });
        if (item.status !== 'pending') throw new Fault(409, 'SUGGESTION_UNAVAILABLE', 'Ya no está pendiente.');
        const decided = { comment: typeof body.comment === 'string' && body.comment.trim() ? body.comment.trim() : null, decidedBy: { id: session.userId, name: session.displayName }, decidedAt: nowIso(), updatedAt: nowIso() };
        if (decide[2] === 'approve') {
          // Con `operations`, el lote corregido de quien aprueba (tanda 27: «Usar receta parecida»).
          const operations = Array.isArray(body.operations) ? body.operations : item.operations;
          const applied = commit({ requestId: `suggestion:${item.id}`, operations }, session.userId) as { cursor: number; results: unknown };
          Object.assign(item, decided, { status: 'approved', appliedCursor: applied.cursor, result: applied.results });
        } else Object.assign(item, decided, { status: 'rejected' });
        return json(res, 200, item);
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
    faults: () => faults.map((f) => ({ ...f, body: { ...f.body } })),
    feedbackReports: () => Array.from(feedbackStore.values()).map((r) => ({ ...r })),
    setUsageConsent: (consented) => { consentedAt = consented ? new Date().toISOString() : null; },
    seedSuggestion({ name, date, service, author = 'Marta' }) {
      const id = randomUUID();
      suggestionStore.push({
        id, app: 'food', kind: 'plato_casa', label: 'Plato para el menú de casa', summary: name, detail: null,
        operations: [{ op: 'call', procedure: 'food.house_dish_from_suggestion', args: { name, date, service } }],
        status: 'pending', comment: null, author: { id: randomUUID(), name: author }, decidedBy: null, decidedAt: null, appliedCursor: null, result: null,
        createdAt: new Date(Date.now() - (suggestionStore.length + 1) * 3_600_000).toISOString(), updatedAt: nowIso(),
      });
      return id;
    },
    suggestions: () => suggestionStore.map((x) => ({ ...x })),
    usageItems: () => Array.from(usage.values()).map((u) => ({ ...u })),
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
    seed(table, fields) {
      const allowed = tables[table];
      if (!allowed) throw new Error(`tabla ${table} no registrada`);
      const now = nowIso();
      const row: FakeRow = { id: (fields.id as string | undefined) ?? randomUUID(), revision: 1, created_at: now, updated_at: now, updated_by: null, deleted_at: null };
      for (const column of allowed) row[column] = fields[column] ?? DEFAULTS[table]?.[column] ?? null;
      data.get(table)!.set(row.id, row);
      return row;
    },
    updateEvent(eventId, fields) {
      const event = events.find((e) => e.event_id === eventId);
      if (!event) throw new Error(`evento ${eventId} no existe`);
      Object.assign(event, fields);
      event.event_revision += 1;
      return event;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
