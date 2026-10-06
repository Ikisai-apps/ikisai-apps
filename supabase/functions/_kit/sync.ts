/** Rutas del núcleo de sincronización: bootstrap, snapshot, changes, commands, history, undo. */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, stable, type Supabase } from './supabase.ts';
import type { Identity } from './auth.ts';

export type Role = 'reader' | 'editor' | 'owner';

export interface Membership {
  role: Role;
  scopes: unknown;
  revision: number;
}

export interface Bootstrap {
  app: string;
  cursor: number;
  serverTime: string;
  membership: Membership;
  profile: { userId: string; displayName: string; kind: 'human' | 'agent' };
  tables: Array<{ table: string; writableColumns: string[]; readable: boolean; writable: boolean }>;
}

export interface RequestContext {
  app: string;
  user: Identity;
  /** Bearer de la sesión del usuario, para llamar a la API de otra app (por ejemplo Tareas) en su nombre. */
  token: string;
  membership: Membership;
  bootstrap: Bootstrap;
}

/** Hooks que cada app puede declarar. */
export interface AppHooks {
  /** Filtra filas por ámbitos del usuario. Si no se define, la visibilidad es la membresía. */
  visible?: (table: string, row: Record<string, unknown>, ctx: RequestContext) => boolean;
  /** Validación de dominio antes de core.commit (tipos, reglas de negocio). Puede lanzar Fault. */
  beforeCommit?: (operations: Operation[], ctx: RequestContext) => Promise<void> | void;
  /** Tras un commit correcto (por ejemplo, encolar una sincronización externa). */
  afterCommit?: (result: CommitResult, ctx: RequestContext) => Promise<void> | void;
}

export interface Operation {
  op: 'insert' | 'update' | 'delete' | 'restore' | 'call';
  table?: string;
  id?: string;
  expectedRevision?: number;
  fields?: Record<string, unknown>;
  procedure?: string;
  args?: Record<string, unknown>;
}

export interface CommitResult {
  cursor: number;
  requestId: string;
  replayed?: boolean;
  results: unknown[];
  changes: Array<{ cursor: number; seq: number; table: string; id: string | null; op: string; revision: number | null; after: Record<string, unknown> | null }>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
const TABLE = /^[a-z_]+\.[a-z0-9_]+$/;

export function integer(value: string | null, fallback: number, name = 'cursor'): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) fail(422, 'INVALID_FILTER', `Parámetro ${name} inválido.`);
  return Number(value);
}

export function createSync(supabase: Supabase, app: string, hooks: AppHooks = {}) {
  async function context(user: Identity, token: string): Promise<RequestContext> {
    const bootstrap = await supabase.rpc<Bootstrap>('core_bootstrap', { p_app: app, p_user: user.id });
    return { app, user, token, membership: bootstrap.membership, bootstrap };
  }

  /** Lectura registrada en core.allowed_reads: función de la propia app o proyección publicada por otra. */
  async function read(ctx: RequestContext, name: string, args: unknown) {
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(name)) fail(422, 'INVALID_OPERATION', 'Nombre de lectura inválido.');
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) fail(422, 'INVALID_OPERATION', 'Los argumentos deben ser un objeto.');
    return supabase.rpc('core_read', { p_app: app, p_actor: ctx.user.id, p_name: name, p_args: args ?? {} });
  }

  /** Acción registrada (kind 'action'): procedimiento volátil fuera de core.commit. `actor` null = sistema (worker). */
  async function invoke(actor: string | null, name: string, args: unknown) {
    if (!/^[a-z_]+\.[a-z0-9_]+$/.test(name)) fail(422, 'INVALID_OPERATION', 'Nombre de acción inválido.');
    if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) fail(422, 'INVALID_OPERATION', 'Los argumentos deben ser un objeto.');
    return supabase.rpc('core_invoke', { p_app: app, p_actor: actor, p_name: name, p_args: args ?? {} });
  }

  /** Alta de una cuenta por el owner: crea el usuario en Auth con contraseña temporal y le da pertenencia. */
  async function invite(ctx: RequestContext, body: any) {
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) fail(422, 'INVALID_OPERATION', 'Correo inválido.');
    if (!['reader', 'editor', 'owner'].includes(body.role)) fail(422, 'INVALID_ROLE', messageFor('INVALID_ROLE'));
    const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
    const temporaryPassword = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ '+': 'a', '/': 'b', '=': '' })[c] ?? '');
    let userId: string;
    try {
      const created = await supabase.remote('/auth/v1/admin/users', { service: true, method: 'POST', body: { email, password: temporaryPassword, email_confirm: true } });
      userId = created.id;
    } catch (error: any) {
      if (error?.code !== 'USER_EXISTS') throw error;
      const found = await lookupUser(email);
      if (!found) fail(409, 'USER_EXISTS', 'Ya existe una cuenta con ese correo; añádela por su identificador.');
      userId = found;
    }
    const membership = await supabase.rpc('core_set_membership', {
      p_app: app, p_actor: ctx.user.id, p_user: userId, p_role: body.role, p_scopes: body.scopes ?? null, p_display_name: typeof body.displayName === 'string' ? body.displayName : null,
    });
    return { userId, email, membership, temporaryPassword: typeof (membership as any)?.user_id === 'string' && (membership as any).revision === 1 ? temporaryPassword : null };
  }

  async function lookupUser(email: string): Promise<string | null> {
    const page = await supabase.remote('/auth/v1/admin/users?page=1&per_page=1000', { service: true });
    const users: any[] = Array.isArray(page?.users) ? page.users : [];
    return users.find((u) => typeof u?.email === 'string' && u.email.toLowerCase() === email)?.id ?? null;
  }

  function visibleRows<T extends Record<string, unknown>>(table: string, rows: T[], ctx: RequestContext): T[] {
    if (!hooks.visible) return rows;
    return rows.filter((row) => hooks.visible!(table, row, ctx));
  }

  async function snapshot(ctx: RequestContext, params: URLSearchParams) {
    const requested = (params.get('tables') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
    const readable = ctx.bootstrap.tables.filter((t) => t.readable).map((t) => t.table);
    const tables = requested.length ? requested : readable;
    for (const table of tables) {
      if (!TABLE.test(table) || !readable.includes(table)) fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'), { table });
    }
    const includeDeleted = ['1', 'true'].includes(params.get('includeDeleted') ?? '');
    const limit = Math.min(2000, Math.max(1, integer(params.get('limit'), 500, 'limit')));
    const offset = integer(params.get('offset'), 0, 'offset');
    const out = [] as Array<{ table: string; rows: Record<string, unknown>[]; total: number }>;
    for (const table of tables) {
      const result = await supabase.rpc<{ table: string; rows: Record<string, unknown>[]; total: number }>('core_snapshot_table', {
        p_app: app, p_role: ctx.membership.role, p_table: table, p_include_deleted: includeDeleted, p_limit: limit, p_offset: offset,
      });
      out.push({ table, rows: visibleRows(table, result.rows, ctx), total: result.total });
    }
    return { cursor: ctx.bootstrap.cursor, tables: out };
  }

  async function changes(ctx: RequestContext, params: URLSearchParams) {
    const after = integer(params.get('after'), 0, 'after');
    const limit = Math.min(2000, Math.max(1, integer(params.get('limit'), 500, 'limit')));
    const result = await supabase.rpc<{ items: any[]; cursor: number; latest: number; hasMore: boolean }>('core_changes_since', {
      p_app: app, p_role: ctx.membership.role, p_after: after, p_limit: limit,
    });
    const items = hooks.visible
      ? result.items.filter((c) => c.after === null || hooks.visible!(c.table, c.after, ctx))
      : result.items;
    return { ...result, items };
  }

  function validateOperations(operations: unknown): Operation[] {
    if (!Array.isArray(operations)) fail(422, 'INVALID_OPERATION', 'operations debe ser una lista.');
    if (operations.length > 500) fail(422, 'INVALID_OPERATION', 'Máximo 500 operaciones por lote.');
    return operations.map((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(422, 'INVALID_OPERATION', 'Operación inválida.', { index });
      const op = raw as Operation;
      if (op.op === 'call') {
        if (typeof op.procedure !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(op.procedure)) fail(422, 'INVALID_OPERATION', 'Procedimiento inválido.', { index });
        if (op.args !== undefined && (typeof op.args !== 'object' || op.args === null || Array.isArray(op.args))) fail(422, 'INVALID_OPERATION', 'args debe ser un objeto.', { index });
        return { op: 'call', procedure: op.procedure, args: op.args ?? {} };
      }
      if (!['insert', 'update', 'delete', 'restore'].includes(op.op)) fail(422, 'INVALID_OPERATION', 'Operación desconocida.', { index, op: op.op });
      if (typeof op.table !== 'string' || !TABLE.test(op.table)) fail(422, 'INVALID_OPERATION', 'Tabla inválida.', { index });
      if (typeof op.id !== 'string' || !UUID.test(op.id)) fail(422, 'INVALID_OPERATION', 'El id debe ser un uuid.', { index });
      if (op.op !== 'insert' && !Number.isSafeInteger(op.expectedRevision)) fail(422, 'INVALID_OPERATION', 'expectedRevision es obligatorio.', { index });
      if (op.fields !== undefined && (typeof op.fields !== 'object' || op.fields === null || Array.isArray(op.fields))) fail(422, 'INVALID_FIELDS', 'fields debe ser un objeto.', { index });
      if ((op.op === 'delete' || op.op === 'restore') && op.fields && Object.keys(op.fields).length) fail(422, 'INVALID_FIELDS', 'delete/restore no admiten fields.', { index });
      const clean: Operation = { op: op.op, table: op.table, id: op.id.toLowerCase() };
      if (op.op !== 'insert') clean.expectedRevision = op.expectedRevision;
      if (op.op === 'insert' || op.op === 'update') clean.fields = op.fields ?? {};
      return clean;
    });
  }

  async function commit(ctx: RequestContext, body: any, options: { skipHooks?: boolean } = {}): Promise<CommitResult> {
    if (!body || typeof body !== 'object') fail(400, 'INVALID_JSON', messageFor('INVALID_JSON'));
    if (typeof body.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    const operations = validateOperations(body.operations);
    const expectedCursor = body.expectedCursor === undefined || body.expectedCursor === null ? null : body.expectedCursor;
    if (expectedCursor !== null && !Number.isSafeInteger(expectedCursor)) fail(422, 'INVALID_OPERATION', 'expectedCursor inválido.');
    if (!options.skipHooks && hooks.beforeCommit) await hooks.beforeCommit(operations, ctx);
    const digest = await sha256Hex(stable(operations));
    const result = await supabase.rpc<CommitResult>('core_commit', {
      p_app: app, p_actor: ctx.user.id, p_request_id: body.requestId, p_digest: digest, p_expected_cursor: expectedCursor, p_operations: operations,
    });
    if (!result.replayed && hooks.afterCommit) await hooks.afterCommit(result, ctx);
    return result;
  }

  async function history(ctx: RequestContext, params: URLSearchParams) {
    const before = params.get('before') === null ? null : integer(params.get('before'), 0, 'before');
    const limit = Math.min(200, Math.max(1, integer(params.get('limit'), 50, 'limit')));
    const result = await supabase.rpc<{ items: any[]; nextBefore: number | null; hasMore: boolean }>('core_history', {
      p_app: app, p_role: ctx.membership.role, p_before: before, p_limit: limit,
    });
    if (hooks.visible) {
      for (const item of result.items) {
        item.changes = item.changes.filter((c: any) => c.op === 'call' || hooks.visible!(c.table, c.after ?? c.before ?? {}, ctx));
      }
      result.items = result.items.filter((item) => item.changes.length);
    }
    return result;
  }

  async function undoPlan(ctx: RequestContext, cursor: number) {
    if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    const plan = await supabase.rpc<{ cursor: number; operations: Operation[] }>('core_undo_plan', { p_app: app, p_cursor: cursor });
    return { ...plan, planHash: await sha256Hex(stable(plan.operations)) };
  }

  async function undo(ctx: RequestContext, cursor: number, body: any): Promise<CommitResult> {
    if (!body || typeof body.requestId !== 'string' || typeof body.planHash !== 'string') fail(422, 'INVALID_OPERATION', 'requestId y planHash son obligatorios.');
    const plan = await undoPlan(ctx, cursor);
    if (plan.planHash !== body.planHash) fail(409, 'UNDO_PLAN_CHANGED', messageFor('UNDO_PLAN_CHANGED'), { planHash: plan.planHash });
    return commit(ctx, { requestId: body.requestId, operations: plan.operations }, { skipHooks: true });
  }

  async function purgeDeleted(ctx: RequestContext, body: any) {
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (typeof body?.requestId !== 'string' || !REQUEST_ID.test(body.requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
    const tables = Array.isArray(body.tables) && body.tables.length ? body.tables : ctx.bootstrap.tables.map((t) => t.table);
    for (const table of tables) if (typeof table !== 'string' || !TABLE.test(table)) fail(422, 'INVALID_OPERATION', 'Tabla inválida.');
    return supabase.rpc('core_purge_deleted', { p_app: app, p_actor: ctx.user.id, p_request_id: body.requestId, p_tables: tables });
  }

  async function members(ctx: RequestContext) {
    return supabase.rpc('core_list_memberships', { p_app: app, p_actor: ctx.user.id });
  }

  async function setMember(ctx: RequestContext, body: any) {
    if (ctx.membership.role !== 'owner') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (typeof body?.userId !== 'string' || !UUID.test(body.userId)) fail(422, 'INVALID_OPERATION', 'userId inválido.');
    if (!['reader', 'editor', 'owner'].includes(body.role)) fail(422, 'INVALID_ROLE', messageFor('INVALID_ROLE'));
    return supabase.rpc('core_set_membership', {
      p_app: app, p_actor: ctx.user.id, p_user: body.userId, p_role: body.role, p_scopes: body.scopes ?? null, p_display_name: typeof body.displayName === 'string' ? body.displayName : null,
    });
  }

  return { context, snapshot, changes, commit, history, undoPlan, undo, purgeDeleted, members, setMember, validateOperations, read, invite, invoke };
}
